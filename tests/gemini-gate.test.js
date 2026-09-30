const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Config is read once at require time, so everything is set up front. Tiny
// timings keep the queue tests fast; the real defaults are 8 s / 30 min.
process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_PERSONA = 'marin';
process.env.AI_STICKERS_ENABLED = 'true';
process.env.AI_STICKER_AUTO_ANALYZE = 'false';
process.env.AI_STICKER_ANALYSIS_DELAY_MS = '0';
process.env.AI_STICKER_QUOTA_COOLDOWN_MS = '80';
process.env.AI_STICKER_QUOTA_MAX_COOLDOWN_MS = '400';
delete process.env.GEMINI_COMMANDS;
delete process.env.GEMINI_BUSY_MESSAGE;
delete process.env.GEMINI_PAUSE_DURING_STICKER_ANALYSIS;

const axios = require('axios');
const geminiGate = require('../utils/geminiGate');
const gemini = require('../utils/gemini');
const aiStickers = require('../utils/aiStickers');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition, label, timeoutMs = 4000) {
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

function makeLibrary(hashes) {
  const records = new Map(hashes.map(hash => [hash, {
    personaId: 'shared',
    hash,
    cloudinaryUrl: `https://res.cloudinary.com/test/${hash}.webp`,
    animeName: 'Naruto',
    animeId: 'naruto',
    characters: [],
    genericAnalysis: null,
    personaAnalyses: [],
  }]));
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

const CLASSIFICATION = JSON.stringify({
  emotions: ['playful'], moods: ['light'], uses: ['reply'], reactions: ['amused'],
  intensity: 'medium', personaFit: 0.9, note: 'test',
});

function quotaError(message = 'You exceeded your current quota, please check your plan and billing details.') {
  const err = new Error(`Gemini vision analysis failed: ${message}`);
  err.status = 429;
  return err;
}

test('quota detection and retry-hint parsing', () => {
  assert.equal(aiStickers._isQuotaError(quotaError()), true);
  assert.equal(aiStickers._isQuotaError(Object.assign(new Error('boom'), { status: 429 })), true);
  assert.equal(aiStickers._isQuotaError(new Error('Gemini said: RESOURCE_EXHAUSTED')), true);
  assert.equal(aiStickers._isQuotaError(new Error('Sticker classification contained no usable labels.')), false);
  assert.equal(aiStickers._isQuotaError(new Error('read ECONNABORTED')), false);
  assert.equal(aiStickers._parseRetryDelayMs('Quota exceeded. Please retry in 23.4s.'), 23400);
  assert.equal(aiStickers._parseRetryDelayMs('You exceeded your current quota (daily).'), null);
  assert.equal(aiStickers._parseRetryDelayMs('Please retry in 8h12m3.1s'), null);
});

test('gate: only listed Gemini commands are blocked, and only while reserved', () => {
  let reserved = false;
  geminiGate.setReservationProvider(() => reserved);
  for (const name of ['copilot', 'gpt', 'voice', 'imagine', 'translate', 'transcribe', 'COPILOT']) {
    assert.equal(geminiGate.shouldBlockCommand(name), false, `${name} is free while nothing is reserved`);
  }
  reserved = true;
  for (const name of ['copilot', 'gpt', 'voice', 'imagine', 'translate', 'transcribe', 'COPILOT']) {
    assert.equal(geminiGate.shouldBlockCommand(name), true, `${name} is blocked while reserved`);
  }
  for (const name of ['balance', 'daily', 'sticker', 'tts', 'upscale', 'sauce', 'menu', '', undefined]) {
    assert.equal(geminiGate.shouldBlockCommand(name), false, `${name} never uses Gemini so it is never blocked`);
  }
  geminiGate.setReservationProvider(() => false);
});

test('gate fails open when the provider throws or is missing', () => {
  geminiGate.setReservationProvider(() => { throw new Error('provider bug'); });
  assert.equal(geminiGate.isReserved(), false);
  assert.equal(geminiGate.shouldBlockCommand('copilot'), false);
  geminiGate.setReservationProvider(null);
  assert.equal(geminiGate.isReserved(), false);
});

test('gate: assertAvailable throws GEMINI_BUSY with the user-facing message unless bypassed', () => {
  geminiGate.setReservationProvider(() => true);
  assert.throws(() => geminiGate.assertAvailable(), err => err.code === 'GEMINI_BUSY' && /currently unavailable/i.test(err.message) && /try again later/i.test(err.message));
  assert.doesNotThrow(() => geminiGate.assertAvailable({ bypass: true }));
  geminiGate.setReservationProvider(() => false);
  assert.doesNotThrow(() => geminiGate.assertAvailable());
});

test('gemini.js refuses every entry point while reserved, without touching the network', async () => {
  const originalPost = axios.post;
  let networkCalls = 0;
  axios.post = async () => { networkCalls += 1; throw new Error('network must not be reached'); };
  geminiGate.setReservationProvider(() => true);
  try {
    const attempts = [
      () => gemini.generateText({ prompt: 'hi' }),
      () => gemini.generateVision({ prompt: 'hi', base64Image: 'AAAA', mimeType: 'image/webp' }),
      () => gemini.generateImage('a cat'),
      () => gemini.transcribeAudio({ base64Audio: 'AAAA', mimeType: 'audio/ogg' }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), err => err.code === 'GEMINI_BUSY');
    }
    assert.equal(networkCalls, 0);

    // The sticker-analysis queue is the one allowed caller.
    axios.post = async () => {
      networkCalls += 1;
      return { data: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } };
    };
    const text = await gemini.generateVision({ prompt: 'hi', base64Image: 'AAAA', mimeType: 'image/webp', bypassGate: true });
    assert.equal(text, 'ok');
    assert.equal(networkCalls, 1);
  } finally {
    axios.post = originalPost;
    geminiGate.setReservationProvider(() => false);
  }
});

test('queue: a quota error pauses the queue, keeps every task queued, saves no failure, then resumes by itself', async () => {
  const library = makeLibrary(['h1', 'h2', 'h3']);
  aiStickers._setAdaptersForTests({ Model: library, storage: { isCloudConfigured: () => true }, mongoConnected: () => true });

  const originalGet = axios.get;
  const originalVision = gemini.generateVision;
  axios.get = async () => ({ data: Buffer.from('fake-webp-bytes') });
  let calls = 0;
  let quotaLeft = 2; // the first two attempts hit the quota wall
  const bypassFlags = [];
  gemini.generateVision = async options => {
    calls += 1;
    bypassFlags.push(options.bypassGate);
    if (quotaLeft > 0) { quotaLeft -= 1; throw quotaError(); }
    return CLASSIFICATION;
  };

  try {
    assert.equal(geminiGate.isReserved(), false, 'idle queue does not reserve Gemini');
    for (const hash of ['h1', 'h2', 'h3']) aiStickers._enqueueAnalysis('marin', hash);
    assert.equal(geminiGate.isReserved(), true, 'reserved as soon as work is queued');

    await waitFor(() => aiStickers._getAnalysisState().pausedForQuota, 'first quota pause');
    let state = aiStickers._getAnalysisState();
    assert.equal(state.queued, 3, 'the failed task went back to the queue, none were dropped');
    assert.equal(state.quotaStreak, 1);
    assert.equal(calls, 1, 'stopped after the first quota error instead of burning through the rest');
    assert.equal(geminiGate.isReserved(), true, 'still reserved while paused');
    assert.equal(library.records.get('h1').personaAnalyses.length, 0, 'no failed status was written for a quota error');

    // Cooldown 80 ms -> retry hits quota again -> doubled cooldown (160 ms).
    await waitFor(() => aiStickers._getAnalysisState().quotaStreak === 2, 'second quota pause');
    state = aiStickers._getAnalysisState();
    assert.equal(state.queued, 3);
    assert.ok(state.resumeAt - Date.now() > 100, `cooldown should have doubled, remaining ${state.resumeAt - Date.now()} ms`);

    // Then it recovers on its own and finishes everything.
    await waitFor(() => !geminiGate.isReserved(), 'queue to drain', 6000);
    state = aiStickers._getAnalysisState();
    assert.deepEqual({ busy: state.busy, queued: state.queued, paused: state.pausedForQuota, streak: state.quotaStreak }, { busy: false, queued: 0, paused: false, streak: 0 });
    for (const hash of ['h1', 'h2', 'h3']) {
      const analyses = library.records.get(hash).personaAnalyses;
      assert.equal(analyses.length, 1, `${hash} analysed exactly once`);
      assert.equal(analyses[0].analysisStatus, 'classified');
    }
    assert.ok(bypassFlags.every(flag => flag === true), 'the analysis queue always calls Gemini with bypassGate');
    assert.equal(calls, 5, '2 quota failures + 3 successful analyses');
  } finally {
    axios.get = originalGet;
    gemini.generateVision = originalVision;
    aiStickers._setAdaptersForTests();
  }
});

test('queue: ordinary failures (timeouts) are recorded and do not pause the queue', async () => {
  const library = makeLibrary(['a1', 'a2']);
  aiStickers._setAdaptersForTests({ Model: library, storage: { isCloudConfigured: () => true }, mongoConnected: () => true });
  const originalGet = axios.get;
  const originalVision = gemini.generateVision;
  axios.get = async () => ({ data: Buffer.from('fake-webp-bytes') });
  let calls = 0;
  gemini.generateVision = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Gemini vision analysis failed: read ECONNABORTED');
    return CLASSIFICATION;
  };
  try {
    aiStickers._enqueueAnalysis('marin', 'a1');
    aiStickers._enqueueAnalysis('marin', 'a2');
    await waitFor(() => !geminiGate.isReserved(), 'queue to drain');
    assert.equal(calls, 2, 'a timeout is an ordinary failure: it is recorded and the queue moves on');
    const first = library.records.get('a1').personaAnalyses[0];
    assert.equal(first.analysisStatus, 'unclassified');
    assert.match(first.analysisError, /ECONNABORTED/);
    assert.equal(library.records.get('a2').personaAnalyses[0].analysisStatus, 'classified');
    assert.equal(aiStickers._getAnalysisState().quotaStreak, 0);
  } finally {
    axios.get = originalGet;
    gemini.generateVision = originalVision;
    aiStickers._setAdaptersForTests();
  }
});

test('queue: a Gemini "retry in Ns" hint sets the pause length (bounded by the configured maximum)', async () => {
  const library = makeLibrary(['r1']);
  aiStickers._setAdaptersForTests({ Model: library, storage: { isCloudConfigured: () => true }, mongoConnected: () => true });
  const originalGet = axios.get;
  const originalVision = gemini.generateVision;
  axios.get = async () => ({ data: Buffer.from('fake-webp-bytes') });
  let calls = 0;
  gemini.generateVision = async () => {
    calls += 1;
    if (calls === 1) throw quotaError('Quota exceeded for metric requests per minute. Please retry in 20s.');
    return CLASSIFICATION;
  };
  try {
    aiStickers._enqueueAnalysis('marin', 'r1');
    await waitFor(() => aiStickers._getAnalysisState().pausedForQuota, 'quota pause');
    const remaining = aiStickers._getAnalysisState().resumeAt - Date.now();
    // Without a hint the first pause would be the 80 ms base cooldown. A 20 s
    // hint (+5 s buffer) is far larger, so it is capped at the 400 ms maximum.
    assert.ok(remaining > 250 && remaining <= 420, `expected roughly the 400 ms cap, got ${remaining} ms`);
    await waitFor(() => !geminiGate.isReserved(), 'queue to finish after resume', 4000);
    assert.equal(library.records.get('r1').personaAnalyses[0].analysisStatus, 'classified');
    assert.equal(calls, 2);
  } finally {
    axios.get = originalGet;
    gemini.generateVision = originalVision;
    aiStickers._setAdaptersForTests();
  }
});

test('index.js checks the Gemini gate after registration and before any task bookkeeping', () => {
  const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.match(source, /require\('\.\/utils\/geminiGate'\)/);
  const registration = source.indexOf('if (registrationCheck.blocked) {');
  const gate = source.indexOf('geminiGate.shouldBlockCommand(command)');
  const taskId = source.indexOf('const taskId = nextTaskId();');
  const inFlight = source.indexOf('inFlightCount++;', gate);
  assert.ok(registration > 0 && gate > registration, 'gate comes after the registration gate');
  assert.ok(taskId > gate && inFlight > gate, 'gate comes before taskId/in-flight bookkeeping so nothing needs unwinding');
  assert.match(source.slice(gate, gate + 500), /msg\.reply\(geminiGate\.BUSY_MESSAGE\)/);
});

test('every command that calls Gemini is either gated or explicitly handled', () => {
  // ai.js: each exported command whose body calls gemini.* must be in the gated list.
  const aiSource = fs.readFileSync(path.join(ROOT, 'commands', 'ai.js'), 'utf8');
  const exportStart = aiSource.indexOf('module.exports = {');
  const body = aiSource.slice(exportStart);
  const commandStarts = [...body.matchAll(/^  async (\w+)\(client, msg, args\) \{/gm)];
  const usesGemini = [];
  commandStarts.forEach((match, index) => {
    const end = index + 1 < commandStarts.length ? commandStarts[index + 1].index : body.length;
    if (/gemini\.(generateText|generateVision|generateImage|transcribeAudio)/.test(body.slice(match.index, end))) usesGemini.push(match[1]);
  });
  assert.ok(usesGemini.length >= 5, `expected several Gemini commands in ai.js, found ${usesGemini.join(', ')}`);
  for (const name of usesGemini) {
    assert.equal(geminiGate.isGeminiCommand(name), true, `.${name} calls Gemini but is not in GEMINI_COMMANDS`);
  }
  // search.js: .sauce only uses Gemini as a fallback and must translate GEMINI_BUSY.
  const searchSource = fs.readFileSync(path.join(ROOT, 'commands', 'search.js'), 'utf8');
  assert.match(searchSource, /err\.code === 'GEMINI_BUSY'/);
  // No other in-bot module may call Gemini behind the gate's back.
  const callers = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'backups', 'tests', 'scripts', '.git', '.wwebjs_auth', '.wwebjs_cache'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /gemini\.(generateText|generateVision|generateImage|transcribeAudio)\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  assert.deepEqual(callers.sort(), ['commands/ai.js', 'commands/search.js', 'utils/aiStickers.js']);
});
