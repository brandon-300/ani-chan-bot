// Run with:  node --test tests/adapter-parity.test.mjs
// Checks that the Baileys adapter hands commands the same message / chat / id
// shapes whatsapp-web.js did, so the two versions can share one MongoDB.
// Everything is driven through a fake socket; nothing touches WhatsApp or MongoDB.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OWNER_NUMBER = '2347079911744@c.us';
process.env.OWNER_IDS = '177915346055272@lid';
process.env.LOG_LEVEL = 'INFO';
delete process.env.GEMINI_API_KEY;

const mongoose = (await import('mongoose')).default;
mongoose.set('bufferCommands', false);

const socketManager = (await import('../src/whatsapp/socket.js')).default;
const wa = (await import('../src/whatsapp/index.js')).default;
const identity = (await import('../src/whatsapp/identity.js')).default;
const groups = (await import('../src/whatsapp/groups.js')).default;
const messages = (await import('../src/whatsapp/messages.js')).default;
const helpers = await import('../src/utils/helpers.js');

const BOT_PN = '2349999999999@s.whatsapp.net';
const BOT_LID = '555000111222333@lid';
const USER_PN = '2348111111111@s.whatsapp.net';
const USER_LID = '177915346055272@lid';
const GROUP = '120363000000000000@g.us';

const sent = [];
const sock = {
  user: { id: '2349999999999:7@s.whatsapp.net', lid: '555000111222333:7@lid', name: 'Anichan' },
  async sendMessage(jid, payload, opts) { sent.push({ jid, payload, opts }); return { key: { id: `OUT${sent.length}`, remoteJid: jid, fromMe: true } }; },
  async groupMetadata(jid) {
    return {
      id: jid, subject: 'Test group', owner: USER_PN,
      participants: [
        { id: USER_PN, admin: 'superadmin' },
        { id: BOT_LID, phoneNumber: BOT_PN, admin: 'admin' },
        { id: '2348222222222@s.whatsapp.net' },
      ],
    };
  },
  groupInviteCode: async () => 'INVITECODE',
  groupSettingUpdate: async (jid, mode) => { sent.push({ settings: mode }); },
  groupParticipantsUpdate: async (jid, ids, action) => { sent.push({ participantsUpdate: { ids, action } }); return ids.map(id => ({ jid: id, status: '200' })); },
};
socketManager.sock = sock;
wa.messages.init(sock);
wa.identity.init(sock);
wa.groups.init(sock);

const lastSent = () => sent[sent.length - 1];

function groupMsg({ participant = USER_PN, message, id = 'G1', pushName = 'Tester' } = {}) {
  return socketManager.normalizeMessage({ key: { remoteJid: GROUP, id, fromMe: false, participant }, message: message || { conversation: 'hi' }, pushName, messageTimestamp: 1 });
}
function dmMsg({ jid = USER_PN, message, id = 'D1', pushName = 'Tester' } = {}) {
  return socketManager.normalizeMessage({ key: { remoteJid: jid, id, fromMe: false }, message: message || { conversation: 'hi' }, pushName, messageTimestamp: 1 });
}

// ── msg.from / msg.author: whatsapp-web.js meaning ─────────────────────────
test('group message: from = the group, author = the sender (legacy @c.us id)', () => {
  const msg = groupMsg();
  assert.equal(msg.from, GROUP);
  assert.equal(msg.chatId, GROUP);
  assert.equal(msg.author, '2348111111111@c.us');
  assert.equal(msg.isGroup, true);
  assert.ok(msg.from.endsWith('@g.us'), 'antilink / activity tracking check this');
});

test('DM: from = the other person (legacy id), author is empty, senderId fallback works', () => {
  const msg = dmMsg();
  assert.equal(msg.from, '2348111111111@c.us');
  assert.equal(msg.author, '');
  assert.equal(msg.author || msg.from, '2348111111111@c.us');
  assert.equal(msg.isGroup, false);
});

test('LID senders keep their @lid id (same as whatsapp-web.js stored)', () => {
  assert.equal(dmMsg({ jid: USER_LID }).from, USER_LID);
  assert.equal(groupMsg({ participant: USER_LID }).author, USER_LID);
});

test('device suffixes never leak into ids', () => {
  assert.equal(groupMsg({ participant: '2348111111111:12@s.whatsapp.net' }).author, '2348111111111@c.us');
});

test('raw Baileys key is still available for internal use', () => {
  const msg = groupMsg();
  assert.equal(msg.key.remoteJid, GROUP);
  assert.equal(msg._baileys.key.participant, USER_PN);
});

test('msg.pushName and msg.to are provided', () => {
  const msg = dmMsg();
  assert.equal(msg.pushName, 'Tester');
  assert.equal(msg.to, '2349999999999@c.us');
});

// ── replies still reach the right chat ─────────────────────────────────────
test('msg.reply in a group goes to the group, in a DM to the person (Baileys spelling)', async () => {
  await groupMsg().reply('hello group');
  assert.equal(lastSent().jid, GROUP);
  await dmMsg().reply('hello dm');
  assert.equal(lastSent().jid, USER_PN);
  assert.equal(lastSent().payload.text, 'hello dm');
});

// ── contacts ───────────────────────────────────────────────────────────────
test('msg.getContact(): legacy id, push name, number', async () => {
  const contact = await groupMsg().getContact();
  assert.equal(contact.id._serialized, '2348111111111@c.us');
  assert.equal(contact.pushname, 'Tester');
  assert.equal(contact.number, '2348111111111');
  assert.equal(contact.isMe, false);
});

// ── mentions ───────────────────────────────────────────────────────────────
test('mentionedIds / getMentions: legacy ids, bot LID shown as the bot id', async () => {
  const msg = groupMsg({
    message: { extendedTextMessage: { text: '@a @bot', contextInfo: { mentionedJid: [USER_PN, BOT_LID, USER_PN] } } },
  });
  assert.deepEqual(msg.mentionedIds, ['2348111111111@c.us', '2349999999999@c.us']);
  assert.ok(msg.mentionedIds.includes(wa.info.wid._serialized), 'bot mention detection (index.js) works in LID groups');
  const mentions = await msg.getMentions();
  assert.equal(mentions.length, 2);
  assert.equal(mentions[0].id._serialized, '2348111111111@c.us');
});

test('mentions work on image captions too', () => {
  const msg = groupMsg({ message: { imageMessage: { caption: 'x', mimetype: 'image/jpeg', contextInfo: { mentionedJid: [USER_PN] } } } });
  assert.deepEqual(msg.mentionedIds, ['2348111111111@c.us']);
});

test('no mentions: empty list, getMentions resolves to []', async () => {
  const msg = groupMsg();
  assert.deepEqual(msg.mentionedIds, []);
  assert.deepEqual(await msg.getMentions(), []);
});

test('outgoing mentions given as @c.us ids or contact objects reach Baileys as real JIDs', async () => {
  await messages.sendMessage(GROUP, 'hey', { mentions: ['2348111111111@c.us', { id: { _serialized: '2348222222222@c.us' } }, USER_LID] });
  assert.deepEqual(lastSent().payload.mentions, [USER_PN, '2348222222222@s.whatsapp.net', USER_LID]);
});

// ── quoted messages ────────────────────────────────────────────────────────
test('hasQuotedMsg + getQuotedMessage work without the message being in the store', async () => {
  const msg = groupMsg({
    message: {
      extendedTextMessage: {
        text: '.sticker',
        contextInfo: {
          stanzaId: 'QUOTED1', participant: '2348222222222@s.whatsapp.net',
          quotedMessage: { imageMessage: { mimetype: 'image/jpeg', caption: 'a pic', mediaKey: Buffer.alloc(32), directPath: '/p', url: 'https://mmg.whatsapp.net/p' } },
        },
      },
    },
  });
  assert.equal(msg.hasQuotedMsg, true);
  const quoted = await msg.getQuotedMessage();
  assert.ok(quoted);
  assert.equal(quoted.type, 'image');
  assert.equal(quoted.hasMedia, true);
  assert.equal(quoted.body, 'a pic');
  assert.equal(quoted.author, '2348222222222@c.us');
  assert.equal(quoted.from, GROUP);
  assert.equal(quoted.fromMe, false);
  assert.equal(typeof quoted.downloadMedia, 'function');
});

test('a quote of the bot\'s own message (even by LID) is marked fromMe', async () => {
  const msg = groupMsg({
    message: { extendedTextMessage: { text: 'hm', contextInfo: { stanzaId: 'Q2', participant: BOT_LID, quotedMessage: { conversation: 'earlier reply' } } } },
  });
  const quoted = await msg.getQuotedMessage();
  assert.equal(quoted.fromMe, true);
  assert.equal(quoted.body, 'earlier reply');
});

test('no quote: hasQuotedMsg false and getQuotedMessage null', async () => {
  const msg = groupMsg();
  assert.equal(msg.hasQuotedMsg, false);
  assert.equal(await msg.getQuotedMessage(), null);
});

test('pin / unpin send the Baileys pin message', async () => {
  const msg = groupMsg({ id: 'PINME' });
  assert.equal(await msg.pin(604800), true);
  assert.deepEqual({ pin: lastSent().payload.pin.id, type: lastSent().payload.type, time: lastSent().payload.time }, { pin: 'PINME', type: 1, time: 604800 });
  assert.equal(await msg.unpin(), true);
  assert.equal(lastSent().payload.type, 2);
});

// ── chats ──────────────────────────────────────────────────────────────────
test('msg.getChat() for a group: legacy participant ids, bot listed under its own id, chat methods present', async () => {
  const chat = await groupMsg().getChat();
  assert.equal(chat.isGroup, true);
  assert.equal(chat.id._serialized, GROUP);
  const ids = chat.participants.map(p => p.id._serialized);
  assert.deepEqual(ids, ['2348111111111@c.us', '2349999999999@c.us', '2348222222222@c.us']);
  assert.ok(ids.includes(wa.info.wid._serialized), 'bot found in participants even though the group lists its LID');
  assert.deepEqual(chat.adminIds, ['2348111111111@c.us', '2349999999999@c.us']);
  for (const fn of ['sendMessage', 'getInviteCode', 'setMessagesAdminsOnly', 'removeParticipants', 'promoteParticipants', 'demoteParticipants', 'addParticipants', 'setSubject', 'setDescription', 'leave']) {
    assert.equal(typeof chat[fn], 'function', fn);
  }
});

test('chat.sendMessage / getInviteCode / setMessagesAdminsOnly / removeParticipants really work', async () => {
  const chat = await groupMsg().getChat();
  await chat.sendMessage('broadcast', { mentions: ['2348111111111@c.us'] });
  assert.equal(lastSent().jid, GROUP);
  assert.deepEqual(lastSent().payload.mentions, [USER_PN]);
  assert.equal(await chat.getInviteCode(), 'INVITECODE');
  assert.equal(await chat.setMessagesAdminsOnly(true), true);
  assert.equal(lastSent().settings, 'announcement');
  await chat.removeParticipants(['2348222222222@c.us']);
  assert.deepEqual(lastSent().participantsUpdate, { ids: ['2348222222222@s.whatsapp.net'], action: 'remove' });
});

test('the cached group is never mutated by exposing it', async () => {
  const chat = await groupMsg().getChat();
  chat.participants.pop();
  const again = await groupMsg().getChat();
  assert.equal(again.participants.length, 3);
  const internal = await groups.getGroup(GROUP);
  assert.equal(internal.participants[0].id._serialized, USER_PN, 'internal ids stay in Baileys form');
});

test('msg.getChat() for a DM and client.getChatById() work', async () => {
  const dm = await dmMsg().getChat();
  assert.equal(dm.isGroup, false);
  assert.equal(dm.id._serialized, '2348111111111@c.us');
  assert.equal(typeof dm.sendMessage, 'function');
  await dm.sendMessage('psst');
  assert.equal(lastSent().jid, USER_PN);

  const byId = await wa.getChatById(GROUP);
  assert.equal(byId.isGroup, true);
  const byLegacyDm = await wa.getChatById('2348111111111@c.us');
  assert.equal(byLegacyDm.isGroup, false);
});

test('client.getChats() returns chat objects with the same shape', async () => {
  sock.groupFetchAllParticipating = async () => ({ [GROUP]: await sock.groupMetadata(GROUP) });
  const chats = await wa.getChats();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].participants[0].id._serialized, '2348111111111@c.us');
  assert.equal(typeof chats[0].sendMessage, 'function');
});

// ── bot / owner identity ───────────────────────────────────────────────────
test('client.info.wid is the plain @c.us id (no device suffix)', () => {
  assert.equal(wa.info.wid._serialized, '2349999999999@c.us');
});

test('owner is recognised however the id is spelled, using the shared .env', () => {
  for (const id of ['2347079911744@c.us', '2347079911744@s.whatsapp.net', '2347079911744:5@s.whatsapp.net', '177915346055272@lid']) {
    assert.equal(helpers.isOwner(id), true, id);
  }
  assert.equal(helpers.isOwner('2348111111111@c.us'), false);
});

test('a message sent to OWNER_NUMBER (@c.us) is delivered to the real JID', async () => {
  await wa.sendMessage(process.env.OWNER_NUMBER, 'feedback');
  assert.equal(lastSent().jid, '2347079911744@s.whatsapp.net');
});

// ── group join / leave notifications ───────────────────────────────────────
test('group join/leave events match what commands/admin.js expects', async () => {
  const events = [];
  socketManager.on('group_join', n => events.push(['join', n]));
  socketManager.on('group_leave', n => events.push(['leave', n]));
  await socketManager.handleGroupParticipantsUpdate({ id: GROUP, participants: [{ id: '2348333333333@s.whatsapp.net' }], action: 'add', author: USER_PN });
  await socketManager.handleGroupParticipantsUpdate({ id: GROUP, participants: ['2348222222222@s.whatsapp.net'], action: 'remove' });
  await socketManager.handleGroupParticipantsUpdate({ id: GROUP, participants: [USER_PN], action: 'promote' });
  assert.equal(events.length, 2, 'promote is not a join/leave');
  const [, join] = events[0];
  assert.deepEqual(join.recipientIds, ['2348333333333@c.us']);
  assert.equal(join.chatId, GROUP);
  const chat = await join.getChat();
  assert.equal(chat.id._serialized, GROUP);
  const recipients = await join.getRecipients();
  assert.equal(recipients[0].id._serialized, '2348333333333@c.us');
  const [, leave] = events[1];
  assert.deepEqual(leave.recipientIds, ['2348222222222@c.us']);
});

// ── identity maintenance events ────────────────────────────────────────────
test('lid-mapping.update teaches the identity service the mapping', async () => {
  await socketManager.handleLidMappingUpdate({ lid: '999888777666@lid', pn: '2348444444444@s.whatsapp.net' });
  assert.equal(identity.getPnFromLid('999888777666@lid'), '2348444444444@s.whatsapp.net');
});

// ── logout (401) ───────────────────────────────────────────────────────────
test('401 logout prints how to re-pair and exits with code 64 (PM2: do not restart)', async () => {
  const realExit = process.exit;
  const realError = console.error;
  const realExitCode = process.exitCode;
  let exitCode = null;
  const printed = [];
  process.exit = code => { exitCode = code; };
  console.error = (...args) => { printed.push(args.join(' ')); };
  socketManager.isShuttingDown = false;
  socketManager.on('error', () => {});
  try {
    await socketManager.handleConnectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 }, message: 'Connection Failure' } } });
    await new Promise(resolve => setTimeout(resolve, 450));
  } finally {
    process.exit = realExit;
    console.error = realError;
    process.exitCode = realExitCode;
  }
  assert.equal(exitCode, 64);
  assert.match(printed.join('\n'), /auth_info_baileys/);
  assert.match(printed.join('\n'), /mv auth_info_baileys/);
});

test('other disconnects still schedule a reconnect instead of exiting', async () => {
  const realExit = process.exit;
  let exited = false;
  process.exit = () => { exited = true; };
  const realSchedule = socketManager.scheduleReconnect;
  let scheduled = false;
  socketManager.scheduleReconnect = () => { scheduled = true; };
  try {
    await socketManager.handleConnectionUpdate({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 }, message: 'Connection Closed' } } });
    await new Promise(resolve => setTimeout(resolve, 400));
  } finally {
    process.exit = realExit;
    socketManager.scheduleReconnect = realSchedule;
  }
  assert.equal(scheduled, true);
  assert.equal(exited, false);
});

// ── AI conversation memory: same rules as the whatsapp-web.js version ──────
test('aiConversations: same storage rules (shared MongoDB)', async () => {
  const AiConversation = (await import('../src/models/AiConversation.js')).default;
  const aiConversations = (await import('../src/utils/aiConversations.js')).default;
  const store = new Map();
  const key = f => `${f.chatId}|${f.senderId}|${f.personaId}`;
  const real = { findOne: AiConversation.findOne, findOneAndUpdate: AiConversation.findOneAndUpdate, updateMany: AiConversation.updateMany, deleteOne: AiConversation.deleteOne };
  const updateManyCalls = [];
  AiConversation.findOne = async f => store.get(key(f)) || null;
  AiConversation.deleteOne = async ({ _id }) => { for (const [k, v] of store) if (v._id === _id) store.delete(k); };
  AiConversation.updateMany = async (f, u) => { updateManyCalls.push({ f, u }); return { modifiedCount: 1 }; };
  AiConversation.findOneAndUpdate = async (f, u) => {
    const doc = store.get(key(f)) || { _id: key(f), ...f, messages: [] };
    doc.messages = [...doc.messages, ...u.$push.messages.$each].slice(u.$push.messages.$slice);
    Object.assign(doc, u.$set || {});
    for (const field of Object.keys(u.$unset || {})) delete doc[field];
    store.set(key(f), doc);
    return doc;
  };
  const chat = GROUP; const user = '2348111111111@c.us'; const owner = '2347079911744@c.us';
  try {
    assert.deepEqual(await aiConversations.getConversationHistory({ chatId: chat, senderId: user, personaId: 'karane' }), []);
    await aiConversations.appendConversationTurn({ chatId: chat, senderId: user, personaId: 'karane', userContent: 'hi', assistantContent: 'hello' });
    const doc = store.get(key({ chatId: chat, senderId: user, personaId: 'karane' }));
    assert.ok(doc.expiresAt instanceof Date, 'non-owner conversations expire (7 days)');
    assert.ok(doc.lastActivityAt instanceof Date);
    assert.equal(updateManyCalls.length, 1, 'scope=user refreshes all of this user\'s conversations');
    assert.deepEqual((await aiConversations.getConversationHistory({ chatId: chat, senderId: user, personaId: 'karane' })).map(m => m.role), ['user', 'assistant']);

    await aiConversations.appendConversationTurn({ chatId: chat, senderId: owner, personaId: 'karane', userContent: 'a', assistantContent: 'b' });
    const ownerDoc = store.get(key({ chatId: chat, senderId: owner, personaId: 'karane' }));
    assert.equal(ownerDoc.expiresAt, undefined, 'owner conversations never expire');

    doc.expiresAt = new Date(Date.now() - 1000);
    assert.deepEqual(await aiConversations.getConversationHistory({ chatId: chat, senderId: user, personaId: 'karane' }), [], 'expired conversation starts fresh');
  } finally {
    Object.assign(AiConversation, real);
  }
});

test.after(() => { setTimeout(() => process.exit(0), 50).unref?.(); });
