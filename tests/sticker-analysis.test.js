const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The old .env value that used to start a full re-analysis on every restart.
// It must now be ignored, so it is deliberately set to "true" here.
process.env.AI_STICKER_AUTO_ANALYZE = 'true';
process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_PERSONA = 'marin';
process.env.AI_STICKERS_ENABLED = 'true';
process.env.AI_STICKER_ANALYSIS_DELAY_MS = '0';
process.env.AI_STICKER_FIT_BATCH = '20';
process.env.AI_STICKER_VISION_BATCH = '6';
process.env.OWNER_NUMBER = 'owner@c.us';
delete process.env.LOG_LEVEL;

const gemini = require('../utils/gemini');
const geminiGate = require('../utils/geminiGate');
const aiStickers = require('../utils/aiStickers');
const { loadPersona, listPersonaIds } = require('../utils/persona');

const ROOT = path.join(__dirname, '..');
const PERSONAS = listPersonaIds();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition, label, timeoutMs = 5000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(5);
  }
}

function fakeQuery(resolve) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(resolve()); },
    then(onFulfilled, onRejected) { return this.exec().then(onFulfilled, onRejected); },
  };
}

function sticker(n, { described = true, analysedFor = [] } = {}) {
  const hash = `h${String(n).padStart(3, '0')}`;
  return {
    personaId: 'shared',
    hash,
    cloudinaryPublicId: `ai-stickers/shared/${hash}`,
    cloudinaryUrl: `https://res.cloudinary.com/test/${hash}.webp`,
    animeId: 'naruto',
    animeName: 'Naruto',
    characters: [],
    genericAnalysis: described ? { expression: `look ${n}`, emotions: ['playful'], moods: ['light'], uses: ['reply'], reactions: ['teasing'], diversityScore: 0.5 } : null,
    personaAnalyses: analysedFor.map(personaId => ({
      personaId, analysisVersion: 1, personaVersion: 'a-fingerprint-from-before-the-persona-files-were-edited',
      analysisStatus: 'classified', emotions: [], moods: [], uses: [], reactions: ['happy'], intensity: 'medium', personaFit: 0.8, notes: '',
    })),
  };
}

function makeLibrary(rows) {
  const records = new Map(rows.map(row => [row.hash, JSON.parse(JSON.stringify(row))]));
  const clone = value => (value ? JSON.parse(JSON.stringify(value)) : value);
  return {
    records,
    async init() {},
    find() { return fakeQuery(() => [...records.values()].map(clone)); },
    findOne(filter) { return fakeQuery(() => clone([...records.values()].find(doc => doc.hash === filter.hash) || null)); },
    findOneAndUpdate(filter, update) {
      return fakeQuery(() => {
        const doc = records.get(filter.hash);
        if (!doc) return null;
        Object.assign(doc, update.$set || {});
        return clone(doc);
      });
    },
  };
}

async function useLibrary(rows) {
  const library = makeLibrary(rows);
  aiStickers._setAdaptersForTests({ Model: library, storage: { isCloudConfigured: () => true }, mongoConnected: () => true });
  return library;
}

function promptStickerIds(prompt) {
  return [...prompt.slice(prompt.indexOf('Stickers (described in words):')).matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
}

function fitReply(prompt) {
  const personaIds = [...prompt.matchAll(/^\[([a-z0-9_-]+)\] /gm)].map(m => m[1]);
  return JSON.stringify({
    results: promptStickerIds(prompt).map(id => ({ id, p: Object.fromEntries(personaIds.map(pid => [pid, { fit: 0.85, reactions: ['amused', 'teasing'], intensity: 'medium' }])) })),
  });
}

function captureLogs() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a) => lines.push(a.join(' '));
  console.log = grab; console.warn = grab; console.error = grab;
  return { lines, restore() { Object.assign(console, original); } };
}

function ownerMessage(replies) {
  return {
    from: 'owner@c.us',
    async getChat() { return { isGroup: false, id: { _serialized: 'owner@c.us' } }; },
    async getContact() { return { id: { _serialized: 'owner@c.us' } }; },
    async reply(text) { replies.push(text); },
  };
}

// ─── The reported problem ───────────────────────────────────────────────────
test('startup and updates never analyse anything, even with the old AI_STICKER_AUTO_ANALYZE=true', async () => {
  // Every sticker is analysed for every persona, but with an OLD persona fingerprint:
  // exactly the state in which the previous version re-queued all 300 on every restart.
  const rows = Array.from({ length: 30 }, (_, i) => sticker(i + 1, { analysedFor: PERSONAS }));
  await useLibrary(rows);
  const originalText = gemini.generateText;
  const originalVision = gemini.generateVision;
  let calls = 0;
  gemini.generateText = async () => { calls += 1; return '{}'; };
  gemini.generateVision = async () => { calls += 1; return '{}'; };
  const logs = captureLogs();
  try {
    await aiStickers.initialize();
    await sleep(60);
  } finally {
    logs.restore();
    gemini.generateText = originalText;
    gemini.generateVision = originalVision;
  }
  assert.equal(calls, 0, 'no Gemini request at startup');
  const state = aiStickers._getAnalysisState();
  assert.deepEqual({ busy: state.busy, queued: state.queued }, { busy: false, queued: 0 });
  assert.equal(geminiGate.isReserved(), false, 'Gemini commands are not paused by a restart');
  const text = logs.lines.join('\n');
  assert.match(text, /AI_STICKER_AUTO_ANALYZE is ignored now: analysis is manual/);
  assert.match(text, /\[sticker\] Library: 30 stickers · karane 30\/30 ready · marin 30\/30 ready · rias 30\/30 ready · nothing needs analysis · analysis is manual \(\.stickeranalyze\)/);
});

test('a changed persona prompt or analysis version never makes an analysis stale', () => {
  const old = { personaId: 'marin', analysisVersion: 7, personaVersion: 'totally-different', analysisStatus: 'classified' };
  assert.equal(aiStickers._isUsableAnalysis(old), true);
  assert.equal(aiStickers._isUsableAnalysis({ ...old, analysisStatus: 'unclassified' }), false);
  assert.equal(aiStickers._isUsableAnalysis(null), false);

  // The fingerprint covers the character definition only, so editing the reply
  // style / emoji / voice files cannot change it either.
  const marin = loadPersona('marin');
  const expected = crypto.createHash('sha256').update(['marin', marin.personality].join('\n')).digest('hex').slice(0, 16);
  assert.equal(aiStickers._personaVersion(marin), expected);
  assert.equal(aiStickers._personaVersion({ ...marin, text: 'edited reply style', voicePrompt: 'edited voice' }), expected);
});

test('nothing in the code queues analysis except the owner command', () => {
  const source = fs.readFileSync(path.join(ROOT, 'utils/aiStickers.js'), 'utf8');
  const calls = [...source.matchAll(/\benqueueAnalysis\(/g)].length;
  assert.equal(calls, 2, 'the definition and the one call inside queueManualAnalysis');
  assert.match(source.slice(source.indexOf('async function queueManualAnalysis'), source.indexOf('function cancelQueuedAnalysis')), /enqueueAnalysis\(personaId, record\.hash\)/);
  assert.doesNotMatch(source, /stalePersonaIds/);
  assert.match(fs.readFileSync(path.join(ROOT, 'commands/ai.js'), 'utf8'), /async stickeranalyze\(client, msg, args\)/);
});

// ─── The cost ───────────────────────────────────────────────────────────────
test('cost: 45 stickers x 3 personas is 3 text requests, not 135 image requests', async () => {
  const library = await useLibrary(Array.from({ length: 45 }, (_, i) => sticker(i + 1)));
  const originalText = gemini.generateText;
  const originalVision = gemini.generateVision;
  const requests = [];
  gemini.generateText = async options => { requests.push({ stickers: promptStickerIds(options.prompt).length, personas: [...options.prompt.matchAll(/^\[([a-z0-9_-]+)\] /gm)].map(m => m[1]) }); return fitReply(options.prompt); };
  gemini.generateVision = async () => { throw new Error('no image request is needed when stickers already have descriptions'); };
  try {
    const result = await aiStickers.queueManualAnalysis({ mode: 'new', personaIds: PERSONAS });
    assert.equal(result.tasks, 135);
    assert.equal(result.stickers, 45);
    assert.equal(result.estimate.requests, 3, 'the estimate matches what will happen');
    await waitFor(() => !geminiGate.isReserved(), 'analysis to finish');
  } finally {
    gemini.generateText = originalText;
    gemini.generateVision = originalVision;
    aiStickers._setAdaptersForTests();
  }
  assert.deepEqual(requests.map(r => r.stickers), [20, 20, 5]);
  for (const request of requests) assert.deepEqual(request.personas.sort(), [...PERSONAS].sort(), 'every character is judged in the same request');
  for (const doc of library.records.values()) {
    assert.equal(doc.personaAnalyses.length, 3);
    for (const analysis of doc.personaAnalyses) {
      assert.equal(analysis.analysisStatus, 'classified');
      assert.equal(analysis.personaFit, 0.85);
      assert.deepEqual(analysis.reactions, ['amused', 'teasing']);
      assert.deepEqual(analysis.emotions, ['playful'], 'persona-independent labels come from the shared description');
    }
  }
});

test('cost: a sticker with no description is looked at once (several per image request), shared by every persona', async () => {
  const library = await useLibrary(Array.from({ length: 7 }, (_, i) => sticker(i + 1, { described: false })));
  const originalText = gemini.generateText;
  const originalVision = gemini.generateVision;
  const imageRequests = [];
  let textRequests = 0;
  gemini.generateVision = async options => {
    imageRequests.push(options.images.length);
    assert.equal(options.bypassGate, true);
    return JSON.stringify({ stickers: options.images.map((_, i) => ({ id: i + 1, expression: `described ${i + 1}`, emotions: ['sad'], moods: ['low'], uses: ['reply'], reactions: ['sad', 'not-a-label'], diversityScore: 2 })) });
  };
  gemini.generateText = async options => { textRequests += 1; return fitReply(options.prompt); };
  const originalGet = require('axios').get;
  require('axios').get = async () => ({ data: Buffer.from('webp bytes') });
  try {
    await aiStickers.queueManualAnalysis({ mode: 'new', personaIds: PERSONAS });
    await waitFor(() => !geminiGate.isReserved(), 'analysis to finish');
  } finally {
    require('axios').get = originalGet;
    gemini.generateText = originalText;
    gemini.generateVision = originalVision;
    aiStickers._setAdaptersForTests();
  }
  assert.deepEqual(imageRequests, [6, 1], '7 stickers = 2 image requests, not 21');
  assert.equal(textRequests, 1);
  for (const doc of library.records.values()) {
    assert.match(doc.genericAnalysis.expression, /^described \d$/);
    assert.deepEqual(doc.genericAnalysis.reactions, ['sad'], 'unknown labels are dropped');
    assert.equal(doc.genericAnalysis.diversityScore, 1, 'scores are clamped');
    assert.equal(doc.personaAnalyses.length, 3);
  }
});

test('a sticker Gemini could not describe is recorded as failed for its personas and the others are unaffected', async () => {
  const library = await useLibrary([sticker(1, { described: false }), sticker(2, { described: false })]);
  const originalText = gemini.generateText;
  const originalVision = gemini.generateVision;
  const originalGet = require('axios').get;
  require('axios').get = async () => ({ data: Buffer.from('webp bytes') });
  gemini.generateVision = async () => JSON.stringify({ stickers: [{ id: 1, expression: 'only the first one', reactions: ['happy'] }] });
  gemini.generateText = async options => fitReply(options.prompt);
  try {
    await aiStickers.queueManualAnalysis({ mode: 'new', personaIds: ['marin'] });
    await waitFor(() => !geminiGate.isReserved(), 'analysis to finish');
  } finally {
    require('axios').get = originalGet;
    gemini.generateText = originalText;
    gemini.generateVision = originalVision;
    aiStickers._setAdaptersForTests();
  }
  assert.equal(library.records.get('h001').personaAnalyses[0].analysisStatus, 'classified');
  const failed = library.records.get('h002').personaAnalyses[0];
  assert.equal(failed.analysisStatus, 'unclassified');
  assert.match(failed.analysisError, /no usable description/i);
});

// ─── The owner's controls ───────────────────────────────────────────────────
test('.stickeranalyze is owner-only and private-DM-only', async () => {
  await useLibrary([sticker(1)]);
  const replies = [];
  const stranger = { ...ownerMessage(replies), async getContact() { return { id: { _serialized: 'someone@c.us' } }; } };
  assert.equal(await aiStickers.analyzeCommand({}, stranger, []), false);
  assert.match(replies.pop(), /only to the bot owner in a private DM/);
  const group = { ...ownerMessage(replies), async getChat() { return { isGroup: true, id: { _serialized: 'g@g.us' } }; } };
  assert.equal(await aiStickers.analyzeCommand({}, group, ['new']), false);
  assert.match(replies.pop(), /only to the bot owner in a private DM/);
  assert.equal(aiStickers._getAnalysisState().queued, 0);
  aiStickers._setAdaptersForTests();
});

test('.stickeranalyze status shows what is analysed, what a run would cost, and spends nothing', async () => {
  await useLibrary([
    sticker(1, { analysedFor: PERSONAS }),
    sticker(2, { analysedFor: ['marin'] }),
    sticker(3, { described: false }),
    { ...sticker(4, { analysedFor: [] }), personaAnalyses: [{ personaId: 'marin', analysisVersion: 1, personaVersion: '', analysisStatus: 'unclassified', analysisError: 'boom' }] },
  ]);
  const originalText = gemini.generateText;
  let calls = 0;
  gemini.generateText = async () => { calls += 1; return '{}'; };
  const replies = [];
  try {
    assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), []), true);
  } finally {
    gemini.generateText = originalText;
    aiStickers._setAdaptersForTests();
  }
  const text = replies[0];
  assert.equal(calls, 0);
  assert.match(text, /Library: 4 stickers \(1 without a description yet\)/);
  assert.match(text, /• marin: 2 ready, 1 not analysed, 1 failed/);
  assert.match(text, /• karane: 1 ready, 3 not analysed, 0 failed/);
  assert.match(text, /\*new\* would analyse 3 sticker\(s\): about 2 request\(s\)/, '1 text request + 1 image request for the one undescribed sticker');
  assert.match(text, /\*redo\* would redo all 4: about 2 request\(s\)/);
  assert.match(text, /Nothing is analysed automatically, not at startup and not after an update/);
  assert.match(text, /Queue: idle/);
});

test('.stickeranalyze new queues only what has no working analysis, and can be limited to one character', async () => {
  const library = await useLibrary([
    sticker(1, { analysedFor: PERSONAS }),
    sticker(2, { analysedFor: ['marin'] }),
    sticker(3),
  ]);
  const originalText = gemini.generateText;
  const asked = [];
  gemini.generateText = async options => { asked.push(options.prompt); return fitReply(options.prompt); };
  const replies = [];
  try {
    await aiStickers.analyzeCommand({}, ownerMessage(replies), ['new', 'marin']);
    await waitFor(() => !geminiGate.isReserved(), 'analysis to finish');
  } finally {
    gemini.generateText = originalText;
  }
  assert.match(replies[0], /Analysing 1 sticker\(s\) for marin: about 1 Gemini request\(s\)/);
  assert.equal(asked.length, 1);
  assert.deepEqual(promptStickerIds(asked[0]), [1], 'only sticker 3 (the one marin had no analysis for) was sent');
  assert.doesNotMatch(asked[0].slice(0, asked[0].indexOf('Stickers (described')), /\[karane\]|\[rias\]/, 'only the requested character is in the request');
  assert.equal(library.records.get('h003').personaAnalyses.length, 1);
  assert.equal(library.records.get('h003').personaAnalyses[0].personaId, 'marin');

  replies.length = 0;
  await aiStickers.analyzeCommand({}, ownerMessage(replies), ['new', 'marin']);
  assert.match(replies[0], /Every sticker already has a working analysis/);
  assert.equal(asked.length, 1, 'and asking again spends nothing');
  aiStickers._setAdaptersForTests();
});

test('.stickeranalyze redo needs the word confirm, and says what it will cost first', async () => {
  const library = await useLibrary([sticker(1, { analysedFor: PERSONAS }), sticker(2, { analysedFor: PERSONAS })]);
  const originalText = gemini.generateText;
  let calls = 0;
  gemini.generateText = async options => { calls += 1; return fitReply(options.prompt); };
  const replies = [];
  try {
    assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), ['redo']), false);
    assert.match(replies[0], /redoes the analysis of all 2 sticker\(s\) for karane, marin, rias: about 1 Gemini request/);
    assert.match(replies[0], /\.stickeranalyze redo confirm/);
    assert.equal(calls, 0);
    assert.equal(aiStickers._getAnalysisState().queued, 0);

    assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), ['redo', 'confirm']), true);
    await waitFor(() => !geminiGate.isReserved(), 'redo to finish');
    assert.equal(calls, 1, 'the whole library, every character, in one request');
    assert.equal(library.records.get('h001').personaAnalyses.every(a => a.personaVersion !== 'a-fingerprint-from-before-the-persona-files-were-edited'), true, 'the analysis was really redone');
    assert.deepEqual(library.records.get('h001').personaAnalyses.find(a => a.personaId === 'marin').reactions, ['amused', 'teasing']);
  } finally {
    gemini.generateText = originalText;
    aiStickers._setAdaptersForTests();
  }
});

test('.stickeranalyze rejects unknown characters and unknown words, and stop cancels what is waiting', async () => {
  await useLibrary(Array.from({ length: 50 }, (_, i) => sticker(i + 1)));
  const replies = [];
  assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), ['new', 'nobody']), false);
  assert.match(replies.pop(), /Unknown persona "nobody"\. Available: /);
  assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), ['everything']), false);
  assert.match(replies.pop(), /^Usage:/);

  const originalText = gemini.generateText;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  gemini.generateText = async options => { calls += 1; await gate; return fitReply(options.prompt); };
  try {
    await aiStickers.analyzeCommand({}, ownerMessage(replies), ['new', 'marin']);
    await waitFor(() => calls === 1, 'the first batch to be in flight');
    assert.equal(aiStickers._getAnalysisState().queued, 30, '20 are in flight, 30 are waiting');
    assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), ['stop']), true);
    assert.match(replies.pop(), /Cancelled 30 waiting analysis task\(s\)/);
    release();
    await waitFor(() => !geminiGate.isReserved(), 'in-flight batch to finish');
    assert.equal(calls, 1, 'nothing else was requested after stop');
    assert.equal(await aiStickers.analyzeCommand({}, ownerMessage(replies), ['stop']), true);
    assert.match(replies.pop(), /Nothing was waiting/);
  } finally {
    release();
    gemini.generateText = originalText;
    aiStickers._setAdaptersForTests();
  }
});

test('the command is listed in the help reference and the old "no emojis" wording is gone', () => {
  const reference = fs.readFileSync(path.join(ROOT, 'utils/commandReference.js'), 'utf8');
  assert.match(reference, /\.stickeranalyze \[new\|redo confirm\|stop\]/);
  assert.doesNotMatch(reference, /text reply without emojis/);
});

test('logs: each analysis step is readable', () => {
  const logger = require('../utils/logger');
  const logs = captureLogs();
  try {
    logger.write('INFO', 'background.ai_sticker_analysis.manual', { mode: 'new', personas: ['marin'], stickers: 12, tasks: 12, requests: 1 });
    logger.write('INFO', 'background.ai_sticker_analysis.batch.start', { stickers: 12, tasks: 12, remaining: 0 });
    logger.write('INFO', 'background.ai_sticker_analysis.batch.end', { status: 'success', analysed: 12, failed: 0, requests: 1, durationMs: 1800 });
    logger.write('WARN', 'background.ai_sticker_analysis.cancelled', { cancelled: 30 });
  } finally {
    logs.restore();
  }
  const text = logs.lines.join('\n');
  assert.match(text, /\[sticker\] Owner started analysis \(new\): 12 sticker\(s\) for marin, about 1 Gemini request\(s\)/);
  assert.match(text, /\[sticker\] Analysing 12 sticker\(s\) for every character together \(12 tasks, 0 still waiting\)/);
  assert.match(text, /\[sticker\] Batch done: 12 analysed using 1 Gemini request\(s\) \(1800ms\)/);
  assert.match(text, /\[sticker\] Owner cancelled 30 waiting analysis task\(s\)/);
});
