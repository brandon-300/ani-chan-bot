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
} = require('./config');
const { getActivePersonaSafe, listPersonaIds, loadPersona } = require('./persona');
const logger = require('./logger');

const ALLOWED_REACTIONS = new Set([
  'amused', 'happy', 'laughing', 'love', 'excited', 'sad', 'angry', 'confused',
  'surprised', 'embarrassed', 'shy', 'awkward', 'sleepy', 'annoyed', 'teasing',
  'disbelief', 'worried', 'supportive', 'neutral',
]);
const SHARED_LIBRARY_KEY = 'shared';

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
const analysisQueue = [];
const queuedAnalysis = new Set();
let analysisBusy = false;

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

function personaVersion(persona) {
  if (!persona) return '';
  return crypto.createHash('sha256')
    .update([persona.id, persona.personality, persona.text].join('\n'))
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

function stalePersonaIds(record) {
  return listPersonaIds().filter(personaId => {
    try {
      const analysis = getPersonaAnalysis(record, personaId);
      const currentVersion = personaVersion(loadPersona(personaId));
      return !analysis
        || analysis.analysisStatus !== 'classified'
        || analysis.analysisVersion !== AI_STICKER_ANALYSIS_VERSION
        || analysis.personaVersion !== currentVersion;
    } catch (err) {
      logger.error('background.ai_sticker_analysis.persona_check_failed', err, { personaId, hash: record?.hash });
      return false;
    }
  });
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
  logger.write('INFO', 'background.ai_sticker_analysis.queued', { personaId, hash, queueLength: analysisQueue.length });
  setImmediate(runAnalysisQueue);
}

async function runAnalysisQueue() {
  if (analysisBusy) return;
  analysisBusy = true;
  logger.write('INFO', 'background.ai_sticker_analysis.worker.start', { queued: analysisQueue.length });
  try {
    while (analysisQueue.length) {
      const task = analysisQueue.shift();
      const key = analysisKey(task.personaId, task.hash);
      const operation = logger.start('background.ai_sticker_analysis.task', { personaId: task.personaId, hash: task.hash, remaining: analysisQueue.length });
      try {
        const result = await analyzeSticker(task.personaId, task.hash);
        if (result?.failed) operation.finish('failed', { error: new Error(result.error) });
        else operation.finish('success', { reactions: result?.reactions || [] });
      } catch (err) {
        operation.finish('failed', { error: err });
        logger.error('background.ai_sticker_analysis.task.unhandled', err, { personaId: task.personaId, hash: task.hash });
      } finally {
        queuedAnalysis.delete(key);
      }
      if (analysisQueue.length && AI_STICKER_ANALYSIS_DELAY_MS > 0) {
        logger.write('INFO', 'background.ai_sticker_analysis.delay', { delayMs: AI_STICKER_ANALYSIS_DELAY_MS, remaining: analysisQueue.length });
        await new Promise(resolve => setTimeout(resolve, AI_STICKER_ANALYSIS_DELAY_MS));
      }
    }
  } finally {
    analysisBusy = false;
    logger.write('INFO', 'background.ai_sticker_analysis.worker.idle', { queued: analysisQueue.length });
    if (analysisQueue.length) setImmediate(runAnalysisQueue);
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

async function analyzeSticker(sourcePersona, hash) {
  const personaId = typeof sourcePersona === 'string' ? sourcePersona : sourcePersona?.id;
  if (!personaId || personaId === SHARED_LIBRARY_KEY) return;
  const persona = typeof sourcePersona === 'object' ? sourcePersona : loadPersona(personaId);
  const version = personaVersion(persona);
  let document;
  try {
    await ensureDatabaseReady();
    document = await findSticker({ personaId: SHARED_LIBRARY_KEY, hash }) || await findSticker({ hash });
    if (!document || !document.cloudinaryUrl) return;

    const image = await fetchImageBuffer(document.cloudinaryUrl);
    const result = await gemini.generateVision({
      systemPrompt: `You are analyzing a WhatsApp reaction sticker for the specific character ${persona.displayName}. Personality: ${persona.personality} Conversational and reaction behavior: ${persona.text}`,
      prompt: `Analyze this sticker as a reaction that ${persona.displayName} would realistically use in conversation, following both the character personality and the stated conversational/reaction behavior. Return only JSON with arrays emotions, moods, uses, reactions, a string intensity, personaFit from 0 to 1, and a short note no longer than 160 characters. Allowed reaction labels: ${[...ALLOWED_REACTIONS].join(', ')}. Keep labels short and lowercase. Interpret the image through this character's personality and behavior, not as a neutral generic sticker.`,
      base64Image: image.toString('base64'),
      mimeType: 'image/webp',
      maxOutputTokens: 512,
    });
    const classification = parseClassification(result);
    if (!classification.emotions.length && !classification.moods.length && !classification.uses.length && !classification.reactions.length && !classification.notes) {
      throw new Error('Sticker classification contained no usable labels.');
    }

    const analyses = (document.personaAnalyses || []).filter(analysis => analysis.personaId !== personaId);
    analyses.push({
      personaId,
      analysisVersion: AI_STICKER_ANALYSIS_VERSION,
      personaVersion: version,
      analysisStatus: 'classified',
      ...classification,
      analysisError: null,
      analyzedAt: new Date(),
    });
    const filter = { personaId: document.personaId === SHARED_LIBRARY_KEY ? SHARED_LIBRARY_KEY : document.personaId, hash };
    const updated = await updateSticker(filter, {
      $set: { personaAnalyses: analyses },
    });
    if (updated) setCachedSticker(SHARED_LIBRARY_KEY, updated);
    return classification;
  } catch (err) {
    const analysisError = String(err.message || err).slice(0, 300);
    try {
      const existing = document || await findSticker({ personaId: SHARED_LIBRARY_KEY, hash }) || await findSticker({ hash });
      if (existing) {
        const analyses = (existing.personaAnalyses || []).filter(analysis => analysis.personaId !== personaId);
        analyses.push({
          personaId,
          analysisVersion: AI_STICKER_ANALYSIS_VERSION,
          personaVersion: version,
          analysisStatus: 'unclassified',
          analysisError,
          analyzedAt: new Date(),
        });
        const filter = { personaId: existing.personaId, hash };
        const updated = await updateSticker(filter, { $set: { personaAnalyses: analyses } });
        if (updated) setCachedSticker(SHARED_LIBRARY_KEY, updated);
      }
    } catch (persistError) {
      logger.error('background.ai_sticker_analysis.status_save_failed', persistError, {
        personaId,
        hash,
      });
    }
    logger.error('background.ai_sticker_analysis.failed', new Error(analysisError), {
      personaId,
      hash,
    });
    return { failed: true, error: analysisError };
  }
}

async function initialize() {
  const records = await loadSharedStickers();
  if (AI_STICKER_AUTO_ANALYZE) {
    for (const record of records) {
      for (const personaId of listPersonaIds()) {
        let persona;
        try { persona = loadPersona(personaId); } catch (err) {
          console.error(`Skipping sticker analysis for invalid persona ${personaId}:`, err.message);
          continue;
        }
        const analysis = getPersonaAnalysis(record, personaId);
        const currentVersion = personaVersion(persona);
        const stale = !analysis || analysis.analysisStatus !== 'classified' || analysis.analysisVersion !== AI_STICKER_ANALYSIS_VERSION || analysis.personaVersion !== currentVersion;
        if (stale) enqueueAnalysis(personaId, record.hash);
      }
    }
  }
  return records;
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
    const stalePersonaIdsToAnalyze = AI_STICKER_AUTO_ANALYZE ? stalePersonaIds(normalized) : [];
    return {
      record: normalized,
      duplicate: true,
      shouldAnalyze: stalePersonaIdsToAnalyze.length > 0,
      analysisPersonaIds: stalePersonaIdsToAnalyze,
    };
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
  const analysisPersonaIds = AI_STICKER_AUTO_ANALYZE ? stalePersonaIds(record) : [];
  return { record, duplicate: false, shouldAnalyze: analysisPersonaIds.length > 0, analysisPersonaIds };
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
    if (result.shouldAnalyze) {
      for (const personaId of (result.analysisPersonaIds || [])) enqueueAnalysis(personaId, hash);
    }

    if (result.duplicate) {
      await msg.reply('ℹ️ That sticker is already in the shared AI sticker library; it was not uploaded again.');
    } else {
      const analysis = result.shouldAnalyze ? ' Gemini will classify it in the background.' : '';
      await msg.reply(`✅ Sticker saved to the shared AI sticker library.${analysis}`);
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

function rememberRecent(chatId, hash) {
  const key = String(chatId || 'unknown-chat');
  recentByChat.delete(key);
  recentByChat.set(key, hash);
  while (recentByChat.size > 500) recentByChat.delete(recentByChat.keys().next().value);
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
  const bestScore = Math.max(...preferredCandidates.map(candidate => candidate.score));
  const best = preferredCandidates.filter(candidate => candidate.score === bestScore);
  const recentHash = recentByChat.get(String(chatId || 'unknown-chat'));
  const nonRecent = best.filter(candidate => candidate.entry.hash !== recentHash);
  const selected = (nonRecent.length ? nonRecent : best)[Math.floor(Math.random() * (nonRecent.length || best.length))];
  if (!selected) return null;
  rememberRecent(chatId, selected.entry.hash);
  logger.write('INFO', 'sticker.selection.picked', {
    reaction,
    personaId: activePersona.id,
    hash: String(selected.entry.hash || '').slice(0, 8),
    match: selected.exactReaction ? 'exact reaction' : 'strong score',
    score: selected.score,
  });
  return { entry: selected.entry, analysis: selected.analysis, persona: activePersona, score: selected.score };
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
    await rememberSentSticker(sent, chatId, selected, reaction);
    return true;
  } catch (err) {
    console.error('AI reaction sticker send failed:', err.message);
    return false;
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
  analysisQueue.length = 0;
  queuedAnalysis.clear();
  analysisBusy = false;
}

module.exports = {
  startImportMode,
  stopImportMode,
  handleIncomingSticker,
  sendReactionSticker,
  initialize,
  ALLOWED_REACTIONS,
  _parseClassification: parseClassification,
  _selectSticker: selectSticker,
  _analyzeSticker: analyzeSticker,
  _persistStickerRecord: persistStickerRecord,
  _setAdaptersForTests,
  _getImportSessions: () => importSessions,
  getSentStickerContext,
  _scoreStickerAnalysis: scoreStickerAnalysis,
};
