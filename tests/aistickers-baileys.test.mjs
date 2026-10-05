// Run with:  node --test tests/aistickers-baileys.test.mjs
// Drives the real Baileys adapter (messages / identity / socket wrapper) with a
// fake socket, an in-memory sticker "database" and a fake Cloudinary. Nothing
// here touches WhatsApp, MongoDB, Cloudinary or Gemini.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.AI_PERSONA = 'marin';
process.env.AI_STICKERS_ENABLED = 'true';
process.env.AI_STICKER_AUTO_ANALYZE = 'false';
process.env.OWNER_NUMBER = '2348000000001';
process.env.LOG_LEVEL = 'INFO'; // what the real .env uses; pino must not choke on it
process.env.CLOUDINARY_URL = 'cloudinary://test:test@test-cloud';
delete process.env.GEMINI_API_KEY;

const mongoose = (await import('mongoose')).default;
mongoose.set('bufferCommands', false); // fail fast instead of waiting 10s for a DB that is not there

const config = await import('../src/utils/config.js');
const helpers = await import('../src/utils/helpers.js');
const aiStickers = (await import('../src/utils/aiStickers.js')).default;
const namedImport = await import('../src/utils/aiStickers.js');
const ledger = (await import('../src/utils/aiMessageLedger.js')).default;
const { loadPersona } = await import('../src/utils/persona.js');
const gemini = (await import('../src/utils/gemini.js')).default;
const geminiGate = (await import('../src/utils/geminiGate.js')).default;
const socketManager = (await import('../src/whatsapp/socket.js')).default;
const wa = (await import('../src/whatsapp/index.js')).default;
const { MessageMedia } = await import('../src/whatsapp/media.js');
const axios = (await import('axios')).default;

// ── fakes ───────────────────────────────────────────────────────────────────
function fakeQuery(resolve) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(resolve()); },
    then(a, b) { return this.exec().then(a, b); },
  };
}
const clone = v => (v == null ? v : structuredClone(v));
function makeMemoryModel() {
  const records = new Map();
  const keyOf = ({ personaId, hash }) => `${personaId}:${hash}`;
  const matches = (doc, filter = {}) => !!doc && Object.entries(filter).every(([k, v]) => doc[k] === v);
  return {
    records,
    async init() {},
    find(filter = {}) { return fakeQuery(() => [...records.values()].filter(d => matches(d, filter)).map(clone)); },
    findOne(filter) { return fakeQuery(() => clone([...records.values()].find(d => matches(d, filter)) || null)); },
    findOneAndUpdate(filter, update, options = {}) {
      return fakeQuery(() => {
        const key = keyOf(filter);
        let doc = records.get(key);
        if (!doc && !options.upsert) return null;
        if (!doc) doc = { ...filter, ...(update.$setOnInsert || {}), createdAt: new Date(), importedAt: new Date() };
        Object.assign(doc, update.$set || {});
        records.set(key, doc);
        return clone(doc);
      });
    },
  };
}
const memoryModel = makeMemoryModel();
const uploads = [];
const cloudinaryMock = {
  isCloudConfigured: () => true,
  async uploadBufferToCloud(bytes, options) {
    uploads.push({ bytes: Buffer.from(bytes), options });
    return { url: `https://res.cloudinary.com/test/image/upload/v1/${options.folder}/${options.publicId}.webp`, publicId: `${options.folder}/${options.publicId}`, version: 1 };
  },
};
aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });

const sentLog = [];
const fakeSock = {
  user: { id: '2349999999999:7@s.whatsapp.net' },
  async sendMessage(jid, payload, opts) {
    sentLog.push({ jid, payload, opts });
    return { key: { id: `SENT${sentLog.length}`, remoteJid: jid, fromMe: true } };
  },
  async groupMetadata(jid) { return { id: jid, subject: 'Test group', participants: [] }; },
};
wa.messages.init(fakeSock);
wa.identity.init(fakeSock);
socketManager.sock = fakeSock;

const OWNER = '2348000000001@s.whatsapp.net';
const STRANGER = '2348111111111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const webp = Buffer.from('RIFF....WEBPVP8 fixture-bytes');
const webpHash = crypto.createHash('sha256').update(webp).digest('hex');

function incoming({ chat, sender, kind = 'text', text = '' }) {
  const isGroup = chat.endsWith('@g.us');
  const message = kind === 'sticker'
    ? { stickerMessage: { mimetype: 'image/webp', mediaKey: Buffer.alloc(32), directPath: '/x', url: 'https://mmg.whatsapp.net/x' } }
    : { conversation: text };
  const normalized = socketManager.normalizeMessage({
    key: { remoteJid: chat, id: `IN${Math.random().toString(36).slice(2, 8)}`, fromMe: false, ...(isGroup ? { participant: sender } : {}) },
    message,
    pushName: 'Tester',
  });
  // stickers cannot really be downloaded here; hand back what Baileys would return
  if (kind === 'sticker') normalized.downloadMedia = async () => new MessageMedia('image/webp', webp, 'sticker.webp');
  return normalized;
}
const lastSent = () => sentLog[sentLog.length - 1];

// ── config / launch blockers ────────────────────────────────────────────────
test('LOG_LEVEL=INFO from .env no longer crashes pino; Baileys stays silent', () => {
  assert.equal(config.WHATSAPP_LOG_LEVEL, 'silent');
});

test('new config values exist', () => {
  assert.equal(typeof config.AI_STICKER_FIT_BATCH, 'number');
  assert.equal(typeof config.AI_STICKER_VISION_BATCH, 'number');
});

test('helpers export resolveNameById and generateUniqueCode', () => {
  assert.equal(typeof helpers.resolveNameById, 'function');
  assert.equal(typeof helpers.generateUniqueCode, 'function');
});

test('resolveNameById: identity name, then number, never throws', async () => {
  wa.identity.rememberContact(STRANGER, 'Ada');
  assert.equal(await helpers.resolveNameById(wa, STRANGER), 'Ada');
  assert.equal(await helpers.resolveNameById(wa, '2347000000000@s.whatsapp.net'), '2347000000000');
  assert.equal(await helpers.resolveNameById(wa, ''), 'Unknown');
  assert.equal(await helpers.resolveNameById({ getContactById() { throw new Error('boom'); } }, '234700@s.whatsapp.net'), '234700');
});

test('generateUniqueCode retries on collision and uses the unambiguous alphabet', async () => {
  let calls = 0;
  const code = await helpers.generateUniqueCode({ async findOne() { calls += 1; return calls < 3 ? { code: 'x' } : null; } });
  assert.equal(calls, 3);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
});

test('msg.downloadMedia() reaches Baileys (argument order fixed)', async () => {
  const real = socketManager.normalizeMessage({
    key: { remoteJid: OWNER, id: 'DL1', fromMe: false },
    message: { stickerMessage: { mimetype: 'image/webp', mediaKey: Buffer.alloc(32), directPath: '/x', url: 'https://mmg.whatsapp.net/x' } },
  });
  await assert.rejects(() => real.downloadMedia(), err => {
    assert.doesNotMatch(err.message, /No Baileys message payload is available/);
    return true;
  });
});

test('msg.getChat() works for groups (was calling a method that does not exist)', async () => {
  const msg = incoming({ chat: GROUP, sender: STRANGER, text: 'hi' });
  const chat = await msg.getChat();
  assert.equal(chat.isGroup, true);
  assert.equal(chat.id._serialized, GROUP);
});

// ── module surface ──────────────────────────────────────────────────────────
test('aiStickers exposes everything the callers use', () => {
  for (const name of ['startImportMode', 'stopImportMode', 'handleIncomingSticker', 'sendReactionSticker',
    'buildStickerCatalogue', 'sendCatalogueSticker', 'analyzeCommand', 'initialize',
    'getSentStickerContext', 'getAvailablePersonas']) {
    assert.equal(typeof aiStickers[name], 'function', name);
  }
  assert.ok(aiStickers.ALLOWED_REACTIONS.has('amused'));
  assert.equal(namedImport.aiStickers, aiStickers);
});

test('getAvailablePersonas lists the real persona folders', async () => {
  const list = await aiStickers.getAvailablePersonas();
  assert.ok(list.length >= 3);
  assert.ok(list.some(p => p.id === 'marin' && p.displayName));
});

// ── import flow ─────────────────────────────────────────────────────────────
test('import mode: owner DM only; group and strangers are ignored', async () => {
  const stranger = incoming({ chat: STRANGER, sender: STRANGER, kind: 'sticker' });
  assert.equal(await aiStickers.handleIncomingSticker(wa, stranger), false);
  const ownerInGroup = incoming({ chat: GROUP, sender: OWNER, kind: 'sticker' });
  assert.equal(await aiStickers.handleIncomingSticker(wa, ownerInGroup), false);

  const strangerStart = incoming({ chat: STRANGER, sender: STRANGER, text: '.stickerimport' });
  assert.equal(await aiStickers.startImportMode(wa, strangerStart), false);
  assert.match(lastSent().payload.text, /only to the bot owner/);
});

test('import mode: owner imports a sticker once, duplicate is detected', async () => {
  const start = incoming({ chat: OWNER, sender: OWNER, text: '.stickerimport' });
  assert.equal(await aiStickers.startImportMode(wa, start), true);
  assert.match(lastSent().payload.text, /import mode enabled/);

  const first = incoming({ chat: OWNER, sender: OWNER, kind: 'sticker' });
  assert.equal(await aiStickers.handleIncomingSticker(wa, first), true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].options.publicId, webpHash);
  assert.match(lastSent().payload.text, /saved to the shared AI sticker library/);
  assert.equal(lastSent().jid, OWNER);

  const again = incoming({ chat: OWNER, sender: OWNER, kind: 'sticker' });
  assert.equal(await aiStickers.handleIncomingSticker(wa, again), true);
  assert.equal(uploads.length, 1, 'duplicate must not upload again');
  assert.match(lastSent().payload.text, /already in the shared/);

  const stop = incoming({ chat: OWNER, sender: OWNER, text: '.stickerimport off' });
  assert.equal(await aiStickers.stopImportMode(stop), true);
  const afterStop = incoming({ chat: OWNER, sender: OWNER, kind: 'sticker' });
  assert.equal(await aiStickers.handleIncomingSticker(wa, afterStop), false, 'no session after off');
});

// ── catalogue + sending ─────────────────────────────────────────────────────
test('catalogue offers a classified sticker and sending goes to the GROUP, as a sticker', async () => {
  const persona = loadPersona('marin');
  memoryModel.records.clear();
  memoryModel.records.set(`shared:${webpHash}`, {
    personaId: 'shared', hash: webpHash, animeId: 'naruto', animeName: 'Naruto',
    cloudinaryUrl: 'https://res.cloudinary.com/test/x.webp', cloudinaryPublicId: 'ai-stickers/shared/x',
    genericAnalysis: { expression: 'laughing hard', emotions: ['happy'], moods: [], uses: [], reactions: ['amused'] },
    personaAnalyses: [{ personaId: 'marin', analysisStatus: 'classified', reactions: ['amused'], emotions: ['happy'], moods: [], uses: [], intensity: 'medium', personaFit: 0.9 }],
  });
  aiStickers._setAdaptersForTests({ Model: memoryModel, storage: cloudinaryMock, mongoConnected: () => true });

  const realGet = axios.get;
  axios.get = async () => ({ data: webp });
  try {
    const catalogue = await aiStickers.buildStickerCatalogue(GROUP, persona);
    assert.equal(catalogue.items.length, 1);
    assert.match(catalogue.text, /Naruto/);

    const msg = incoming({ chat: GROUP, sender: STRANGER, text: 'lol' });
    assert.equal(msg.from, GROUP, 'sanity: in a group msg.from is the chat (whatsapp-web.js meaning)');
    assert.equal(msg.author, '2348111111111@c.us', 'and msg.author is the sender');
    const before = sentLog.length;
    const result = await aiStickers.sendCatalogueSticker(wa, msg, catalogue, 1, { persona });
    assert.equal(result.sent, true, JSON.stringify(result.error?.message));
    assert.equal(sentLog.length, before + 1);
    const out = lastSent();
    assert.equal(out.jid, GROUP, 'must be sent to the group, not to the sender');
    assert.ok(Buffer.isBuffer(out.payload.sticker), 'must be a sticker payload');
    assert.deepEqual(out.payload.sticker, webp);
    assert.equal(out.payload.image, undefined);
    assert.equal(ledger.isAIBotMessage({ id: { _serialized: `SENT${sentLog.length}` } }), true, 'sent sticker is remembered');

    const missing = await aiStickers.sendCatalogueSticker(wa, msg, catalogue, 99, { persona });
    assert.equal(missing.reason, 'not_offered');
  } finally {
    axios.get = realGet;
  }
});

test('sendReactionSticker uses the chat, not the sender', async () => {
  const realGet = axios.get;
  axios.get = async () => ({ data: webp });
  try {
    const msg = incoming({ chat: GROUP, sender: STRANGER, text: 'haha' });
    const before = sentLog.length;
    const ok = await aiStickers.sendReactionSticker(wa, msg, 'amused');
    assert.equal(ok, true);
    assert.equal(sentLog.length, before + 1);
    assert.equal(lastSent().jid, GROUP);
  } finally {
    axios.get = realGet;
  }
});

// ── Gemini reservation ──────────────────────────────────────────────────────
test('generateText honours bypassGate; others are blocked while analysis reserves Gemini', async () => {
  geminiGate.setReservationProvider(() => true);
  try {
    await assert.rejects(() => gemini.generateText({ prompt: 'x' }), err => err.code === 'GEMINI_BUSY');
    await assert.rejects(() => gemini.generateText({ prompt: 'x', bypassGate: true }), err => err.code !== 'GEMINI_BUSY');
  } finally {
    geminiGate.setReservationProvider(() => false);
  }
});

test('analyzeCommand is owner-DM only and shows status', async () => {
  const stranger = incoming({ chat: STRANGER, sender: STRANGER, text: '.stickeranalyze' });
  assert.equal(await aiStickers.analyzeCommand(wa, stranger, []), false);
  assert.match(lastSent().payload.text, /only to the bot owner/);

  const owner = incoming({ chat: OWNER, sender: OWNER, text: '.stickeranalyze' });
  assert.equal(await aiStickers.analyzeCommand(wa, owner, []), true);
  assert.match(lastSent().payload.text, /Sticker analysis/);
});

// ── reactions to AI messages ────────────────────────────────────────────────
test('ledger understands Baileys sent messages; reaction handler no longer throws', async () => {
  const { createReactionHandler } = await import('../src/utils/aiReactions.js');
  ledger._reset();
  assert.equal(ledger.remember({ key: { id: 'ABC1', remoteJid: OWNER, fromMe: true } }, 'text', 'marin'), true);
  assert.equal(ledger.isAIBotMessage({ id: { _serialized: 'ABC1' } }), true);
  assert.equal(ledger.get({ id: 'ABC1', remoteJid: OWNER }).kind, 'text');
  assert.equal(ledger.get('nope'), null);

  const reacted = [];
  const client = { info: { wid: { _serialized: '2349999999999@s.whatsapp.net' } }, async react(key, emoji) { reacted.push({ key, emoji }); } };
  const handler = createReactionHandler({ client, settings: { chance: 1, cooldownMs: 0, delayMinMs: 0, delayMaxMs: 0 } });
  const reaction = { key: { id: 'ABC1', remoteJid: OWNER, fromMe: true }, reaction: { key: { remoteJid: OWNER, fromMe: false }, text: '😂' } };
  const first = handler.handle(reaction);
  assert.equal(first.action, 'react');
  await first.done;
  assert.equal(reacted.length, 1);
  assert.equal(handler.handle(reaction).reason, 'already_reacted');
  const foreign = { key: { id: 'NOT_MINE', remoteJid: OWNER }, reaction: { key: { remoteJid: OWNER, fromMe: false }, text: '😂' } };
  assert.equal(handler.handle(foreign).reason, 'not_ai_message');
});

test('a sticker the AI sent is recognised when someone reacts to it', async () => {
  ledger._reset();
  const realGet = axios.get;
  axios.get = async () => ({ data: webp });
  try {
    const msg = incoming({ chat: OWNER, sender: OWNER, text: 'haha' });
    assert.equal(await aiStickers.sendReactionSticker(wa, msg, 'amused'), true);
    assert.equal(ledger.get({ id: lastSent() && `SENT${sentLog.length}` })?.kind, 'sticker');
  } finally {
    axios.get = realGet;
  }
});

test.after(() => {
  for (const session of aiStickers._getImportSessions().values()) if (session.timer) clearTimeout(session.timer);
  setTimeout(() => process.exit(0), 50).unref?.();
});
