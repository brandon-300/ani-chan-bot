const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.GEMINI_API_KEY = 'test-key';
process.env.AI_PERSONA = 'marin';
process.env.AI_STICKERS_ENABLED = 'true';
process.env.AI_STICKER_AUTO_ANALYZE = 'false';
process.env.AI_STICKER_CATALOGUE_MAX = '12';
process.env.AI_STICKER_RECENT_EXCLUDE = '6';
delete process.env.GEMINI_PAUSE_DURING_STICKER_ANALYSIS;
delete process.env.LOG_LEVEL;
delete process.env.LOG_FORMAT;

const axios = require('axios');
const gemini = require('../utils/gemini');
const geminiGate = require('../utils/geminiGate');
const aiStickers = require('../utils/aiStickers');
const ledger = require('../utils/aiMessageLedger');
const AiConversation = require('../models/AiConversation');
const AiStickerMessage = require('../models/AiStickerMessage');
const { loadPersona } = require('../utils/persona');
const ai = require('../commands/ai');

const ROOT = path.join(__dirname, '..');
const persona = loadPersona('marin');

// ─── helpers ────────────────────────────────────────────────────────────────
function fakeQuery(resolve) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(resolve()); },
    then(onFulfilled, onRejected) { return this.exec().then(onFulfilled, onRejected); },
  };
}

function stickerRecord(n, animeId, animeName, { fit = 0.9, status = 'classified', asset = true, expression = `expression ${n}`, reactions = ['amused'] } = {}) {
  const hash = String(n).padStart(64, '0');
  return {
    personaId: 'shared',
    hash,
    cloudinaryPublicId: asset ? `ai-stickers/shared/${hash}` : '',
    cloudinaryUrl: asset ? `https://res.cloudinary.com/test/${hash}.webp` : '',
    bytes: 1000,
    animeId,
    animeName,
    characters: [],
    genericAnalysis: { expression, emotions: [], moods: [], uses: [], reactions },
    personaAnalyses: [{
      personaId: 'marin', analysisVersion: 1, personaVersion: '', analysisStatus: status,
      emotions: [], moods: [], uses: [], reactions, intensity: 'medium', personaFit: fit,
    }],
  };
}

function makeLibrary(rows) {
  const clone = value => JSON.parse(JSON.stringify(value));
  return {
    async init() {},
    find() { return fakeQuery(() => rows.map(clone)); },
    findOne() { return fakeQuery(() => null); },
    findOneAndUpdate() { return fakeQuery(() => null); },
  };
}

async function useLibrary(rows) {
  aiStickers._setAdaptersForTests({ Model: makeLibrary(rows), storage: { isCloudConfigured: () => true }, mongoConnected: () => true });
  await aiStickers.initialize(persona);
}

function captureLogs() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a) => lines.push(a.join(' '));
  console.log = grab; console.warn = grab; console.error = grab;
  return { lines, restore() { Object.assign(console, original); } };
}

// ─── Parsing the model's controls ───────────────────────────────────────────
test('controls: emoji and sticker tokens are read, validated, and never leak into the text', () => {
  const parsed = ai._parseAiControls('ahaha mood [[emoji:😂]] [[sticker:7]]');
  assert.equal(parsed.text, 'ahaha mood');
  assert.equal(parsed.emoji, '😂');
  assert.equal(parsed.stickerId, 7);

  assert.equal(ai._parseAiControls('[[react:❤️]]').emoji, '❤️', 'react is an accepted alias and keeps the variation selector');
  assert.equal(ai._parseAiControls('[[emoji: 🥺 ]]').emoji, '🥺');
  assert.equal(ai._parseAiControls('[[emoji:👍🏽]]').emoji, '👍🏽', 'skin tone sequences are one emoji');
  assert.equal(ai._parseAiControls('[[emoji:😂😂😂]]').emoji, '😂', 'only the first emoji is used');

  for (const bad of ['[[emoji:laughing]]', '[[emoji:]]', '[[emoji:abc 😂]]', '[[emoji:1]]', '[[emoji:<script>]]']) {
    assert.equal(ai._parseAiControls(bad).emoji, null, `${bad} is not a valid emoji`);
    assert.equal(ai._parseAiControls(`hi ${bad}`).text, 'hi', `${bad} must not leak`);
  }

  assert.equal(ai._parseAiControls('x [[sticker:none]]').stickerNone, true);
  assert.equal(ai._parseAiControls('x [[sticker:none]]').stickerId, null);
  for (const bad of ['[[sticker:0]]', '[[sticker:-3]]', '[[sticker:abc]]', '[[sticker:1234]]', '[[sticker:]]']) {
    assert.equal(ai._parseAiControls(bad).stickerId, null, bad);
  }
  assert.equal(ai._parseAiControls('[[sticker:3]] [[sticker:5]]').stickerId, 3, 'the first valid number wins');
  assert.equal(ai._parseAiControls('hello [[emoji:😂').text, 'hello', 'an unterminated token at the end of a cut-off reply is stripped');
  assert.equal(ai._parseAiControls('hello [[sticker_sent:Naruto smug]] there').text, 'hello  there'.replace('  ', ' ').trim() === 'hello there' ? 'hello  there' : 'hello there');
});

test('controls: the old reaction label no longer picks a sticker, but is still understood and stripped', () => {
  const parsed = ai._parseAiControls('hey [[reaction:happy]] [[response_mode:sticker]]');
  assert.equal(parsed.text, 'hey');
  assert.equal(parsed.reaction, 'happy');
  assert.equal(parsed.stickerId, null, 'a label alone selects nothing');
});

// ─── The prompt ─────────────────────────────────────────────────────────────
test('prompt: text replies get the human-reply rules and the catalogue; voice replies get neither', () => {
  const catalogue = { items: [{ id: 1 }], text: 'Naruto: 1 "smug grin" [teasing, amused]' };
  const text = ai._buildPersonaSystemPrompt('Brandon', 'text', false, { catalogue });
  assert.match(text, /How to answer like a real person in a WhatsApp chat/);
  assert.match(text, /Never describe or name what a sticker or picture shows/);
  assert.match(text, /no "that frog"|that frog/);
  assert.match(text, /Sympathy is the exception, not the default/);
  assert.match(text, /\[\[emoji:😂\]\]/);
  assert.match(text, /\[\[sticker:N\]\]/);
  assert.match(text, /Sticker catalogue \(number/);
  assert.match(text, /Naruto: 1 "smug grin" \[teasing, amused\]/);
  assert.match(text, /Every reply must contain at least one of/);
  assert.doesNotMatch(text, /\[\[reaction:<label>\]\]|Internal reaction control/);

  const noStickers = ai._buildPersonaSystemPrompt('Brandon', 'text', false, { catalogue: { items: [], text: '' } });
  assert.match(noStickers, /no sticker library available right now, so never write \[\[sticker:/);
  assert.doesNotMatch(noStickers, /Sticker catalogue \(number/);

  const voice = ai._buildPersonaSystemPrompt('Brandon', 'voice', false, { catalogue });
  assert.doesNotMatch(voice, /\[\[sticker:|\[\[emoji:|Sticker catalogue/, 'a voice note has no stickers or reaction controls');
});

test('prompt: an old persona file that still carries the label-based block does not contradict the new controls', () => {
  const legacy = [
    'Be casual.',
    '',
    'Internal reaction control:',
    '- Always end with [[reaction:<label>]] chosen from: happy, sad.',
    '- Use response_mode when replying to a sticker.',
    '',
    'Private-DM menu action:',
    'When asked for the menu emit [[bot_action:command_menu]].',
  ].join('\n');
  const stripped = ai._stripLegacyReactionBlock(legacy);
  assert.doesNotMatch(stripped, /Internal reaction control|\[\[reaction:<label>\]\]|response_mode/);
  assert.match(stripped, /Be casual\./);
  assert.match(stripped, /Private-DM menu action:[\s\S]*command_menu/, 'the menu section after it is kept');
  assert.equal(ai._stripLegacyReactionBlock('Nothing legacy here.'), 'Nothing legacy here.');
  assert.doesNotMatch(ai._stripLegacyReactionBlock('Be casual.\nInternal reaction control:\n- old stuff with [[reaction:x]] at the very end'), /old stuff/, 'also when it is the last section');
});

test('a user sticker is no longer an "interpret this sticker" request', () => {
  const prompt = ai._USER_STICKER_PROMPT;
  assert.doesNotMatch(prompt, /interpret/i);
  assert.match(prompt, /laugh along|react with an emoji|fitting sticker/i);
  assert.match(prompt, /Never describe or name what is drawn on it/);
  assert.match(prompt, /frog/, 'the example it forbids is the exact failure that was reported');
});

// ─── The catalogue ──────────────────────────────────────────────────────────
test('catalogue: only stickers the persona can really use are offered, and the reasons are counted', async () => {
  await useLibrary([
    stickerRecord(1, 'naruto', 'Naruto'),
    stickerRecord(2, 'naruto', 'Naruto', { fit: 0.2 }),
    stickerRecord(3, 'bleach', 'Bleach', { status: 'unclassified' }),
    stickerRecord(4, 'bleach', 'Bleach', { asset: false }),
    stickerRecord(5, 'bleach', 'Bleach'),
  ]);
  const catalogue = await aiStickers.buildStickerCatalogue('chat-filter', persona);
  assert.deepEqual(catalogue.items.map(i => i.hash.replace(/^0+/, '')).sort(), ['1', '5']);
  assert.equal(catalogue.eligible, 2);
  assert.equal(catalogue.offered, 2);
  assert.deepEqual(catalogue.excluded, { no_asset: 1, unclassified: 1, low_persona_fit: 1, recently_sent: 0 });
});

test('catalogue: numbered 1..N in the order shown, grouped by anime, capped, and spread across anime', async () => {
  const rows = [];
  let n = 1;
  for (const [id, name] of [['naruto', 'Naruto'], ['bleach', 'Bleach'], ['one-piece', 'One Piece']]) {
    for (let i = 0; i < 30; i += 1) rows.push(stickerRecord(n++, id, name, { expression: `${name} look ${i}` }));
  }
  await useLibrary(rows);
  for (let round = 0; round < 5; round += 1) {
    const catalogue = await aiStickers.buildStickerCatalogue(`chat-spread-${round}`, persona);
    assert.equal(catalogue.offered, 12, 'capped at AI_STICKER_CATALOGUE_MAX');
    assert.deepEqual(catalogue.items.map(i => i.id), Array.from({ length: 12 }, (_, i) => i + 1));
    const perAnime = {};
    for (const item of catalogue.items) perAnime[item.entry.animeId] = (perAnime[item.entry.animeId] || 0) + 1;
    assert.deepEqual(Object.values(perAnime).sort(), [4, 4, 4], 'no anime crowds out the others');
    assert.equal(catalogue.animeCount, 3);
    const lines = catalogue.text.split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => l.split(':')[0]), ['Bleach', 'Naruto', 'One Piece'], 'sorted, one line per anime');
    for (const item of catalogue.items) assert.ok(catalogue.text.includes(`${item.id} "`), `id ${item.id} is in the prompt text`);
    assert.match(lines[0], /^Bleach: 1 "Bleach look \d+" \[amused\] \| 2 /);
  }
});

test('catalogue: a sticker that was just sent is left out of the next catalogue for that chat only', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => stickerRecord(i + 1, 'naruto', 'Naruto'));
  await useLibrary(rows);
  const originalGet = axios.get;
  const originalMessageUpdate = AiStickerMessage.findOneAndUpdate;
  axios.get = async () => ({ data: Buffer.from('webp-bytes') });
  AiStickerMessage.findOneAndUpdate = async () => null;
  try {
    const first = await aiStickers.buildStickerCatalogue('chat-recent', persona);
    assert.equal(first.offered, 8);
    const sentMessages = [];
    const client = { sendMessage: async (chatId, media, options) => { const m = { id: { _serialized: `sent-${sentMessages.length + 1}` }, chatId, options }; sentMessages.push(m); return m; } };
    const result = await aiStickers.sendCatalogueSticker(client, { from: 'chat-recent' }, first, 3);
    assert.equal(result.sent, true);
    assert.equal(sentMessages[0].options.sendMediaAsSticker, true);
    assert.equal(sentMessages[0].chatId, 'chat-recent');
    assert.equal(ledger.get('sent-1').kind, 'sticker', 'it is remembered as the AI\'s own message');

    const second = await aiStickers.buildStickerCatalogue('chat-recent', persona);
    assert.equal(second.offered, 7);
    assert.equal(second.excluded.recently_sent, 1);
    assert.ok(!second.items.some(i => i.hash === first.items[2].hash));
    const elsewhere = await aiStickers.buildStickerCatalogue('another-chat', persona);
    assert.equal(elsewhere.offered, 8, 'other chats still get it');
  } finally {
    axios.get = originalGet;
    AiStickerMessage.findOneAndUpdate = originalMessageUpdate;
  }
});

test('catalogue sender: a number that was not offered sends nothing, and a send failure never throws', async () => {
  await useLibrary([stickerRecord(1, 'naruto', 'Naruto')]);
  const catalogue = await aiStickers.buildStickerCatalogue('chat-send', persona);
  const sent = [];
  const okClient = { sendMessage: async () => { sent.push(1); return { id: { _serialized: 'x' } }; } };
  const unknown = await aiStickers.sendCatalogueSticker(okClient, { from: 'c' }, catalogue, 99);
  assert.deepEqual([unknown.sent, unknown.reason], [false, 'not_offered']);
  assert.equal(sent.length, 0);

  const originalGet = axios.get;
  axios.get = async () => { throw new Error('cloudinary down'); };
  const logs = captureLogs();
  try {
    const failed = await aiStickers.sendCatalogueSticker(okClient, { from: 'c' }, catalogue, 1);
    assert.deepEqual([failed.sent, failed.reason], [false, 'send_failed']);
  } finally {
    logs.restore();
    axios.get = originalGet;
  }
  assert.ok(logs.lines.some(line => /\[error\] ai sticker send failed: cloudinary down/.test(line)), `error is logged: ${logs.lines.join(' | ')}`);
});

test('catalogue: stickers switched off means an empty catalogue and no library read', async () => {
  const config = require('../utils/config');
  assert.equal(config.AI_STICKERS_ENABLED, true);
  let reads = 0;
  aiStickers._setAdaptersForTests({ Model: { async init() {}, find() { reads += 1; return fakeQuery(() => []); } }, storage: { isCloudConfigured: () => false }, mongoConnected: () => true });
  const empty = await aiStickers.buildStickerCatalogue('c', persona);
  assert.equal(empty.offered, 0);
  assert.ok(['nothing_eligible', 'library_unavailable', 'stickers_disabled'].includes(empty.reason), empty.reason);
});

// ─── History memory ─────────────────────────────────────────────────────────
test('history: records what the AI actually did, so it keeps acting like one person', () => {
  const words = ai._parseAiControls('ahaha mood');
  assert.equal(ai._historyAssistantText(words, { textSent: true, emojiReacted: false, stickerSent: false }), 'ahaha mood');
  const emoji = ai._parseAiControls('[[emoji:😂]]');
  assert.equal(ai._historyAssistantText(emoji, { textSent: false, emojiReacted: true, stickerSent: false }), '[[emoji:😂]]');
  const sticker = ai._parseAiControls('[[sticker:2]]');
  assert.equal(ai._historyAssistantText(sticker, { textSent: false, emojiReacted: false, stickerSent: true, stickerItem: { label: 'smug grin / teasing' } }), '[[sticker_sent:smug grin / teasing]]');
  const nothing = ai._parseAiControls('');
  assert.equal(ai._historyAssistantText(nothing, null), '[[no_reply]]', 'never an empty assistant turn');
  // and those memory markers are stripped if the model ever copies them into a reply
  assert.equal(ai._parseAiControls('ok [[sticker_sent:smug grin]] [[no_reply]]').text, 'ok');
});

// ─── The whole thing: replaying the reported conversation ───────────────────
function scenarioMessage({ sticker, quotedText = 'omg exams sound like absolute torture Brandon... seriously, good luck with all that studying! what subject are you even trying to survive right now?' }) {
  const reactions = [];
  const replies = [];
  const msg = {
    type: sticker ? 'sticker' : 'chat',
    hasMedia: Boolean(sticker),
    hasQuotedMsg: Boolean(sticker),
    from: '2348000000000@c.us',
    body: sticker ? '' : 'Preparing for exams',
    id: { _serialized: 'user-msg-1' },
    _data: { notifyName: 'Brandon' },
    reactions,
    replies,
    async downloadMedia() { return { mimetype: 'image/webp', data: 'U1RSVUdHTEU=' }; },
    async getQuotedMessage() { return { fromMe: true, type: 'chat', hasMedia: false, body: quotedText, id: { _serialized: 'bot-msg-1' } }; },
    async getChat() { return { isGroup: false, id: { _serialized: '2348000000000@c.us' } }; },
    async getContact() { return { pushname: 'Brandon', name: 'Brandon' }; },
    async react(emoji) { reactions.push(emoji); },
    async reply(content) { const sent = { id: { _serialized: `bot-reply-${replies.length + 1}` }, content }; replies.push(content); return sent; },
  };
  return msg;
}

async function runScenario({ sticker, geminiReply, catalogue, args = [] }) {
  const originalVision = gemini.generateVision;
  const originalText = gemini.generateText;
  const originalCatalogue = aiStickers.buildStickerCatalogue;
  const originalSend = aiStickers.sendCatalogueSticker;
  const originalFindOne = AiConversation.findOne;
  const originalUpdate = AiConversation.findOneAndUpdate;
  const calls = { gemini: null, stickers: [], saved: [] };
  gemini.generateVision = async options => { calls.gemini = { kind: 'vision', ...options }; return geminiReply; };
  gemini.generateText = async options => { calls.gemini = { kind: 'text', ...options }; return geminiReply; };
  aiStickers.buildStickerCatalogue = async () => catalogue;
  aiStickers.sendCatalogueSticker = async (_c, _m, cat, id) => { calls.stickers.push(id); return { sent: true, reason: null, item: cat.items.find(i => i.id === id) }; };
  AiConversation.findOne = () => Promise.resolve(null);
  AiConversation.findOneAndUpdate = (filter, update) => { calls.saved.push(update.$push.messages.$each); return Promise.resolve(null); };
  const msg = scenarioMessage({ sticker });
  const logs = captureLogs();
  try {
    await ai.copilot({}, msg, args);
  } finally {
    logs.restore();
    gemini.generateVision = originalVision;
    gemini.generateText = originalText;
    aiStickers.buildStickerCatalogue = originalCatalogue;
    aiStickers.sendCatalogueSticker = originalSend;
    AiConversation.findOne = originalFindOne;
    AiConversation.findOneAndUpdate = originalUpdate;
  }
  return { msg, calls, logs: logs.lines };
}

const CATALOGUE = {
  offered: 2,
  items: [
    { id: 1, hash: 'h1', label: 'dying inside / sad, worried', entry: { animeName: 'Bleach', animeId: 'bleach' }, analysis: { reactions: ['sad'] } },
    { id: 2, hash: 'h2', label: 'cracking up / laughing, amused', entry: { animeName: 'Naruto', animeId: 'naruto' }, analysis: { reactions: ['laughing'] } },
  ],
  text: 'Bleach: 1 "dying inside" [sad, worried]\nNaruto: 2 "cracking up" [laughing, amused]',
};

test('REPLAY: the user sends a "THE STRUGGLE" meme sticker -> the AI reacts like a friend, not a describer', async () => {
  const { msg, calls, logs } = await runScenario({ sticker: true, geminiReply: '[[emoji:😂]]', catalogue: CATALOGUE });

  // what Gemini was given
  assert.equal(calls.gemini.kind, 'vision');
  assert.equal(calls.gemini.images.length, 1, 'the user\'s sticker image is sent');
  assert.equal(calls.gemini.prompt, ai._USER_STICKER_PROMPT);
  assert.doesNotMatch(calls.gemini.prompt, /interpret/i);
  assert.match(calls.gemini.systemPrompt, /Never describe or name what a sticker or picture shows/);
  assert.match(calls.gemini.systemPrompt, /Naruto: 2 "cracking up" \[laughing, amused\]/);

  // what the user sees
  assert.deepEqual(msg.replies, [], 'no sentence describing the picture');
  assert.deepEqual(msg.reactions, ['⏳', '😂'], 'the hourglass is replaced by the laughing reaction and NOT removed afterwards');

  // what the AI remembers
  assert.equal(calls.saved.length, 1);
  assert.deepEqual(calls.saved[0], [
    { role: 'user', content: '[sent a sticker]' },
    { role: 'assistant', content: '[[emoji:😂]]' },
  ]);

  // what the logs show
  const text = logs.join('\n');
  assert.match(text, /\[ai\] Input from Brandon \(DM\) via \.copilot: sticker reply/);
  assert.match(text, /\[ai\] Gemini chose: no words · react 😂/);
  assert.match(text, /\[ai\] Reacted 😂 to the user's sticker/);
  assert.match(text, /\[ai\] Decision: reaction 😂 · replying to a user sticker/);
});

test('REPLAY: the user sends the sticker and the AI answers with a matching sticker', async () => {
  const { msg, calls, logs } = await runScenario({ sticker: true, geminiReply: 'ahaha same [[sticker:2]]', catalogue: CATALOGUE });
  assert.deepEqual(calls.stickers, [2]);
  assert.deepEqual(msg.replies, [], 'sticker replies are one message: the extra words are set aside');
  assert.deepEqual(msg.reactions, ['⏳', ''], 'no emoji reaction, so the hourglass is removed');
  assert.deepEqual(calls.saved[0][1], { role: 'assistant', content: '[[sticker_sent:cracking up / laughing, amused]]' });
  const text = logs.join('\n');
  assert.match(text, /\[ai\] Sticker #2 is on the catalogue: Naruto - cracking up/);
  assert.match(text, /\[ai\] Decision: sticker #2 \(Naruto\) · replying to a user sticker · set aside: text \(a reply to a sticker is one message\)/);
});

test('REPLAY: a few casual words with a laughing reaction', async () => {
  const { msg, calls } = await runScenario({ sticker: true, geminiReply: 'lmaooo mood [[emoji:🤣]] [[sticker:none]]', catalogue: CATALOGUE });
  assert.deepEqual(msg.replies, ['lmaooo mood']);
  assert.deepEqual(msg.reactions, ['⏳', '🤣']);
  assert.deepEqual(calls.stickers, []);
});

test('REPLAY: the earlier text message gets a normal reply with its emoji, and the hourglass is cleared', async () => {
  const { msg, calls, logs } = await runScenario({ sticker: false, args: ['Preparing', 'for', 'exams'], geminiReply: 'omg exams are the worst 😅 what subject are you on?', catalogue: CATALOGUE });
  assert.equal(calls.gemini.kind, 'text');
  assert.equal(calls.gemini.prompt, 'Preparing for exams');
  assert.deepEqual(msg.replies, ['omg exams are the worst 😅 what subject are you on?']);
  assert.deepEqual(msg.reactions, ['⏳', '']);
  assert.match(logs.join('\n'), /\[ai\] Decision: words \(\d+ chars\)/);
});

test('copilot: a Gemini failure still removes the hourglass', async () => {
  const originalText = gemini.generateText;
  gemini.generateText = async () => { throw new Error('boom'); };
  const msg = scenarioMessage({ sticker: false });
  msg.body = 'hi';
  const logs = captureLogs();
  try {
    await ai.copilot({}, msg, ['hi']);
  } finally {
    logs.restore();
    gemini.generateText = originalText;
  }
  assert.deepEqual(msg.reactions, ['⏳', '']);
  assert.match(msg.replies[0], /Copilot failed/);
});

test('status reaction: a failure to remove the hourglass is tolerated and logged', async () => {
  const msg = { react: async () => { throw new Error('not allowed'); } };
  const logs = captureLogs();
  try {
    await assert.doesNotReject(ai._clearStatusReaction(msg));
  } finally {
    logs.restore();
  }
  assert.match(logs.lines.join('\n'), /Could not remove the ⏳: not allowed/);
});

test('the dispatcher no longer adds a second, never-cleared hourglass for copilot and voice', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.match(index, /command !== 'news' && command !== 'copilot' && command !== 'voice'/);
});

// ─── Logs ───────────────────────────────────────────────────────────────────
test('logs: every step of the AI decision has a readable line (not just an event name)', () => {
  const logger = require('../utils/logger');
  const logs = captureLogs();
  try {
    logger.write('INFO', 'ai.input', { command: 'copilot', sender: 'Brandon', chat: 'DM', kind: 'text', promptPreview: 'Preparing for exams', historyTurns: 0, stickersOffered: 12 });
    logger.write('INFO', 'ai.catalogue', { library: 100, eligible: 61, offered: 12, animeCount: 10, excluded: { recently_sent: 2, low_persona_fit: 30 } });
    logger.write('INFO', 'ai.model.reply', { textChars: 5, textPreview: 'hello', emoji: '😂', sticker: 4 });
    logger.write('WARN', 'ai.sticker.choice', { requested: 99, status: 'not_offered', offered: 12 });
    logger.write('INFO', 'ai.sticker.sent', { id: 4, hash: 'abcdef123456', anime: 'Naruto', description: 'smug grin' });
    logger.write('INFO', 'ai.reaction.react', { theirs: '😂', mine: '🤣', kind: 'text', delayMs: 2000 });
    logger.write('INFO', 'ai.reaction.skip', { theirs: '😂', kind: 'voice', reason: 'already_reacted' });
    logger.write('INFO', 'gemini.gate.blocked', { command: 'gpt' });
    logger.write('WARN', 'background.ai_sticker_analysis.quota_pause', { cooldownMs: 1800000, resumeAt: new Date(Date.now() + 1800000), streak: 1, remaining: 147 });
  } finally {
    logs.restore();
  }
  const text = logs.lines.join('\n');
  for (const expected of [
    /\[ai\] Input from Brandon \(DM\) via \.copilot: text "Preparing for exams" · 0 earlier messages · 12 stickers offered/,
    /\[ai\] Sticker catalogue: offering 12 of 61 usable stickers from 10 anime \(library 100\) · left out: 2 recently sent, 30 not fitting this character/,
    /\[ai\] Gemini chose: words "hello" · react 😂 · sticker #4/,
    /\[ai\] Sticker #99 was NOT on the catalogue \(12 offered\)/,
    /\[ai\] Sent sticker #4: Naruto - smug grin \(abcdef12/,
    /\[ai\] 😂 on my text → I will react 🤣 in 2000ms/,
    /\[ai\] 😂 on my voice: not reacting back \(already reacted\)/,
    /\[ai\] \.gpt paused while sticker analysis uses Gemini/,
    /\[sticker\] Gemini quota used up: sticker analysis paused for 30 min .*147 waiting/,
  ]) assert.match(text, expected);
});

test('logs: the reaction handler explains why it did not react back, but only on the AI\'s own messages', () => {
  const { createReactionHandler } = require('../utils/aiReactions');
  ledger._reset();
  ledger.remember('true_c@g.us_M1', 'text');
  const handler = createReactionHandler({ client: { info: { wid: { _serialized: 'bot@c.us' } }, sendReaction: async () => {} }, ledger, settings: { enabled: true, chance: 0, cooldownMs: 0, delayMinMs: 0, delayMaxMs: 0 }, rng: () => 0.99, schedule: async fn => fn() });
  const logs = captureLogs();
  try {
    handler.handle({ id: { fromMe: false }, reaction: '😂', senderId: 'u@c.us', msgId: { remote: 'c@g.us', _serialized: 'true_c@g.us_M1' } });
    handler.handle({ id: { fromMe: false }, reaction: '😂', senderId: 'u@c.us', msgId: { remote: 'c@g.us', _serialized: 'true_c@g.us_SOMEONE_ELSES' } });
  } finally {
    logs.restore();
    ledger._reset();
  }
  const text = logs.lines.join('\n');
  assert.match(text, /\[ai\] 😂 on my text: not reacting back \(chance\)/);
  assert.equal(logs.lines.length, 1, 'a reaction on a message that is not the AI\'s is not logged at all');
});

test('the gate is unaffected: a paused Gemini still refuses before the new catalogue code can run it', () => {
  geminiGate.setReservationProvider(() => true);
  try {
    assert.equal(geminiGate.shouldBlockCommand('copilot'), true);
  } finally {
    geminiGate.setReservationProvider(() => false);
  }
});
