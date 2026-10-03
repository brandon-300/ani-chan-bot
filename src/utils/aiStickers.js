const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { MessageMedia } = require('whatsapp-web.js');
const gemini = require('./gemini');
const cloudinary = require('./cloudinary');
const AiSticker = require('../models/AiSticker');
const AiStickerMessage = require('../models/AiStickerMessage');
const { safeGetChat, safeGetContact, isOwner } = require('./helpers');
const {
  AI_STICKERS_ENABLED,
  AI_STICKER_AUTO_ANALYZE,
  AI_STICKER_IMPORT_TIMEOUT_MINUTES,
  AI_STICKER_MAX_BYTES,
  AI_STICKER_DOWNLOAD_TIMEOUT_MS,
  BOT_NAME,
  AI_STICKER_ANALYSIS_VERSION,
  AI_STICKER_MATCH_THRESHOLD,
  AI_STICKER_MIN_PERSONA_FIT,
  AI_STICKER_ANALYSIS_DELAY_MS,
  AI_STICKER_QUOTA_COOLDOWN_MS,
  AI_STICKER_QUOTA_MAX_COOLDOWN_MS,
  AI_STICKER_CATALOGUE_MAX,
  AI_STICKER_RECENT_EXCLUDE,
  AI_STICKER_FIT_BATCH,
  AI_STICKER_VISION_BATCH,
} = require('./config');
const { getActivePersonaSafe, listPersonaIds, loadPersona } = require('./persona');
const logger = require('./logger');
const geminiGate = require('./geminiGate');
const aiMessageLedger = require('./aiMessageLedger');

const ALLOWED_REACTIONS = new Set([
  'amused', 'happy', 'laughing', 'love', 'excited', 'sad', 'angry', 'confused',
  'surprised', 'embarrassed', 'shy', 'awkward', 'sleepy', 'annoyed', 'teasing',
  'disbelief', 'worried', 'supportive', 'neutral',
]);
const SHARED_LIBRARY_KEY = 'shared';
const UNKNOWN_ANIME_ID = 'unknown-anime';
const RECENT_ANIME_WINDOW = 5;
const MAX_TRACKED_CHATS = 500;
const MAX_ANIME_REPEAT_PENALTY = 4;

// The only durable sticker state is Cloudinary + MongoDB. This cache contains
// metadata only and is rebuilt from Mongo after connection/startup; image bytes
// are fetched into memory only when Gemini analyzes or WhatsApp sends a sticker.
let stickerModel = AiSticker;
let cloudinaryStorage = cloudinary;
let mongoIsReady = () => mongoose.connection.readyState === 1;
let modelInitPromise = null;
const personaIndexes = new Map();
const indexLoaders = new Map();
const importsInFlight = new Map();
const importSessions = new Map();
const recentByChat = new Map();
const recentAnimeByChat = new Map();
const recentHashesByChat = new Map();
const analysisQueue = [];
const queuedAnalysis = new Set();
let analysisBusy = false;
// Quota pause: when Gemini says the quota is used up, the worker stops, puts the
// current task back at the front of the queue and arms this timer to resume.
let quotaResumeTimer = null;
let quotaResumeAt = 0;
let quotaStreak = 0;

// While the queue has work — running, sleeping between tasks, or paused waiting
// for quota — Gemini belongs to it. utils/geminiGate.js reads this to make
// Gemini-backed commands reply "unavailable" instead of competing for quota.
function analysisReservesGemini() {
  return analysisBusy || analysisQueue.length > 0 || quotaResumeTimer !== null;
}
geminiGate.setReservationProvider(analysisReservesGemini);

function makeError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

async function ensureDatabaseReady() {
  if (!mongoIsReady()) {
    throw makeError('MongoDB is not connected yet. Wait for the database connection and try again.', 'MONGO_NOT_READY');
  }
  if (!modelInitPromise) {
    const initializeModel = typeof stickerModel.createIndexes === 'function'
      ? stickerModel.createIndexes()
      : typeof stickerModel.init === 'function'
        ? stickerModel.init()
        : Promise.resolve();
    modelInitPromise = Promise.resolve(initializeModel).catch(err => {
      modelInitPromise = null;
      throw err;
    });
  }
  if (modelInitPromise) await modelInitPromise;
}

async function executeQuery(query, { lean = true } = {}) {
  let current = query;
  if (lean && current && typeof current.lean === 'function') current = current.lean();
  if (current && typeof current.exec === 'function') return current.exec();
  return current;
}

function plainSticker(doc) {
  if (!doc) return null;
  const value = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    ...value,
    personaAnalyses: Array.isArray(value.personaAnalyses) ? value.personaAnalyses.map(analysis => ({
      ...analysis,
      emotions: Array.isArray(analysis.emotions) ? analysis.emotions : [],
      moods: Array.isArray(analysis.moods) ? analysis.moods : [],
      uses: Array.isArray(analysis.uses) ? analysis.uses : [],
      reactions: Array.isArray(analysis.reactions) ? analysis.reactions : [],
    })) : [],
    emotions: Array.isArray(value.emotions) ? value.emotions : [],
    moods: Array.isArray(value.moods) ? value.moods : [],
    uses: Array.isArray(value.uses) ? value.uses : [],
    reactions: Array.isArray(value.reactions) ? value.reactions : [],
  };
}

// A fingerprint of the character DEFINITION only (not the reply-style, emoji or
// voice prompts). It is stored with each analysis for information; nothing
// compares it any more, because editing a persona file must never cause the
// whole library to be re-analysed behind the owner's back.
function personaVersion(persona) {
  if (!persona) return '';
  return crypto.createHash('sha256')
    .update([persona.id, persona.personality].join('\n'))
    .digest('hex')
    .slice(0, 16);
}

function legacyAnalysis(record) {
  if (!record?.personaId || record.personaId === SHARED_LIBRARY_KEY) return null;
  return {
    personaId: record.personaId,
    analysisVersion: Number(record.analysisVersion || 1),
    personaVersion: record.personaVersion || '',
    analysisStatus: record.analysisStatus || 'pending',
    emotions: record.emotions || [],
    moods: record.moods || [],
    uses: record.uses || [],
    reactions: record.reactions || [],
    intensity: record.intensity || 'medium',
    personaFit: Number(record.personaFit || 0),
    notes: record.notes || '',
    analysisError: record.analysisError || null,
    analyzedAt: record.analyzedAt || null,
  };
}

function getPersonaAnalysis(record, personaId) {
  const analyses = Array.isArray(record?.personaAnalyses) ? record.personaAnalyses : [];
  const embedded = analyses.find(analysis => analysis.personaId === personaId);
  if (embedded) return embedded;
  const legacy = legacyAnalysis(record);
  return legacy?.personaId === personaId ? legacy : null;
}

// An analysis is usable when it exists and produced labels. Nothing else makes
// it "stale": not a changed persona prompt, not a new analysis version. Doing
// the analysis again is the owner's decision (.stickeranalyze redo).
function isUsableAnalysis(analysis) {
  return Boolean(analysis) && analysis.analysisStatus === 'classified';
}

function personaIdsNeedingAnalysis(record, personaIds) {
  return personaIds.filter(personaId => !isUsableAnalysis(getPersonaAnalysis(record, personaId)));
}


function withMergedAnalyses(records) {
  const byHash = new Map();
  for (const record of records.map(plainSticker).filter(Boolean)) {
    const ownLegacy = legacyAnalysis(record);
    if (ownLegacy && !record.personaAnalyses.some(analysis => analysis.personaId === ownLegacy.personaId)) {
      record.personaAnalyses.push(ownLegacy);
    }
    const previous = byHash.get(record.hash);
    if (!previous) {
      byHash.set(record.hash, record);
      continue;
    }
    const analyses = new Map();
    for (const source of [previous, record]) {
      for (const analysis of (source.personaAnalyses || []).concat(legacyAnalysis(source) || [])) {
        if (analysis?.personaId && (!analyses.has(analysis.personaId) || analysis.analysisStatus === 'classified')) {
          analyses.set(analysis.personaId, analysis);
        }
      }
    }
    previous.personaAnalyses = [...analyses.values()];
    if ((!previous.cloudinaryUrl || !previous.cloudinaryPublicId) && record.cloudinaryUrl && record.cloudinaryPublicId) {
      Object.assign(previous, record);
      previous.personaAnalyses = [...analyses.values()];
    }
  }
  return [...byHash.values()];
}

function stickerQuality(record) {
  const hasCloudinaryAsset = record.cloudinaryUrl && record.cloudinaryPublicId ? 1000 : 0;
  const classified = (record.personaAnalyses || []).filter(a => a.analysisStatus === 'classified').length;
  const tags = (record.personaAnalyses || []).reduce((sum, a) => sum + ['emotions', 'moods', 'uses', 'reactions'].reduce((n, key) => n + (a[key]?.length || 0), 0), 0);
  return hasCloudinaryAsset + classified * 100 + tags;
}

function setCachedSticker(_sourcePersonaId, doc) {
  const record = plainSticker(doc);
  if (!record) return;
  const current = personaIndexes.get(SHARED_LIBRARY_KEY) || [];
  const index = current.findIndex(entry => entry.hash === record.hash);
  if (index >= 0) {
    const previous = current[index];
    const sameRecord = String(previous._id || '') === String(record._id || '');
    if (sameRecord || stickerQuality(record) >= stickerQuality(previous)) current[index] = record;
  }
  else current.push(record);
  personaIndexes.set(SHARED_LIBRARY_KEY, current);
}

async function loadSharedStickers({ force = false } = {}) {
  if (!force && personaIndexes.has(SHARED_LIBRARY_KEY)) return personaIndexes.get(SHARED_LIBRARY_KEY);
  if (indexLoaders.has(SHARED_LIBRARY_KEY)) return indexLoaders.get(SHARED_LIBRARY_KEY);

  const loading = (async () => {
    await ensureDatabaseReady();
    const rows = await executeQuery(stickerModel.find({}));
    const records = withMergedAnalyses(Array.isArray(rows) ? rows : []);
    personaIndexes.set(SHARED_LIBRARY_KEY, records);
    return records;
  })();
  indexLoaders.set(SHARED_LIBRARY_KEY, loading);
  try {
    return await loading;
  } finally {
    indexLoaders.delete(SHARED_LIBRARY_KEY);
  }
}

function analysisKey(personaId, hash) {
  return `${personaId}:${hash}`;
}

function enqueueAnalysis(personaId, hash) {
  const key = analysisKey(personaId, hash);
  if (queuedAnalysis.has(key)) return;
  queuedAnalysis.add(key);
  analysisQueue.push({ personaId, hash });
  logger.write('DEBUG', 'background.ai_sticker_analysis.queued', { personaId, hash, queueLength: analysisQueue.length });
  setImmediate(runAnalysisQueue);
}

// Gemini reports an exhausted quota (or a rate limit) as HTTP 429; the message
// text is the fallback for wrappers that lose the status code.
function isQuotaError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  return /\b429\b|quota|resource[_ ]exhausted|rate[ -]?limit/i.test(String(err.message || err));
}

// Gemini often says "Please retry in 23.4s" for per-minute limits. Daily-quota
// messages have no plain-seconds hint, so this returns null for them.
function parseRetryDelayMs(message) {
  const match = /retry in (\d+(?:\.\d+)?)s\b/i.exec(String(message || ''));
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

function quotaCooldownMs(retryHintMs) {
  const maxMs = Math.max(AI_STICKER_QUOTA_COOLDOWN_MS, AI_STICKER_QUOTA_MAX_COOLDOWN_MS);
  if (retryHintMs) return Math.min(maxMs, Math.max(15000, retryHintMs + 5000));
  const escalated = AI_STICKER_QUOTA_COOLDOWN_MS * (2 ** Math.max(0, quotaStreak - 1));
  return Math.min(maxMs, escalated);
}

function pauseForQuota(retryHintMs, remaining) {
  quotaStreak += 1;
  const cooldownMs = quotaCooldownMs(retryHintMs);
  quotaResumeAt = Date.now() + cooldownMs;
  if (quotaResumeTimer) clearTimeout(quotaResumeTimer);
  quotaResumeTimer = setTimeout(() => {
    quotaResumeTimer = null;
    quotaResumeAt = 0;
    logger.write('INFO', 'background.ai_sticker_analysis.quota_resume', { queued: analysisQueue.length });
    runAnalysisQueue();
  }, cooldownMs);
  // Never keep the process alive just for this timer.
  if (typeof quotaResumeTimer.unref === 'function') quotaResumeTimer.unref();
  logger.write('WARN', 'background.ai_sticker_analysis.quota_pause', {
    cooldownMs,
    resumeAt: new Date(quotaResumeAt),
    streak: quotaStreak,
    remaining,
  });
}

// Takes the next group of queued tasks: up to AI_STICKER_FIT_BATCH different
// stickers, with every persona that is queued for each of them.
function takeBatch() {
  const batch = [];
  const hashes = new Set();
  while (analysisQueue.length) {
    const next = analysisQueue[0];
    if (!hashes.has(next.hash) && hashes.size >= AI_STICKER_FIT_BATCH) break;
    hashes.add(next.hash);
    batch.push(analysisQueue.shift());
  }
  return batch;
}

async function runAnalysisQueue() {
  if (analysisBusy || quotaResumeTimer) return;
  analysisBusy = true;
  logger.write('INFO', 'background.ai_sticker_analysis.worker.start', { queued: analysisQueue.length });
  try {
    while (analysisQueue.length) {
      const batch = takeBatch();
      const stickers = new Set(batch.map(task => task.hash)).size;
      const operation = logger.start('background.ai_sticker_analysis.batch', { stickers, tasks: batch.length, remaining: analysisQueue.length });
      let requeued = false;
      let retryHintMs = null;
      try {
        const result = await analyzeBatch(batch);
        if (result.quota) {
          // Not the stickers' fault: put the whole batch back at the front and
          // wait for the quota instead of marking anything failed.
          operation.finish('failed', { error: new Error(result.error) });
          analysisQueue.unshift(...batch);
          requeued = true;
          retryHintMs = result.retryHintMs || null;
        } else {
          quotaStreak = 0;
          operation.finish(result.failed ? 'partial' : 'success', { analysed: result.ok, failed: result.failed, requests: result.requests, stickers });
        }
      } catch (err) {
        operation.finish('failed', { error: err });
        logger.error('background.ai_sticker_analysis.batch.unhandled', err, { tasks: batch.length });
      } finally {
        if (!requeued) for (const task of batch) queuedAnalysis.delete(analysisKey(task.personaId, task.hash));
      }
      if (requeued) {
        pauseForQuota(retryHintMs, analysisQueue.length);
        break;
      }
      if (analysisQueue.length && AI_STICKER_ANALYSIS_DELAY_MS > 0) {
        logger.write('INFO', 'background.ai_sticker_analysis.delay', { delayMs: AI_STICKER_ANALYSIS_DELAY_MS, remaining: analysisQueue.length });
        await new Promise(resolve => setTimeout(resolve, AI_STICKER_ANALYSIS_DELAY_MS));
      }
    }
  } finally {
    analysisBusy = false;
    logger.write('INFO', 'background.ai_sticker_analysis.worker.idle', { queued: analysisQueue.length });
    if (analysisQueue.length && !quotaResumeTimer) setImmediate(runAnalysisQueue);
  }
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, '-').slice(0, 32);
  return label && /^[a-z0-9][a-z0-9-]*$/.test(label) ? label : null;
}

function normalizeLabelList(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeLabel).filter(Boolean))].slice(0, limit);
}

function normalizeShortNote(value) {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    : '';
}

function parseClassification(rawText) {
  const text = String(rawText || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Gemini returned no JSON object for sticker classification.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const reactions = normalizeLabelList(parsed.reactions, 8).filter(tag => ALLOWED_REACTIONS.has(tag));
  const intensity = ['low', 'medium', 'high'].includes(String(parsed.intensity || '').toLowerCase())
    ? String(parsed.intensity).toLowerCase()
    : 'medium';
  return {
    emotions: normalizeLabelList(parsed.emotions),
    moods: normalizeLabelList(parsed.moods),
    uses: normalizeLabelList(parsed.uses),
    reactions,
    intensity,
    personaFit: Math.max(0, Math.min(1, Number(parsed.personaFit) || 0)),
    notes: normalizeShortNote(parsed.notes),
  };
}

async function findSticker(filter) {
  return plainSticker(await executeQuery(stickerModel.findOne(filter)));
}

async function updateSticker(filter, update, options = {}) {
  return plainSticker(await executeQuery(stickerModel.findOneAndUpdate(filter, update, {
    new: true,
    ...options,
  })));
}

async function fetchImageBuffer(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: AI_STICKER_DOWNLOAD_TIMEOUT_MS,
    maxContentLength: AI_STICKER_MAX_BYTES,
    maxBodyLength: AI_STICKER_MAX_BYTES,
  });
  const bytes = Buffer.from(response.data || []);
  if (!bytes.length) throw new Error('Cloudinary returned an empty sticker image.');
  if (bytes.length > AI_STICKER_MAX_BYTES) throw new Error('Sticker image exceeds the configured size limit.');
  return bytes;
}

// ─── Analysis: one request covers many stickers and every persona ───────────
// Old design: one IMAGE request per sticker per persona (3 personas x 100
// stickers = 300 requests, every time). Now:
//   1. A sticker with no description yet gets looked at ONCE (several stickers
//      per image request). Imported stickers already have one from the import.
//   2. How well each persona would use each sticker is judged from those words
//      in a single TEXT request for up to AI_STICKER_FIT_BATCH stickers and
//      every persona together (100 stickers = 5 requests).
// Failures never overwrite an analysis that already worked.

const MAX_REQUESTS_PER_BATCH = 8;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function hasDescription(doc) {
  const generic = doc?.genericAnalysis;
  return Boolean(generic && (String(generic.expression || '').trim() || (Array.isArray(generic.reactions) && generic.reactions.length)));
}

function parseJsonObject(rawText, what) {
  const text = String(rawText || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const fail = detail => Object.assign(new Error(`Gemini ${detail} for ${what}.`), { code: 'ANALYSIS_PARSE' });
  if (start < 0 || end <= start) throw fail('returned no JSON object');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_err) {
    throw fail('returned JSON that could not be read');
  }
}

const DESCRIBE_SYSTEM_PROMPT = 'You are a concise anime sticker cataloguer for a shared reaction library. Describe only what each sticker shows and the feeling it conveys; do not role-play or infer a persona.';

function describePrompt(docs) {
  const list = docs.map((doc, index) => `${index + 1}. ${doc.animeName || 'unknown anime'}${(doc.characters || []).length ? ` (may show: ${doc.characters.join(', ')})` : ''}`).join('\n');
  return `${docs.length} sticker image(s) are attached in this order:\n${list}\nReturn only JSON for every one: {"stickers":[{"id":1,"expression":"what it conveys in under 12 words, including any text printed on it","emotions":[],"moods":[],"uses":[],"reactions":[],"diversityScore":0.5}]}. Use short lowercase labels. reactions may only use: ${[...ALLOWED_REACTIONS].join(', ')}. Describe the feeling and situation, not the artwork.`;
}

function parseDescribeResponse(rawText, count) {
  const parsed = parseJsonObject(rawText, 'the sticker descriptions');
  const rows = Array.isArray(parsed.stickers) ? parsed.stickers : [];
  const byId = new Map();
  for (const row of rows) {
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id < 1 || id > count || byId.has(id)) continue;
    const analysis = {
      expression: String(row.expression || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      emotions: normalizeLabelList(row.emotions),
      moods: normalizeLabelList(row.moods),
      uses: normalizeLabelList(row.uses),
      reactions: normalizeLabelList(row.reactions, 8).filter(tag => ALLOWED_REACTIONS.has(tag)),
      diversityScore: Math.max(0, Math.min(1, Number(row.diversityScore) || 0)),
    };
    if (analysis.expression || analysis.reactions.length) byId.set(id, analysis);
  }
  return byId;
}

const FIT_SYSTEM_PROMPT = 'You decide which reaction stickers a specific character would naturally send in a chat. You get character profiles and a numbered list of stickers described in words. Answer with JSON only.';

function fitPrompt(docs, personas) {
  const characters = personas.map(persona => `[${persona.id}] ${persona.displayName}${persona.series ? ` (${persona.series})` : ''}: ${clip(persona.personality, 700)}`).join('\n');
  const list = docs.map((doc, index) => {
    const g = doc.genericAnalysis || {};
    const cast = (doc.characters || []).length ? ` (${doc.characters.join(', ')})` : '';
    return `${index + 1}. ${doc.animeName || 'unknown anime'}${cast}: "${clip(g.expression, 80)}" | emotions: ${(g.emotions || []).join(', ') || '-'} | moods: ${(g.moods || []).join(', ') || '-'} | uses: ${(g.uses || []).join(', ') || '-'} | reactions: ${(g.reactions || []).join(', ') || '-'}`;
  }).join('\n');
  const example = personas.map(persona => `"${persona.id}":{"fit":0.8,"reactions":["amused"],"intensity":"medium"}`).join(',');
  return `Characters:\n${characters}\n\nStickers (described in words):\n${list}\n\nFor EVERY sticker and EVERY character decide how naturally that character would send this sticker. fit is 0 to 1 (0 = completely out of character, 1 = perfectly in character); use the full range and be discriminating, since most stickers suit some characters better than others. reactions: up to 3 labels that character would use it for. intensity: low, medium or high.\nReturn only JSON: {"results":[{"id":1,"p":{${example}}}]}. Allowed reaction labels: ${[...ALLOWED_REACTIONS].join(', ')}.`;
}

// Map(id -> Map(personaId -> { personaFit, reactions, intensity } | absent))
function parseFitResponse(rawText, count, personaIds) {
  const parsed = parseJsonObject(rawText, 'the persona fit');
  const rows = Array.isArray(parsed.results) ? parsed.results : [];
  const byId = new Map();
  for (const row of rows) {
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id < 1 || id > count || byId.has(id)) continue;
    const perPersona = new Map();
    for (const personaId of personaIds) {
      const entry = row.p?.[personaId];
      if (!entry || typeof entry !== 'object') continue;
      const reactions = normalizeLabelList(entry.reactions, 8).filter(tag => ALLOWED_REACTIONS.has(tag));
      if (!reactions.length || !Number.isFinite(Number(entry.fit))) continue;
      perPersona.set(personaId, {
        personaFit: Math.max(0, Math.min(1, Number(entry.fit))),
        reactions,
        intensity: ['low', 'medium', 'high'].includes(String(entry.intensity || '').toLowerCase()) ? String(entry.intensity).toLowerCase() : 'medium',
      });
    }
    byId.set(id, perPersona);
  }
  return byId;
}

// Step 1. Looks at stickers that have no description. Several per request; when
// a reply cannot be read the group is split, down to single stickers.
async function describeStickers(docs, outcome, failures) {
  if (!docs.length) return;
  if (outcome.requests >= MAX_REQUESTS_PER_BATCH) {
    for (const doc of docs) failures.set(doc.hash, 'Gave up after too many requests in one batch.');
    return;
  }
  const withImages = [];
  for (const doc of docs) {
    try {
      const bytes = await fetchImageBuffer(doc.cloudinaryUrl);
      withImages.push({ doc, image: { base64: bytes.toString('base64'), mimeType: 'image/webp' } });
    } catch (err) {
      failures.set(doc.hash, `Could not download the sticker image: ${String(err.message || err).slice(0, 160)}`);
    }
  }
  if (!withImages.length) return;
  const group = withImages.map(item => item.doc);
  outcome.requests += 1;
  let described;
  try {
    const raw = await gemini.generateVision({
      systemPrompt: DESCRIBE_SYSTEM_PROMPT,
      prompt: describePrompt(group),
      images: withImages.map(item => item.image),
      maxOutputTokens: 1024 + group.length * 256,
      bypassGate: true,
    });
    described = parseDescribeResponse(raw, group.length);
  } catch (err) {
    if (isQuotaError(err)) throw err;
    if (err.code === 'ANALYSIS_PARSE' && group.length > 1) {
      const middle = Math.ceil(group.length / 2);
      await describeStickers(group.slice(0, middle), outcome, failures);
      await describeStickers(group.slice(middle), outcome, failures);
      return;
    }
    for (const doc of group) failures.set(doc.hash, String(err.message || err).slice(0, 300));
    return;
  }
  for (let index = 0; index < group.length; index += 1) {
    const doc = group[index];
    const analysis = described.get(index + 1);
    if (!analysis) { failures.set(doc.hash, 'Gemini returned no usable description for this sticker.'); continue; }
    const generic = { ...analysis, analyzedAt: new Date() };
    const updated = await updateSticker({ personaId: doc.personaId, hash: doc.hash }, { $set: { genericAnalysis: generic } });
    doc.genericAnalysis = generic;
    if (updated) setCachedSticker(SHARED_LIBRARY_KEY, updated);
  }
}

// Step 2. One text request judges every (sticker, persona) pair in `docs`.
async function judgeFit(docs, personas, outcome) {
  const results = new Map();
  const attempt = async list => {
    if (!list.length || outcome.requests >= MAX_REQUESTS_PER_BATCH) return;
    outcome.requests += 1;
    let parsed;
    try {
      const raw = await gemini.generateText({
        systemPrompt: FIT_SYSTEM_PROMPT,
        prompt: fitPrompt(list, personas),
        maxOutputTokens: 1024 + list.length * personas.length * 90,
        bypassGate: true,
      });
      parsed = parseFitResponse(raw, list.length, personas.map(persona => persona.id));
    } catch (err) {
      if (isQuotaError(err)) throw err;
      if (err.code === 'ANALYSIS_PARSE' && list.length > 1) {
        const middle = Math.ceil(list.length / 2);
        await attempt(list.slice(0, middle));
        await attempt(list.slice(middle));
        return;
      }
      logger.write('WARN', 'background.ai_sticker_analysis.fit_failed', { stickers: list.length, error: String(err.message || err).slice(0, 200) });
      return;
    }
    list.forEach((doc, index) => results.set(doc.hash, parsed.get(index + 1) || new Map()));
  };
  await attempt(docs);
  return results;
}

// Merges new per-persona results into the sticker record. A failure is only
// written when there is no working analysis yet, so a failed redo never
// destroys a good result.
async function savePersonaAnalyses(doc, entries) {
  const keep = new Map((doc.personaAnalyses || []).map(analysis => [analysis.personaId, analysis]));
  const generic = doc.genericAnalysis || {};
  for (const entry of entries) {
    const base = { personaId: entry.personaId, analysisVersion: AI_STICKER_ANALYSIS_VERSION, personaVersion: personaVersion(entry.persona) };
    if (entry.classification) {
      keep.set(entry.personaId, {
        ...base,
        analysisStatus: 'classified',
        emotions: generic.emotions || [],
        moods: generic.moods || [],
        uses: generic.uses || [],
        reactions: entry.classification.reactions,
        intensity: entry.classification.intensity,
        personaFit: entry.classification.personaFit,
        notes: '',
        analysisError: null,
        analyzedAt: new Date(),
      });
    } else if (!isUsableAnalysis(keep.get(entry.personaId))) {
      keep.set(entry.personaId, { ...base, analysisStatus: 'unclassified', analysisError: String(entry.error || 'Analysis failed.').slice(0, 300), analyzedAt: new Date() });
    }
  }
  const updated = await updateSticker({ personaId: doc.personaId, hash: doc.hash }, { $set: { personaAnalyses: [...keep.values()] } });
  if (updated) setCachedSticker(SHARED_LIBRARY_KEY, updated);
  return updated;
}

// Analyses one batch of queued tasks ({ personaId, hash }). Never throws.
// Returns { ok, failed, requests, quota, error, retryHintMs }.
async function analyzeBatch(tasks) {
  const outcome = { ok: 0, failed: 0, requests: 0, quota: false, error: null, retryHintMs: null };
  const wanted = new Map();
  for (const task of tasks) {
    if (!task?.personaId || task.personaId === SHARED_LIBRARY_KEY) continue;
    if (!wanted.has(task.hash)) wanted.set(task.hash, new Set());
    wanted.get(task.hash).add(task.personaId);
  }
  if (!wanted.size) return outcome;

  try {
    await ensureDatabaseReady();
    const docs = new Map();
    for (const [hash, personaIds] of wanted) {
      const doc = await findSticker({ personaId: SHARED_LIBRARY_KEY, hash }) || await findSticker({ hash });
      if (doc && doc.cloudinaryUrl) docs.set(hash, doc);
      else outcome.failed += personaIds.size;
    }

    const personas = new Map();
    for (const personaId of new Set([...wanted.values()].flatMap(ids => [...ids]))) {
      try { personas.set(personaId, loadPersona(personaId)); } catch (err) {
        logger.error('background.ai_sticker_analysis.persona_unavailable', err, { personaId });
      }
    }

    // Step 1: describe the stickers that have no description yet.
    const undescribed = [...docs.values()].filter(doc => !hasDescription(doc));
    const describeFailures = new Map();
    for (const group of chunk(undescribed, AI_STICKER_VISION_BATCH)) await describeStickers(group, outcome, describeFailures);

    // Step 2: one text request judges every sticker x persona in this batch.
    const ready = [...docs.values()].filter(hasDescription);
    const involved = [...personas.values()].filter(persona => ready.some(doc => wanted.get(doc.hash).has(persona.id)));
    const verdicts = ready.length && involved.length ? await judgeFit(ready, involved, outcome) : new Map();

    for (const doc of docs.values()) {
      const entries = [...wanted.get(doc.hash)].filter(personaId => personas.has(personaId)).map(personaId => {
        const classification = verdicts.get(doc.hash)?.get(personaId) || null;
        const error = describeFailures.get(doc.hash) || 'No usable result for this character in the response.';
        return { personaId, persona: personas.get(personaId), classification, error };
      });
      try {
        await savePersonaAnalyses(doc, entries);
      } catch (persistError) {
        logger.error('background.ai_sticker_analysis.status_save_failed', persistError, { hash: doc.hash });
      }
      for (const entry of entries) {
        if (entry.classification) outcome.ok += 1;
        else outcome.failed += 1;
      }
    }
    return outcome;
  } catch (err) {
    const message = String(err.message || err).slice(0, 300);
    if (isQuotaError(err)) {
      logger.write('WARN', 'background.ai_sticker_analysis.quota_hit', { tasks: tasks.length, error: message });
      return { ...outcome, quota: true, error: message, retryHintMs: parseRetryDelayMs(err.message) };
    }
    logger.error('background.ai_sticker_analysis.failed', new Error(message), { tasks: tasks.length });
    outcome.failed += Math.max(0, tasks.length - outcome.ok);
    return outcome;
  }
}

// Single-sticker convenience used by tests and tools.
async function analyzeSticker(sourcePersona, hash) {
  const personaId = typeof sourcePersona === 'string' ? sourcePersona : sourcePersona?.id;
  return analyzeBatch([{ personaId, hash }]);
}

// Library summary used by the startup log and by .stickeranalyze status.
// Reads only; spends nothing.
function summarizeLibrary(records, personaIds) {
  const personas = {};
  for (const personaId of personaIds) {
    const row = { ready: 0, missing: 0, failed: 0, outdated: 0 };
    for (const record of records) {
      const analysis = getPersonaAnalysis(record, personaId);
      if (!analysis) row.missing += 1;
      else if (!isUsableAnalysis(analysis)) row.failed += 1;
      else {
        row.ready += 1;
        if (Number(analysis.analysisVersion || 1) !== AI_STICKER_ANALYSIS_VERSION) row.outdated += 1;
      }
    }
    personas[personaId] = row;
  }
  return { library: records.length, undescribed: records.filter(record => !hasDescription(record)).length, personas };
}

// About how many Gemini requests a manual run would take.
function estimateRequests(records, personaIds, mode) {
  const target = mode === 'redo' ? records : records.filter(record => personaIdsNeedingAnalysis(record, personaIds).length);
  const undescribed = target.filter(record => !hasDescription(record)).length;
  const vision = Math.ceil(undescribed / AI_STICKER_VISION_BATCH);
  const fit = Math.ceil(target.length / AI_STICKER_FIT_BATCH);
  return { stickers: target.length, undescribed, vision, fit, requests: vision + fit };
}

let autoAnalyzeNoticeLogged = false;

async function initialize() {
  const records = await loadSharedStickers();
  // Starting the bot or deploying an update NEVER spends Gemini requests on
  // stickers. Analysis happens only when the owner asks (.stickeranalyze).
  if (AI_STICKER_AUTO_ANALYZE && !autoAnalyzeNoticeLogged) {
    autoAnalyzeNoticeLogged = true;
    logger.write('WARN', 'background.ai_sticker_analysis.auto_ignored', {});
  }
  try {
    const personaIds = listPersonaIds();
    const summary = summarizeLibrary(records, personaIds);
    const needing = records.filter(record => personaIdsNeedingAnalysis(record, personaIds).length).length;
    logger.write('INFO', 'background.ai_sticker_analysis.overview', { ...summary, needing });
  } catch (err) {
    logger.error('background.ai_sticker_analysis.overview_failed', err);
  }
  return records;
}

// ─── Manual analysis (owner only, via .stickeranalyze) ──────────────────────
async function queueManualAnalysis({ mode, personaIds }) {
  const records = await loadSharedStickers();
  const stickers = new Set();
  let tasks = 0;
  for (const record of records) {
    for (const personaId of personaIds) {
      if (mode === 'new' && isUsableAnalysis(getPersonaAnalysis(record, personaId))) continue;
      if (queuedAnalysis.has(analysisKey(personaId, record.hash))) continue;
      enqueueAnalysis(personaId, record.hash);
      stickers.add(record.hash);
      tasks += 1;
    }
  }
  const estimate = estimateRequests(records, personaIds, mode);
  logger.write('INFO', 'background.ai_sticker_analysis.manual', { mode, personas: personaIds, stickers: stickers.size, tasks, requests: estimate.requests });
  return { stickers: stickers.size, tasks, estimate };
}

function cancelQueuedAnalysis() {
  const cancelled = analysisQueue.length;
  for (const task of analysisQueue) queuedAnalysis.delete(analysisKey(task.personaId, task.hash));
  analysisQueue.length = 0;
  if (quotaResumeTimer) clearTimeout(quotaResumeTimer);
  quotaResumeTimer = null;
  quotaResumeAt = 0;
  logger.write('INFO', 'background.ai_sticker_analysis.cancelled', { cancelled });
  return cancelled;
}

const ANALYZE_USAGE = [
  'Usage:',
  '.stickeranalyze            show what is analysed and what a run would cost',
  '.stickeranalyze new        analyse only stickers that have no working analysis',
  '.stickeranalyze redo confirm   redo every sticker (judged again from the saved descriptions)',
  '.stickeranalyze stop       cancel what is still waiting',
  'Add a persona name (for example: new marin) to limit it to one character.',
].join('\n');

function queueStateText() {
  if (quotaResumeTimer) {
    const when = new Date(quotaResumeAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
    return `paused for Gemini quota, ${analysisQueue.length} waiting (retrying about ${when})`;
  }
  if (analysisBusy || analysisQueue.length) return `running, ${analysisQueue.length} waiting`;
  return 'idle';
}

async function analyzeCommand(client, msg, args) {
  const verified = await verifyOwnerPrivateChat(msg);
  if (!verified) {
    await msg.reply('❌ Sticker analysis is available only to the bot owner in a private DM.');
    return false;
  }
  const words = (args || []).map(word => String(word).toLowerCase());
  const known = ['status', 'new', 'redo', 'stop'];
  const action = words.length === 0 ? 'status' : known.includes(words[0]) ? words[0] : null;
  const confirmed = words.includes('confirm');
  const rest = words.slice(1).filter(word => word !== 'confirm');
  if (!action || rest.length > 1) {
    await msg.reply(ANALYZE_USAGE);
    return false;
  }
  const allIds = listPersonaIds();
  let personaIds = allIds;
  if (rest[0] && rest[0] !== 'all') {
    if (!allIds.includes(rest[0])) {
      await msg.reply(`❌ Unknown persona "${rest[0]}". Available: ${allIds.join(', ')}.`);
      return false;
    }
    personaIds = [rest[0]];
  }

  if (action === 'stop') {
    const cancelled = cancelQueuedAnalysis();
    await msg.reply(cancelled ? `🛑 Cancelled ${cancelled} waiting analysis task(s). A request already in progress will finish.` : 'Nothing was waiting.');
    return true;
  }

  let records;
  try {
    records = await loadSharedStickers();
  } catch (err) {
    await msg.reply(`❌ Could not read the sticker library: ${unavailableStorageMessage(err)}`);
    return false;
  }

  if (action === 'status') {
    const summary = summarizeLibrary(records, personaIds);
    const fresh = estimateRequests(records, personaIds, 'new');
    const everything = estimateRequests(records, personaIds, 'redo');
    const lines = [`🎴 *Sticker analysis*`, `Library: ${summary.library} stickers (${summary.undescribed} without a description yet)`];
    for (const personaId of personaIds) {
      const row = summary.personas[personaId];
      lines.push(`• ${personaId}: ${row.ready} ready, ${row.missing} not analysed, ${row.failed} failed${row.outdated ? `, ${row.outdated} from an older analysis version` : ''}`);
    }
    lines.push(`Queue: ${queueStateText()}`, '');
    lines.push(fresh.stickers ? `*new* would analyse ${fresh.stickers} sticker(s): about ${fresh.requests} request(s).` : 'Nothing needs analysing.');
    lines.push(`*redo* would redo all ${everything.stickers}: about ${everything.requests} request(s).`);
    lines.push('', 'Nothing is analysed automatically, not at startup and not after an update.');
    await msg.reply(lines.join('\n'));
    return true;
  }

  if (!process.env.GEMINI_API_KEY) {
    await msg.reply('❌ GEMINI_API_KEY is not set in .env, so stickers cannot be analysed.');
    return false;
  }
  const estimate = estimateRequests(records, personaIds, action);
  if (action === 'redo' && !confirmed) {
    await msg.reply(`⚠️ This redoes the analysis of all ${estimate.stickers} sticker(s) for ${personaIds.join(', ')}: about ${estimate.requests} Gemini request(s).\nTo go ahead send: .stickeranalyze redo${rest[0] ? ` ${rest[0]}` : ''} confirm`);
    return false;
  }
  if (action === 'new' && estimate.stickers === 0) {
    await msg.reply('✅ Every sticker already has a working analysis. Nothing to do.');
    return true;
  }
  const result = await queueManualAnalysis({ mode: action, personaIds });
  await msg.reply(`✅ Analysing ${result.stickers} sticker(s) for ${personaIds.join(', ')}: about ${estimate.requests} Gemini request(s), done in a few minutes. Gemini commands are unavailable until it finishes; progress is in the logs. Send .stickeranalyze to check.`);
  return true;
}

function sessionKey(ownerId, chatId) {
  return `${ownerId}:${chatId}`;
}

function clearSession(key) {
  const session = importSessions.get(key);
  if (session?.timer) clearTimeout(session.timer);
  importSessions.delete(key);
}

function armSessionExpiry(key, session, client) {
  if (session.timer) clearTimeout(session.timer);
  session.expiresAt = Date.now() + AI_STICKER_IMPORT_TIMEOUT_MINUTES * 60 * 1000;
  logger.write('INFO', 'background.ai_sticker_import_expiry.armed', { key, expiresAt: new Date(session.expiresAt), timeoutMs: AI_STICKER_IMPORT_TIMEOUT_MINUTES * 60 * 1000 });
  session.timer = setTimeout(async () => {
    if (importSessions.get(key) !== session) return;
    const operation = logger.start('background.ai_sticker_import_expiry', { key, chatId: session.chatId });
    clearSession(key);
    try {
      await client.sendMessage(session.chatId, '⏱️ Sticker import mode expired after being idle. Send .stickerimport to start again.');
      operation.finish('success', { notified: true });
    } catch (err) {
      operation.finish('failed', { error: err });
      logger.error('background.ai_sticker_import_expiry.notice_failed', err, { key });
    }
  }, AI_STICKER_IMPORT_TIMEOUT_MINUTES * 60 * 1000);
  session.timer.unref?.();
}

async function verifyOwnerPrivateChat(msg) {
  const [chat, contact] = await Promise.all([
    safeGetChat(msg).catch(() => null),
    safeGetContact(msg).catch(() => null),
  ]);
  const ownerId = contact?.id?._serialized;
  const chatId = chat?.id?._serialized || msg.from;
  if (!chat || chat.isGroup !== false || !chatId || String(chatId).endsWith('@g.us') || !ownerId || !isOwner(ownerId)) return null;
  return { chat, contact, ownerId, chatId };
}

function unavailableStorageMessage(err) {
  if (err.code === 'MONGO_NOT_READY') return 'MongoDB is not connected yet. Please wait a moment and try again.';
  return String(err.message || err).slice(0, 240);
}

async function startImportMode(client, msg) {
  const verified = await verifyOwnerPrivateChat(msg);
  if (!verified) {
    await msg.reply('❌ Sticker import is available only to the bot owner in a private DM.');
    return false;
  }
  if (!cloudinaryStorage.isCloudConfigured()) {
    await msg.reply('❌ Sticker import is unavailable because Cloudinary is not configured in .env.');
    return false;
  }
  try {
    await initialize();
  } catch (err) {
    await msg.reply(`❌ Sticker import is unavailable: ${unavailableStorageMessage(err)}`);
    return false;
  }

  const key = sessionKey(verified.ownerId, verified.chatId);
  const previous = importSessions.get(key);
  if (previous) {
    await msg.reply('🟢 Shared sticker import mode is already active. Send stickers here, or use .stickerimport off to stop.');
    armSessionExpiry(key, previous, client);
    return true;
  }

  const session = {
    ownerId: verified.ownerId,
    chatId: verified.chatId,
    startedAt: Date.now(),
    expiresAt: 0,
    timer: null,
  };
  importSessions.set(key, session);
  armSessionExpiry(key, session, client);
  await msg.reply('🟢 Shared sticker import mode enabled. Send stickers in this private DM; they will be saved once and made available to every AI persona. Use .stickerimport off to stop.');
  return true;
}

async function stopImportMode(msg) {
  const verified = await verifyOwnerPrivateChat(msg);
  if (!verified) {
    await msg.reply('❌ Sticker import is available only to the bot owner in a private DM.');
    return false;
  }
  const key = sessionKey(verified.ownerId, verified.chatId);
  if (!importSessions.has(key)) {
    await msg.reply('ℹ️ Sticker import mode is not active.');
    return true;
  }
  clearSession(key);
  await msg.reply('✅ Sticker import mode stopped. Stickers already saved to Cloudinary remain in the library.');
  return true;
}

async function persistStickerRecord(sourcePersona, hash, bytes) {
  const sourcePersonaId = typeof sourcePersona === 'string' ? sourcePersona : sourcePersona?.id || SHARED_LIBRARY_KEY;
  await ensureDatabaseReady();
  const sharedRecords = await loadSharedStickers();
  const existing = sharedRecords.find(record => record.hash === hash) || await findSticker({ hash });
  const sharedFilter = { personaId: SHARED_LIBRARY_KEY, hash };

  // Legacy rows may be tagged with the importing persona. Create a metadata-only
  // shared row that points at the exact same Cloudinary asset and carries the
  // merged analyses; no image is uploaded during this normalization.
  if (existing?.cloudinaryUrl && existing?.cloudinaryPublicId) {
    let shared = await findSticker(sharedFilter);
    if (!shared) {
      shared = await updateSticker(sharedFilter, {
        $set: {
          cloudinaryPublicId: existing.cloudinaryPublicId,
          cloudinaryUrl: existing.cloudinaryUrl,
          cloudinaryVersion: existing.cloudinaryVersion ?? null,
          format: existing.format || 'webp',
          bytes: existing.bytes || bytes?.length || 1,
          personaAnalyses: existing.personaAnalyses || (legacyAnalysis(existing) ? [legacyAnalysis(existing)] : []),
        },
        $setOnInsert: {
          personaId: SHARED_LIBRARY_KEY,
          hash,
          analysisStatus: 'unclassified',
          emotions: [], moods: [], uses: [], reactions: [], intensity: 'medium', notes: '',
          importedAt: existing.importedAt || new Date(),
        },
      }, { upsert: true, setDefaultsOnInsert: true });
    }
    setCachedSticker(SHARED_LIBRARY_KEY, shared || existing);
    const normalized = shared || existing;
    return { record: normalized, duplicate: true, shouldAnalyze: false, analysisPersonaIds: [] };
  }

  const uploaded = await cloudinaryStorage.uploadBufferToCloud(bytes, {
    folder: 'ai-stickers/shared',
    publicId: hash,
    resourceType: 'image',
    format: 'webp',
  });
  if (!uploaded?.url || !/^https:\/\//i.test(uploaded.url) || !uploaded.publicId) {
    throw new Error('Cloudinary did not return a secure URL and public ID for the sticker.');
  }

  let record;
  try {
    record = await updateSticker(sharedFilter, {
      $set: {
        cloudinaryPublicId: uploaded.publicId,
        cloudinaryUrl: uploaded.url,
        cloudinaryVersion: Number.isFinite(Number(uploaded.version)) ? Number(uploaded.version) : null,
        format: 'webp',
        bytes: bytes.length,
      },
      $setOnInsert: {
        personaId: SHARED_LIBRARY_KEY,
        hash,
        analysisStatus: 'unclassified',
        emotions: [], moods: [], uses: [], reactions: [], intensity: 'medium', notes: '',
        analysisError: null,
        importedAt: new Date(),
      },
    }, { upsert: true, setDefaultsOnInsert: true });
  } catch (err) {
    if (err.code !== 11000 && err.code !== 11001) throw err;
    record = await findSticker(sharedFilter) || await findSticker({ hash });
    if (!record) throw err;
    setCachedSticker(SHARED_LIBRARY_KEY, record);
    return { record, duplicate: true, shouldAnalyze: false, analysisPersonaIds: [] };
  }
  if (!record) record = await findSticker(sharedFilter);
  if (!record) throw new Error('Sticker image uploaded, but its MongoDB metadata could not be read back. Please retry the import.');
  setCachedSticker(SHARED_LIBRARY_KEY, record);
  // Analysis is manual: the owner runs .stickeranalyze when they have finished adding stickers.
  return { record, duplicate: false, shouldAnalyze: false, analysisPersonaIds: [] };
}

async function saveSticker(sourcePersona, hash, bytes) {
  const sourcePersonaId = typeof sourcePersona === 'string' ? sourcePersona : sourcePersona?.id || SHARED_LIBRARY_KEY;
  const key = analysisKey(SHARED_LIBRARY_KEY, hash);
  const existingTask = importsInFlight.get(key);
  if (existingTask) {
    const result = await existingTask;
    return { ...result, duplicate: true };
  }

  const task = persistStickerRecord(sourcePersonaId, hash, bytes);
  importsInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (importsInFlight.get(key) === task) importsInFlight.delete(key);
  }
}

// downloadMedia() on a freshly received sticker can fail transiently the same
// way commands/economy.js's downloadMediaWithRetry() documents for .setpic —
// the client-side media hasn't finished loading yet — and separately, the
// patched Message.js (see patches/whatsapp-web.js+1.34.7.patch) now throws a
// real Error with a "lookup"/"resolve"/"download" stage instead of WhatsApp
// Web's bare minified throw. A page-evaluate failure at the "lookup" stage in
// particular is worth one retry; a deterministic failure (bad mimetype, no
// serialized id) is not, so this only retries once and only for errors that
// look transient.
async function downloadStickerMediaWithRetry(msg) {
  const attemptOnce = () => {
    let timeout;
    return Promise.race([
      msg.downloadMedia(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('WhatsApp sticker download timed out.')), AI_STICKER_DOWNLOAD_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
  };

  const isTransient = (err) => {
    const stage = err?.wwebjs?.stage;
    return stage === 'lookup' || stage === 'resolve' || /evaluat/i.test(err?.message || '') || /timed out/i.test(err?.message || '');
  };

  try {
    return await attemptOnce();
  } catch (err) {
    console.error('AI sticker download failed (attempt 1):', err.stack || err);
    if (!isTransient(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await attemptOnce();
  }
}

async function handleIncomingSticker(client, msg) {
  if (msg.fromMe || msg.type !== 'sticker' || !msg.hasMedia) return false;
  const verified = await verifyOwnerPrivateChat(msg);
  if (!verified) return false;

  const key = sessionKey(verified.ownerId, verified.chatId);
  const session = importSessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) clearSession(key);
    return false;
  }
  if (!cloudinaryStorage.isCloudConfigured()) {
    await msg.reply('❌ Sticker import stopped because Cloudinary is not configured.');
    clearSession(key);
    return true;
  }
  armSessionExpiry(key, session, client);

  let stage = 'download';
  try {
    const media = await downloadStickerMediaWithRetry(msg);
    if (!media?.data) {
      // downloadMedia() returns undefined both when WhatsApp Web reports the
      // message not found and when the sticker's media has expired
      // (mediaStage REUPLOADING). The library's public downloadMedia()
      // contract (used by commands/fun.js, economy.js, converter.js, ai.js,
      // search.js) doesn't distinguish the two, and widening it here would
      // change what every one of those callers sees — so this reports both
      // known causes rather than guessing which one happened.
      throw new Error('WhatsApp did not return sticker data (the sticker may have expired, or WhatsApp Web could not find the message — try resending it).');
    }
    if (String(media.mimetype || '').split(';')[0].toLowerCase() !== 'image/webp') {
      throw new Error(`Only WhatsApp WebP stickers can be imported (got "${media.mimetype || 'unknown'}").`);
    }

    stage = 'decode';
    const bytes = Buffer.from(media.data, 'base64');
    if (!bytes.length) throw new Error('The downloaded sticker was empty.');
    if (bytes.length > AI_STICKER_MAX_BYTES) {
      await msg.reply(`❌ Sticker is too large to import (${Math.ceil(bytes.length / 1024)} KB; configured limit is ${Math.ceil(AI_STICKER_MAX_BYTES / 1024)} KB).`);
      return true;
    }

    stage = 'save';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const sourcePersonaId = getActivePersonaSafe()?.id || SHARED_LIBRARY_KEY;
    const result = await saveSticker(sourcePersonaId, hash, bytes);
    if (result.duplicate) {
      await msg.reply('ℹ️ That sticker is already in the shared AI sticker library; it was not uploaded again.');
    } else {
      await msg.reply('✅ Sticker saved to the shared AI sticker library. The AI cannot use it until it has been analysed: send .stickeranalyze new when you have finished adding stickers.');
    }
    return true;
  } catch (err) {
    // Full error + stack always goes to the logs; the chat reply is a
    // trimmed, but never single-character, human-readable summary. Prefixing
    // with the stage (download/decode/save, where "save" covers both
    // Cloudinary upload and the Mongo write inside persistStickerRecord)
    // tells Brandon which part of the pipeline failed without digging into
    // PM2 logs for routine cases.
    console.error(`AI sticker import failed at stage "${stage}":`, err.stack || err);
    const detail = String(err?.message || err || 'unknown error').trim() || 'unknown error';
    await msg.reply(`❌ Could not save that sticker (${stage} failed): ${detail.slice(0, 300)}`);
    return true;
  }
}

function isKnownAnime(animeId) {
  return Boolean(animeId) && animeId !== UNKNOWN_ANIME_ID;
}

// Small, escalating penalty so one anime does not dominate a chat. It only
// re-orders candidates that already passed the hard persona-fit and reaction
// gates in selectSticker(); it can never make a weak sticker eligible.
function animeRepeatPenalty(recentAnime, animeId) {
  if (!isKnownAnime(animeId)) return 0;
  const count = recentAnime.filter(id => id === animeId).length;
  if (!count) return 0;
  return Math.min(MAX_ANIME_REPEAT_PENALTY, 1 + (count - 1) * 2);
}

function rememberRecent(chatId, hash, animeId) {
  const key = String(chatId || 'unknown-chat');
  recentByChat.delete(key);
  recentByChat.set(key, hash);
  const recentHashes = (recentHashesByChat.get(key) || []).filter(item => item !== hash).concat(hash).slice(-20);
  recentHashesByChat.delete(key);
  recentHashesByChat.set(key, recentHashes);
  while (recentHashesByChat.size > MAX_TRACKED_CHATS) recentHashesByChat.delete(recentHashesByChat.keys().next().value);
  while (recentByChat.size > MAX_TRACKED_CHATS) recentByChat.delete(recentByChat.keys().next().value);

  if (isKnownAnime(animeId)) {
    const recentAnime = (recentAnimeByChat.get(key) || []).concat(animeId).slice(-RECENT_ANIME_WINDOW);
    recentAnimeByChat.delete(key);
    recentAnimeByChat.set(key, recentAnime);
    while (recentAnimeByChat.size > MAX_TRACKED_CHATS) recentAnimeByChat.delete(recentAnimeByChat.keys().next().value);
  }
}

function chooseCandidate(candidates, recentHash) {
  if (!candidates.length) return null;
  const fresh = candidates.filter(entry => entry.hash !== recentHash);
  const pool = fresh.length ? fresh : candidates;
  return pool[Math.floor(Math.random() * pool.length)];
}

function scoreStickerAnalysis(analysis, reaction) {
  if (!analysis || analysis.analysisStatus !== 'classified') return 0;
  let score = 0;
  if (analysis.reactions?.includes(reaction)) score += 10;
  if (analysis.emotions?.includes(reaction)) score += 6;
  if (analysis.uses?.includes(reaction)) score += 5;
  if (analysis.moods?.includes(reaction)) score += 4;
  if (analysis.intensity === 'high') score += 1;
  score += Math.round(Math.max(0, Math.min(1, Number(analysis.personaFit) || 0)) * 5);
  return score;
}

function hasExactReactionMatch(analysis, reaction) {
  return Boolean(
    analysis
      && analysis.analysisStatus === 'classified'
      && Array.isArray(analysis.reactions)
      && analysis.reactions.includes(reaction)
  );
}

async function selectSticker(reaction, chatId, persona = null) {
  if (!reaction || reaction === 'none' || !ALLOWED_REACTIONS.has(reaction)) return null;
  const activePersona = persona || getActivePersonaSafe();
  if (!activePersona) return null;
  const records = await loadSharedStickers();
  const candidates = records.map(entry => {
    const analysis = getPersonaAnalysis(entry, activePersona.id);
    const exactReaction = hasExactReactionMatch(analysis, reaction);
    const personaFit = Math.max(0, Math.min(1, Number(analysis?.personaFit) || 0));
    return { entry, analysis, exactReaction, personaFit, score: scoreStickerAnalysis(analysis, reaction) };
  }).filter(candidate => (
    candidate.entry.cloudinaryUrl
    && candidate.entry.cloudinaryPublicId
    && candidate.personaFit >= AI_STICKER_MIN_PERSONA_FIT
    // Exact reaction labels are the preferred/strong path. A non-exact
    // candidate must clear the deliberately high threshold; weak emotions,
    // moods, uses, unclassified records, and barely related memes cannot win.
    && (candidate.exactReaction || candidate.score >= AI_STICKER_MATCH_THRESHOLD)
  ));
  if (!candidates.length) {
    logger.write('INFO', 'sticker.selection.skipped', { reaction, personaId: activePersona.id, reason: 'no_good_match' });
    return null;
  }

  const exactCandidates = candidates.filter(candidate => candidate.exactReaction);
  const preferredCandidates = exactCandidates.length ? exactCandidates : candidates;
  const chatKey = String(chatId || 'unknown-chat');
  const recentHash = recentByChat.get(chatKey);
  const recentAnime = recentAnimeByChat.get(chatKey) || [];
  const adjusted = preferredCandidates.map(candidate => ({
    candidate,
    adjustedScore: candidate.score - animeRepeatPenalty(recentAnime, candidate.entry.animeId),
  }));
  const bestAdjusted = Math.max(...adjusted.map(item => item.adjustedScore));
  const best = adjusted.filter(item => item.adjustedScore === bestAdjusted).map(item => item.candidate);
  const nonRecent = best.filter(candidate => candidate.entry.hash !== recentHash);
  const pool = nonRecent.length ? nonRecent : best;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  if (!selected) return null;
  rememberRecent(chatId, selected.entry.hash, selected.entry.animeId);
  logger.write('INFO', 'sticker.selection.picked', {
    reaction,
    personaId: activePersona.id,
    hash: String(selected.entry.hash || '').slice(0, 8),
    anime: selected.entry.animeId || null,
    match: selected.exactReaction ? 'exact reaction' : 'strong score',
    score: selected.score,
  });
  return { entry: selected.entry, analysis: selected.analysis, persona: activePersona, score: selected.score };
}

async function findSharedStickersByAnime(animeId) {
  const records = await loadSharedStickers();
  if (!animeId) return records;
  return records.filter(record => record.animeId === animeId);
}

async function rememberSentSticker(message, chatId, selected, reaction) {
  const messageId = message?.id?._serialized || message?.id?.id;
  if (!messageId || !selected?.entry?.hash || !selected?.persona?.id || !mongoIsReady()) return;
  try {
    await AiStickerMessage.findOneAndUpdate(
      { messageId },
      {
        $set: {
          chatId,
          hash: selected.entry.hash,
          personaId: selected.persona.id,
          reaction,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error('AI sticker message attribution save failed:', err.message);
  }
}

async function getSentStickerContext(messageId) {
  if (!messageId || !mongoIsReady()) return null;
  try {
    return await AiStickerMessage.findOne({ messageId }).lean();
  } catch (err) {
    console.error('AI sticker message attribution lookup failed:', err.message);
    return null;
  }
}

async function sendReactionSticker(client, msg, reaction) {
  if (!AI_STICKERS_ENABLED || !reaction || reaction === 'none' || !ALLOWED_REACTIONS.has(reaction)) return false;
  const persona = getActivePersonaSafe();
  if (!persona) return false;

  try {
    const chatId = msg.from || msg.to || msg.chat?.id?._serialized;
    const selected = await selectSticker(reaction, chatId, persona);
    if (!selected) return false;

    const image = await fetchImageBuffer(selected.entry.cloudinaryUrl);
    const media = new MessageMedia('image/webp', image.toString('base64'), `ai-sticker-${selected.entry.hash}.webp`);
    const sent = await client.sendMessage(chatId, media, {
      sendMediaAsSticker: true,
      stickerName: BOT_NAME,
      stickerAuthor: persona.stickerAuthor,
    });
    aiMessageLedger.remember(sent, 'sticker');
    await rememberSentSticker(sent, chatId, selected, reaction);
    return true;
  } catch (err) {
    console.error('AI reaction sticker send failed:', err.message);
    return false;
  }
}

// ─── Model-chosen stickers (the AI picks from a numbered catalogue) ─────────
// The old path guessed a sticker from a single reaction label, without knowing
// what had just been said, so it could pick a sticker that matched the label but
// not the moment. Now the reply prompt includes a short catalogue and the AI
// chooses the sticker itself, while it writes its reply, or chooses none.
// Only stickers that passed the persona-fit gate are ever offered, and the model
// can only pick a number that was offered.

function clip(value, max) {
  const text = String(value || '').replace(/["\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trim()}…`;
}

function describeForCatalogue(entry, analysis) {
  const expression = clip(entry.genericAnalysis?.expression, 56);
  const note = clip(analysis?.notes, 56);
  return expression || note || '';
}

function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Returns { items, text, eligible, offered, animeCount, excluded, reason }.
// items[n] = { id, hash, entry, analysis, label }; `text` is the prompt block.
async function buildStickerCatalogue(chatId, persona = null, { max = AI_STICKER_CATALOGUE_MAX } = {}) {
  const base = { items: [], text: '', eligible: 0, offered: 0, animeCount: 0, excluded: {}, reason: null };
  const chatKey = String(chatId || 'unknown-chat');
  if (!AI_STICKERS_ENABLED) {
    logger.write('INFO', 'ai.catalogue', { chatId: chatKey, offered: 0, reason: 'stickers_disabled' });
    return { ...base, reason: 'stickers_disabled' };
  }
  const activePersona = persona || getActivePersonaSafe();
  if (!activePersona) return { ...base, reason: 'no_persona' };

  let records;
  try {
    records = await loadSharedStickers();
  } catch (err) {
    logger.error('ai.catalogue.failed', err, { chatId: chatKey });
    return { ...base, reason: 'library_unavailable' };
  }

  const recent = new Set(AI_STICKER_RECENT_EXCLUDE > 0 ? (recentHashesByChat.get(chatKey) || []).slice(-AI_STICKER_RECENT_EXCLUDE) : []);
  const excluded = { no_asset: 0, unclassified: 0, low_persona_fit: 0, recently_sent: 0 };
  const eligible = [];
  for (const entry of records) {
    if (!entry.cloudinaryUrl || !entry.cloudinaryPublicId) { excluded.no_asset += 1; continue; }
    const analysis = getPersonaAnalysis(entry, activePersona.id);
    if (!analysis || analysis.analysisStatus !== 'classified') { excluded.unclassified += 1; continue; }
    const fit = Math.max(0, Math.min(1, Number(analysis.personaFit) || 0));
    if (fit < AI_STICKER_MIN_PERSONA_FIT) { excluded.low_persona_fit += 1; continue; }
    if (recent.has(entry.hash)) { excluded.recently_sent += 1; continue; }
    eligible.push({ entry, analysis });
  }

  // Spread across anime: shuffle inside each anime, then take one from each in
  // turn until the cap is reached, so no single anime crowds the catalogue.
  const groups = new Map();
  for (const item of shuffled(eligible)) {
    const key = isKnownAnime(item.entry.animeId) ? item.entry.animeId : UNKNOWN_ANIME_ID;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queues = shuffled([...groups.values()]);
  const picked = [];
  while (picked.length < max && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      if (picked.length >= max) break;
      if (queue.length) picked.push(queue.shift());
    }
  }

  // Number them in display order (grouped by anime) so the list is compact.
  const byAnime = new Map();
  for (const item of picked) {
    const name = isKnownAnime(item.entry.animeId) ? (item.entry.animeName || item.entry.animeId) : 'Other';
    if (!byAnime.has(name)) byAnime.set(name, []);
    byAnime.get(name).push(item);
  }
  const items = [];
  const lines = [];
  for (const [name, group] of [...byAnime.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = group.map(item => {
      const id = items.length + 1;
      const reactions = (item.analysis.reactions || []).slice(0, 3).join(', ');
      const description = describeForCatalogue(item.entry, item.analysis);
      const label = [description, reactions].filter(Boolean).join(' / ') || 'sticker';
      items.push({ id, hash: item.entry.hash, entry: item.entry, analysis: item.analysis, label });
      return `${id} "${description || 'sticker'}"${reactions ? ` [${reactions}]` : ''}`;
    });
    lines.push(`${name}: ${parts.join(' | ')}`);
  }

  const result = {
    items,
    text: lines.join('\n'),
    eligible: eligible.length,
    offered: items.length,
    animeCount: byAnime.size,
    excluded,
    reason: items.length ? null : 'nothing_eligible',
  };
  logger.write('INFO', 'ai.catalogue', {
    chatId: chatKey,
    personaId: activePersona.id,
    library: records.length,
    eligible: result.eligible,
    offered: result.offered,
    animeCount: result.animeCount,
    excluded,
    reason: result.reason,
  });
  return result;
}

// Sends catalogue sticker `stickerId`. Never throws; the result says what
// happened so the caller can log it and decide on a fallback.
async function sendCatalogueSticker(client, msg, catalogue, stickerId, { persona = null } = {}) {
  const id = Number(stickerId);
  const item = (catalogue?.items || []).find(candidate => candidate.id === id);
  if (!item) {
    logger.write('WARN', 'ai.sticker.choice', { requested: stickerId, status: 'not_offered', offered: catalogue?.items?.length || 0 });
    return { sent: false, reason: 'not_offered', item: null };
  }
  const activePersona = persona || getActivePersonaSafe();
  const chatId = msg.from || msg.to || msg.chat?.id?._serialized;
  try {
    const image = await fetchImageBuffer(item.entry.cloudinaryUrl);
    const media = new MessageMedia('image/webp', image.toString('base64'), `ai-sticker-${item.entry.hash}.webp`);
    const sent = await client.sendMessage(chatId, media, {
      sendMediaAsSticker: true,
      stickerName: BOT_NAME,
      stickerAuthor: activePersona?.stickerAuthor,
    });
    aiMessageLedger.remember(sent, 'sticker');
    const label = (item.analysis.reactions || [])[0] || 'neutral';
    await rememberSentSticker(sent, chatId, { entry: item.entry, persona: activePersona }, label);
    rememberRecent(chatId, item.entry.hash, item.entry.animeId);
    logger.write('INFO', 'ai.sticker.sent', {
      id,
      hash: String(item.entry.hash || '').slice(0, 8),
      anime: item.entry.animeName || item.entry.animeId || null,
      description: item.label,
      chatId,
    });
    return { sent: true, reason: null, item };
  } catch (err) {
    logger.error('ai.sticker.send.failed', err, { id, hash: String(item.entry.hash || '').slice(0, 8), chatId });
    return { sent: false, reason: 'send_failed', item, error: err };
  }
}

function _setAdaptersForTests({ Model, storage, mongoConnected } = {}) {
  stickerModel = Model || AiSticker;
  cloudinaryStorage = storage || cloudinary;
  mongoIsReady = mongoConnected || (() => mongoose.connection.readyState === 1);
  modelInitPromise = null;
  personaIndexes.clear();
  indexLoaders.clear();
  importsInFlight.clear();
  importSessions.clear();
  recentByChat.clear();
  recentAnimeByChat.clear();
  recentHashesByChat.clear();
  analysisQueue.length = 0;
  queuedAnalysis.clear();
  analysisBusy = false;
  if (quotaResumeTimer) clearTimeout(quotaResumeTimer);
  quotaResumeTimer = null;
  quotaResumeAt = 0;
  quotaStreak = 0;
  geminiGate.setReservationProvider(analysisReservesGemini);
}

module.exports = {
  startImportMode,
  stopImportMode,
  handleIncomingSticker,
  sendReactionSticker,
  buildStickerCatalogue,
  sendCatalogueSticker,
  analyzeCommand,
  queueManualAnalysis,
  cancelQueuedAnalysis,
  initialize,
  ALLOWED_REACTIONS,
  _parseClassification: parseClassification,
  _selectSticker: selectSticker,
  _analyzeSticker: analyzeSticker,
  _analyzeBatch: analyzeBatch,
  _personaVersion: personaVersion,
  _isUsableAnalysis: isUsableAnalysis,
  _estimateRequests: estimateRequests,
  _summarizeLibrary: summarizeLibrary,
  _persistStickerRecord: persistStickerRecord,
  _setAdaptersForTests,
  _isQuotaError: isQuotaError,
  _parseRetryDelayMs: parseRetryDelayMs,
  _getAnalysisState: () => ({
    busy: analysisBusy,
    queued: analysisQueue.length,
    pausedForQuota: quotaResumeTimer !== null,
    resumeAt: quotaResumeAt,
    quotaStreak,
  }),
  _enqueueAnalysis: enqueueAnalysis,
  _getImportSessions: () => importSessions,
  getSentStickerContext,
  _scoreStickerAnalysis: scoreStickerAnalysis,
  findSharedStickersByAnime,
};
