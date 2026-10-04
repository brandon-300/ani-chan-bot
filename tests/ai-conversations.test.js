const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.AI_PERSONA = 'marin';
process.env.OWNER_NUMBER = 'owner@c.us';
process.env.OWNER_IDS = 'owner-lid@lid';
for (const name of ['AI_HISTORY_EXPIRY_DAYS', 'AI_HISTORY_EXPIRY_SCOPE', 'AI_HISTORY_MESSAGES', 'AI_HISTORY_OWNER_KEPT', 'AI_HISTORY_OWNER_CONTEXT']) delete process.env[name];

const AiConversation = require('../models/AiConversation');
const conversations = require('../utils/aiConversations');
const ai = require('../commands/ai');
const { install } = require('./helpers/fakeConversationStore');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function withStore(fn) {
  return async () => {
    const store = install();
    let now = T0;
    conversations._setClock(() => now);
    const time = { set: value => { now = value; }, advance: ms => { now += ms; }, get now() { return now; } };
    try {
      await fn(store, time);
    } finally {
      store.restore();
      conversations._setClock();
    }
  };
}

const turn = (chatId, senderId, personaId, user, assistant) => conversations.appendConversationTurn({ chatId, senderId, personaId, userContent: user, assistantContent: assistant });
const history = (chatId, senderId, personaId) => conversations.getConversationHistory({ chatId, senderId, personaId });

// ─── The database definition ────────────────────────────────────────────────
test('schema: unique per chat+sender+persona, a TTL index on expiresAt, and expiresAt optional', () => {
  const indexes = AiConversation.schema.indexes();
  const unique = indexes.find(([fields]) => fields.chatId === 1 && fields.senderId === 1 && fields.personaId === 1);
  assert.ok(unique && unique[1].unique === true, 'unique (chatId, senderId, personaId)');
  assert.ok(!indexes.some(([fields, options]) => fields.chatId === 1 && fields.senderId === 1 && !fields.personaId && options.unique), 'the old two-field unique index is gone');
  const ttl = indexes.find(([fields]) => fields.expiresAt === 1);
  assert.ok(ttl && ttl[1].expireAfterSeconds === 0, 'native TTL index: expire exactly at expiresAt');
  assert.ok(indexes.some(([fields]) => Object.keys(fields).length === 1 && fields.senderId === 1), 'senderId index for refreshing a user\'s conversations');

  assert.ok(!AiConversation.schema.path('expiresAt').isRequired, 'optional, so the owner\'s documents can have none');
  assert.equal(AiConversation.schema.path('personaId').isRequired, true);
  const ownerDoc = new AiConversation({ chatId: 'c', senderId: 'owner@c.us', personaId: 'marin', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ownerDoc.validateSync(), undefined, 'a conversation with no expiresAt is valid');
  assert.ok(new AiConversation({ chatId: 'c', senderId: 's', messages: [] }).validateSync()?.errors?.personaId, 'a conversation must name its persona');
});

// ─── One conversation per persona ───────────────────────────────────────────
test('each persona has its own conversation; switching away and back continues the first one', withStore(async (store) => {
  await turn('u@c.us', 'u@c.us', 'marin', 'hi Marin', 'hey!');
  await turn('u@c.us', 'u@c.us', 'marin', 'how are you', 'great');

  assert.deepEqual(await history('u@c.us', 'u@c.us', 'karane'), [], 'a different persona starts a NEW conversation');
  await turn('u@c.us', 'u@c.us', 'karane', 'hi Karane', 'hmph. what.');
  assert.deepEqual((await history('u@c.us', 'u@c.us', 'karane')).map(m => m.content), ['hi Karane', 'hmph. what.']);

  assert.deepEqual((await history('u@c.us', 'u@c.us', 'marin')).map(m => m.content), ['hi Marin', 'hey!', 'how are you', 'great'], 'switching back returns the Marin conversation untouched');
  assert.deepEqual(await history('u@c.us', 'u@c.us', 'rias'), []);
  assert.equal(store.docs.length, 2, 'two stored conversations for this user, not one mixed one');
  assert.deepEqual(store.docs.map(d => d.personaId).sort(), ['karane', 'marin']);
}));

test('conversations are still separate per chat and per sender', withStore(async (store) => {
  await turn('group@g.us', 'a@c.us', 'marin', 'from A', 'to A');
  await turn('group@g.us', 'b@c.us', 'marin', 'from B', 'to B');
  await turn('b@c.us', 'b@c.us', 'marin', 'B in DM', 'to B in DM');
  assert.deepEqual((await history('group@g.us', 'a@c.us', 'marin')).map(m => m.content), ['from A', 'to A']);
  assert.deepEqual((await history('group@g.us', 'b@c.us', 'marin')).map(m => m.content), ['from B', 'to B']);
  assert.equal(store.docs.length, 3);
}));

test('the command wrappers use the active persona unless told otherwise', withStore(async (store) => {
  await ai._addTurnToHistory('c@c.us', 'c@c.us', 'q', 'a');
  assert.equal(store.docs[0].personaId, 'marin', 'AI_PERSONA is marin in this test run');
  assert.deepEqual((await ai._getHistory('c@c.us', 'c@c.us')).map(m => m.content), ['q', 'a']);
  assert.deepEqual(await ai._getHistory('c@c.us', 'c@c.us', 'karane'), []);
}));

// ─── Expiry: 7 days after the last message ──────────────────────────────────
test('expiry is 7 days after the last message, and every new message moves it forward', withStore(async (store, time) => {
  await turn('u@c.us', 'u@c.us', 'marin', 'day 0', 'ok');
  assert.equal(store.find('u@c.us', 'u@c.us', 'marin').expiresAt.getTime(), T0 + 7 * DAY, '7 days from the first message');

  time.advance(5 * DAY);
  await turn('u@c.us', 'u@c.us', 'marin', 'day 5', 'ok');
  assert.equal(store.find('u@c.us', 'u@c.us', 'marin').expiresAt.getTime(), T0 + 12 * DAY, 'counting restarts from the new message');

  time.set(T0 + 8 * DAY); // past the ORIGINAL expiry date
  store.sweep(time.now);
  assert.equal(store.docs.length, 1, 'it does not expire on the original date');
  assert.equal((await history('u@c.us', 'u@c.us', 'marin')).length, 4, 'and the whole conversation is still there');

  time.set(T0 + 12 * DAY + 1);
  store.sweep(time.now);
  assert.equal(store.docs.length, 0, 'it is deleted 7 days after the LAST message');
  assert.deepEqual(await history('u@c.us', 'u@c.us', 'marin'), []);
}));

test('reading a conversation does not keep it alive', withStore(async (store, time) => {
  await turn('u@c.us', 'u@c.us', 'marin', 'hi', 'hey');
  const before = store.find('u@c.us', 'u@c.us', 'marin').expiresAt.getTime();
  time.advance(3 * DAY);
  await history('u@c.us', 'u@c.us', 'marin');
  assert.equal(store.find('u@c.us', 'u@c.us', 'marin').expiresAt.getTime(), before);
}));

test('a message with ANY persona keeps ALL of that user\'s conversations alive, and nobody else\'s', withStore(async (store, time) => {
  await turn('u@c.us', 'u@c.us', 'marin', 'm', 'm');
  await turn('u@c.us', 'u@c.us', 'karane', 'k', 'k');
  await turn('other@c.us', 'other@c.us', 'marin', 'o', 'o');

  time.advance(6 * DAY);
  await turn('u@c.us', 'u@c.us', 'marin', 'still here', 'good');
  const expiries = Object.fromEntries(store.docs.map(d => [`${d.senderId}/${d.personaId}`, d.expiresAt.getTime()]));
  assert.equal(expiries['u@c.us/marin'], T0 + 13 * DAY);
  assert.equal(expiries['u@c.us/karane'], T0 + 13 * DAY, 'the Karane conversation was extended by the Marin message');
  assert.equal(expiries['other@c.us/marin'], T0 + 7 * DAY, 'another user is unaffected');

  time.set(T0 + 8 * DAY);
  store.sweep(time.now);
  assert.deepEqual(store.docs.map(d => `${d.senderId}/${d.personaId}`).sort(), ['u@c.us/karane', 'u@c.us/marin'], 'the other user expired on schedule, this user did not');
}));

test('a conversation past its expiry that Mongo has not swept yet is treated as gone and removed', withStore(async (store, time) => {
  await turn('u@c.us', 'u@c.us', 'marin', 'old', 'old');
  time.set(T0 + 7 * DAY + 30 * 1000); // expired 30 s ago; the TTL monitor has not run yet
  assert.equal(store.docs.length, 1);
  assert.deepEqual(await history('u@c.us', 'u@c.us', 'marin'), []);
  assert.equal(store.docs.length, 0, 'the stale document was removed');
  await turn('u@c.us', 'u@c.us', 'marin', 'new', 'new');
  assert.deepEqual((await history('u@c.us', 'u@c.us', 'marin')).map(m => m.content), ['new', 'new'], 'the new conversation does not inherit the old messages');
}));

test('the history Gemini receives always starts with the user, even if a trim cut a pair in half', withStore(async (store) => {
  store.insertLegacy({ chatId: 'u@c.us', senderId: 'u@c.us', personaId: 'marin', expiresAt: new Date(T0 + DAY),
    messages: [{ role: 'assistant', content: 'orphan' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
  assert.deepEqual((await history('u@c.us', 'u@c.us', 'marin')).map(m => m.content), ['q', 'a']);
}));

test('everyone else keeps the most recent 20 messages', withStore(async () => {
  for (let i = 1; i <= 15; i += 1) await turn('u@c.us', 'u@c.us', 'marin', `q${i}`, `a${i}`);
  const kept = await history('u@c.us', 'u@c.us', 'marin');
  assert.equal(kept.length, 20);
  assert.equal(kept[0].content, 'q6');
  assert.equal(kept.at(-1).content, 'a15');
}));

// ─── The owner ──────────────────────────────────────────────────────────────
test('the owner\'s conversations never expire, even when the sweep runs 1000 days later', withStore(async (store, time) => {
  await turn('owner@c.us', 'owner@c.us', 'marin', 'hello', 'hi boss');
  await turn('owner@c.us', 'owner@c.us', 'karane', 'hello', 'what');
  await turn('owner@c.us', 'owner@c.us', 'rias', 'hello', 'ara');
  for (const doc of store.docs) assert.equal('expiresAt' in doc, false, `${doc.personaId}: no expiresAt at all, so the TTL index cannot match it`);

  time.set(T0 + 1000 * DAY);
  store.sweep(time.now);
  assert.equal(store.docs.length, 3, 'all three persona conversations survive');
  assert.deepEqual((await history('owner@c.us', 'owner@c.us', 'marin')).map(m => m.content), ['hello', 'hi boss']);
}));

test('the owner is recognised by OWNER_NUMBER and by OWNER_IDS, in a DM and in a group', withStore(async (store) => {
  await turn('owner@c.us', 'owner@c.us', 'marin', 'dm', 'ok');
  await turn('group@g.us', 'owner-lid@lid', 'marin', 'group', 'ok');
  await turn('group@g.us', 'someone@c.us', 'marin', 'group', 'ok');
  assert.equal('expiresAt' in store.find('owner@c.us', 'owner@c.us', 'marin'), false);
  assert.equal('expiresAt' in store.find('group@g.us', 'owner-lid@lid', 'marin'), false);
  assert.ok(store.find('group@g.us', 'someone@c.us', 'marin').expiresAt instanceof Date, 'a normal member of the same group still expires');
}));

test('the owner\'s history is not trimmed to 20, and Gemini sees a bounded recent window', withStore(async (store) => {
  for (let i = 1; i <= 60; i += 1) await turn('owner@c.us', 'owner@c.us', 'marin', `q${i}`, `a${i}`);
  assert.equal(store.find('owner@c.us', 'owner@c.us', 'marin').messages.length, 120, 'all 120 messages are stored');
  const context = await history('owner@c.us', 'owner@c.us', 'marin');
  assert.equal(context.length, 100, 'but only the newest 100 are sent to Gemini');
  assert.equal(context[0].content, 'q11');
  assert.equal(context.at(-1).content, 'a60');
}));

test('a conversation that used to have an expiry loses it when its owner next talks', withStore(async (store) => {
  store.insertLegacy({ chatId: 'owner@c.us', senderId: 'owner@c.us', personaId: 'marin', expiresAt: new Date(T0 + DAY) });
  await turn('owner@c.us', 'owner@c.us', 'marin', 'hi', 'hi');
  assert.equal('expiresAt' in store.find('owner@c.us', 'owner@c.us', 'marin'), false);
}));

// ─── Existing conversations ─────────────────────────────────────────────────
test('migration: old conversations (no persona) become the active persona\'s, with the new expiry rules', withStore(async (store) => {
  store.insertLegacy({ chatId: 'u@c.us', senderId: 'u@c.us', messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old reply' }], expiresAt: new Date(T0 + 60 * 1000) });
  store.insertLegacy({ chatId: 'owner@c.us', senderId: 'owner@c.us', messages: [{ role: 'user', content: 'boss' }], expiresAt: new Date(T0 + 60 * 1000) });
  store.insertLegacy({ chatId: 'x@c.us', senderId: 'x@c.us', personaId: 'karane', messages: [], expiresAt: new Date(T0 + DAY) });

  const result = await conversations.migrateLegacyConversations('marin');
  assert.equal(result.moved, 2);
  const user = store.find('u@c.us', 'u@c.us', 'marin');
  assert.deepEqual(user.messages.map(m => m.content), ['old', 'old reply'], 'the messages are kept');
  assert.equal(user.expiresAt.getTime(), T0 + 7 * DAY, 'the old 30-minute expiry is replaced by 7 days');
  assert.equal('expiresAt' in store.find('owner@c.us', 'owner@c.us', 'marin'), false, 'the owner\'s has no expiry');
  assert.equal(store.find('x@c.us', 'x@c.us', 'karane').expiresAt.getTime(), T0 + DAY, 'a conversation that already has a persona is left alone');

  assert.equal((await conversations.migrateLegacyConversations('marin')).moved, 0, 'running it again changes nothing');
  assert.deepEqual((await history('u@c.us', 'u@c.us', 'marin')).map(m => m.content), ['old', 'old reply']);
}));

test('migration: it never fails startup, and never overwrites a conversation that already exists', withStore(async (store) => {
  store.insertLegacy({ chatId: 'u@c.us', senderId: 'u@c.us', messages: [{ role: 'user', content: 'legacy' }] });
  store.insertLegacy({ chatId: 'u@c.us', senderId: 'u@c.us', personaId: 'marin', messages: [{ role: 'user', content: 'newer' }], expiresAt: new Date(T0 + DAY) });
  const result = await conversations.migrateLegacyConversations('marin');
  assert.equal(result.moved, 0, 'the clash is skipped');
  assert.deepEqual(store.find('u@c.us', 'u@c.us', 'marin').messages.map(m => m.content), ['newer']);
  assert.deepEqual(await conversations.migrateLegacyConversations(null), { moved: 0 }, 'no persona, nothing to do');
}));

// ─── Failure handling ───────────────────────────────────────────────────────
test('a database failure never breaks a reply', withStore(async () => {
  const originalFind = AiConversation.findOne;
  const originalUpdate = AiConversation.findOneAndUpdate;
  const originalError = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  AiConversation.findOne = () => Promise.reject(new Error('mongo down'));
  AiConversation.findOneAndUpdate = () => Promise.reject(new Error('mongo down'));
  try {
    assert.deepEqual(await history('u@c.us', 'u@c.us', 'marin'), []);
    assert.equal(await turn('u@c.us', 'u@c.us', 'marin', 'q', 'a'), false);
  } finally {
    console.error = originalError;
    AiConversation.findOne = originalFind;
    AiConversation.findOneAndUpdate = originalUpdate;
  }
  assert.match(logs.join('\n'), /ai history load failed: mongo down/);
  assert.match(logs.join('\n'), /ai history save failed: mongo down/);
}));

// ─── Wiring and logs ────────────────────────────────────────────────────────
test('startup migrates old conversations BEFORE syncing indexes, and the old 30-minute constants are gone', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const migrate = index.indexOf('aiConversations.migrateLegacyConversations(');
  const sync = index.indexOf('AiConversation.syncIndexes()');
  assert.ok(migrate > 0 && sync > migrate, 'migration first, then syncIndexes');
  const source = fs.readFileSync(path.join(ROOT, 'commands/ai.js'), 'utf8');
  assert.doesNotMatch(source, /HISTORY_TTL_MS|30 \* 60 \* 1000/);
  assert.doesNotMatch(source, /AiConversation\.(findOne|findOneAndUpdate)/, 'ai.js no longer touches the collection directly');
  const config = require('../utils/config');
  assert.deepEqual([config.AI_HISTORY_EXPIRY_DAYS, config.AI_HISTORY_EXPIRY_SCOPE, config.AI_HISTORY_MESSAGES], [7, 'user', 20]);
});

test('logs: loading, saving, expiry and the one-time update are readable', () => {
  const logger = require('../utils/logger');
  const lines = [];
  const original = { log: console.log, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' ')); console.warn = console.log;
  try {
    logger.write('INFO', 'ai.history.loaded', { personaId: 'karane', messages: 0, owner: false, continuing: false });
    logger.write('INFO', 'ai.history.loaded', { personaId: 'marin', messages: 6, owner: false, continuing: true });
    logger.write('INFO', 'ai.history.loaded', { personaId: 'marin', messages: 100, owner: true, continuing: true });
    logger.write('INFO', 'ai.history.saved', { personaId: 'marin', kept: 8, owner: false, expiresAt: new Date(T0 + 7 * DAY), days: 7, scope: 'user', refreshed: 2 });
    logger.write('INFO', 'ai.history.saved', { personaId: 'marin', kept: 130, owner: true, expiresAt: null, days: 7, scope: 'user', refreshed: 0 });
    logger.write('INFO', 'ai.history.expired', { personaId: 'rias' });
    logger.write('INFO', 'ai.history.migrated', { moved: 3, personaId: 'marin' });
    logger.write('INFO', 'ai.history.indexes.synced', {});
  } finally {
    Object.assign(console, original);
  }
  const text = lines.join('\n');
  assert.match(text, /\[ai\] No earlier conversation with karane: starting a new one/);
  assert.match(text, /\[ai\] Continuing the conversation with marin \(6 earlier messages\)/);
  assert.match(text, /Continuing the conversation with marin \(100 earlier messages\) · owner: nothing expires/);
  assert.match(text, /\[ai\] Saved to the marin conversation \(8 messages kept\) · expires 7 days after the last message with any character \(.+\) · extended 2 conversation\(s\)/);
  assert.match(text, /\[ai\] Saved to the marin conversation \(130 messages kept\) · owner: never expires/);
  assert.match(text, /\[ai\] The earlier conversation with rias had expired: starting fresh/);
  assert.match(text, /\[ai\] One-time update: 3 earlier conversation\(s\) are now the marin conversation/);
  assert.match(text, /\[ai\] Conversation indexes are up to date/);
});
