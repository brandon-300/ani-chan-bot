// commands/antibot.js — Anti-Bot for AniChan
//
// .antibot on|off  — admin/owner only. When on, any message sent to the group
//                    by another bot is deleted and its sender is warned. Once
//                    the sender reaches the warning limit (ANTIBOT_WARN_LIMIT)
//                    it is removed from the group automatically.
// .antibot id      — admin/owner only. Reply to a message to see its id and
//                    whether Anti-Bot would treat it as a bot (for tuning
//                    ANTIBOT_ID_PATTERNS in .env).
//
// The listener half (_handleAntibot) is called from a standalone
// client.on('message') handler in index.js. Names starting with "_" are not
// registered as commands by index.js's loader.
//
// HOW A BOT IS RECOGNISED: WhatsApp has no official "this is a bot" flag, so
// this uses two signals, both configured in utils/config.js / .env:
//   1. the message id matches one of ANTIBOT_ID_PATTERNS, or
//   2. the message type is one a normal WhatsApp app cannot send
//      (ANTIBOT_MESSAGE_TYPES: list / interactive / native_flow).
// Group admins, the owner and bot moderators are never treated as bots.

const Group = require('../models/Group');
const AntibotWarn = require('../models/AntibotWarn');
const {
  isAdmin,
  isOwner,
  isMod,
  safeGetChat,
  safeGetContact,
  safeGetQuotedMessage,
  withRetry,
} = require('../utils/helpers');
const {
  BOT_PREFIX,
  ANTIBOT_WARN_LIMIT,
  ANTIBOT_ID_PATTERNS,
  ANTIBOT_MESSAGE_TYPES,
  ANTIBOT_REMOVED_MEMORY_MS,
} = require('../utils/config');

// ─── Detection ──────────────────────────────────────────────────────────────
const ID_MATCHERS = [];
for (const source of ANTIBOT_ID_PATTERNS) {
  try {
    ID_MATCHERS.push({ source, regex: new RegExp(source) });
  } catch (err) {
    console.error(`Antibot: ignoring invalid ANTIBOT_ID_PATTERNS entry "${source}": ${err.message}`);
  }
}
const BOT_MESSAGE_TYPES = new Set(ANTIBOT_MESSAGE_TYPES);

function detectBot(message) {
  const id = String(message?.id?.id || '');
  const type = String(message?.type || '');
  if (BOT_MESSAGE_TYPES.has(type)) {
    return { isBot: true, signal: `message type "${type}"` };
  }
  if (id) {
    for (const { source, regex } of ID_MATCHERS) {
      if (regex.test(id)) return { isBot: true, signal: `message id matches ${source}` };
    }
  }
  return { isBot: false, signal: null };
}

// ─── Message cards ──────────────────────────────────────────────────────────
function buildWarningCard({ user, count, limit, device }) {
  return [
    '┌❖',
    '│「 ⚠️ *WARNING* 」',
    `└┬❖ 「 @${user} 」`,
    ' │✑ *REASON*',
    ` │✑ Detected as a bot user. Device: ${device}`,
    ' │✑ *LIMIT*',
    ` │✑ ${count}/${limit}`,
    ' └────────────···✑',
  ].join('\n');
}

function buildRemovedCard({ user, count, limit }) {
  return [
    '┌❖',
    '│「 🚫 *REMOVED* 」',
    `└┬❖ 「 @${user} 」`,
    ' │✑ *REASON*',
    ' │✑ Detected as a bot user and reached the warning limit.',
    ' │✑ *LIMIT*',
    ` │✑ ${count}/${limit}`,
    ' └────────────···✑',
  ].join('\n');
}

function buildRemoveFailedCard({ user, count, limit }) {
  return [
    '┌❖',
    '│「 ⚠️ *WARNING* 」',
    `└┬❖ 「 @${user} 」`,
    ' │✑ *REASON*',
    ' │✑ Reached the bot warning limit but I could not remove them. Am I still an admin?',
    ' │✑ *LIMIT*',
    ` │✑ ${count}/${limit}`,
    ' └────────────···✑',
  ].join('\n');
}

// ─── Listener state ─────────────────────────────────────────────────────────
// Per (group, user) promise chain: a bot that sends several messages at once
// is processed one message at a time, so warning counts go up in order and
// the removal happens exactly once.
const inFlight = new Map();
// Bots removed a moment ago — see ANTIBOT_REMOVED_MEMORY_MS in config.
const recentlyRemoved = new Map();
// Groups where the bot was found not to be an admin (logged once each).
const loggedNotAdmin = new Set();

function pruneRecentlyRemoved(now) {
  for (const [key, ts] of recentlyRemoved) {
    if (now - ts > ANTIBOT_REMOVED_MEMORY_MS) recentlyRemoved.delete(key);
  }
}

async function sendNotice(chat, text, targetId) {
  try {
    await chat.sendMessage(text, { mentions: [targetId] });
  } catch (err) {
    console.error('Antibot: could not send notice:', err.message);
  }
}

async function processDetectedBot({ msg, chat, targetId }) {
  const groupId = chat.id._serialized;
  const key = `${groupId}|${targetId}`;
  const user = String(targetId).split('@')[0].split(':')[0];

  // Every message from the bot is deleted, whether or not it also warns.
  try {
    await msg.delete(true);
  } catch (err) {
    console.error('Antibot: delete failed:', err.message);
  }

  pruneRecentlyRemoved(Date.now());
  if (recentlyRemoved.has(key)) return;

  const doc = await withRetry(() => AntibotWarn.findOneAndUpdate(
    { groupId, userId: targetId },
    { $inc: { count: 1 }, $set: { lastAt: new Date() } },
    { upsert: true, new: true }
  ));
  const count = doc.count;

  if (count < ANTIBOT_WARN_LIMIT) {
    await sendNotice(chat, buildWarningCard({ user, count, limit: ANTIBOT_WARN_LIMIT, device: msg.deviceType || 'unknown' }), targetId);
    return;
  }

  // Limit reached: remove the bot. If this fails (for example the bot lost
  // admin), later messages from it retry quietly; the failure notice is only
  // sent once, on the message that first reached the limit.
  try {
    await chat.removeParticipants([targetId]);
  } catch (err) {
    console.error('Antibot: remove failed:', err.message);
    if (count === ANTIBOT_WARN_LIMIT) {
      await sendNotice(chat, buildRemoveFailedCard({ user, count, limit: ANTIBOT_WARN_LIMIT }), targetId);
    }
    return;
  }

  recentlyRemoved.set(key, Date.now());
  try {
    await AntibotWarn.deleteOne({ groupId, userId: targetId });
  } catch (err) {
    console.error('Antibot: could not clear warning count after removal:', err.message);
  }
  await sendNotice(chat, buildRemovedCard({ user, count: ANTIBOT_WARN_LIMIT, limit: ANTIBOT_WARN_LIMIT }), targetId);
}

// Called for every incoming message by the listener in index.js.
async function _handleAntibot(client, msg) {
  if (msg.fromMe || msg.isStatus) return;
  if (!String(msg.from || '').endsWith('@g.us')) return;

  // Cheap check first: nearly every message ends here without touching
  // WhatsApp or the database.
  if (!detectBot(msg).isBot) return;

  const chat = await safeGetChat(msg).catch(err => {
    console.error('Antibot: could not get chat, skipping:', err.message);
    return null;
  });
  if (!chat || !chat.isGroup) return;

  const groupDoc = await Group.findOne({ id: chat.id._serialized }).select('antibot').lean();
  if (!groupDoc?.antibot) return;

  const botId = client.info.wid._serialized;
  const botUser = client.info.wid.user;

  // Ids the sender may appear under (raw author, plus the resolved contact
  // unless it is the known "misresolved as the bot itself" glitch).
  const candidateIds = new Set();
  if (msg.author) candidateIds.add(msg.author);
  try {
    const contact = await safeGetContact(msg);
    const contactId = contact?.id?._serialized;
    if (contactId && !(contact.isMe && msg.author && msg.author !== botId)) candidateIds.add(contactId);
  } catch (err) {
    console.error('Antibot: contact lookup failed (using raw author):', err.message);
  }
  if (!candidateIds.size) return;
  const candidateUsers = new Set([...candidateIds].map(id => String(id).split('@')[0].split(':')[0]));

  // Never touch admins, the owner or bot moderators.
  const senderParticipant = chat.participants.find(
    p => candidateIds.has(p.id._serialized) || candidateUsers.has(p.id.user)
  );
  if (senderParticipant && (senderParticipant.isAdmin || senderParticipant.isSuperAdmin)) return;
  for (const id of candidateIds) {
    if (isMod(id)) return;
  }

  // Deleting other people's messages and removing members both need admin.
  // If the bot's own participant entry isn't found (WhatsApp id format
  // differences) this still tries, rather than silently doing nothing.
  const botParticipant = chat.participants.find(p => p.id._serialized === botId || p.id.user === botUser);
  if (botParticipant && !(botParticipant.isAdmin || botParticipant.isSuperAdmin)) {
    if (!loggedNotAdmin.has(chat.id._serialized)) {
      loggedNotAdmin.add(chat.id._serialized);
      console.error(`Antibot: skipping ${chat.id._serialized} — I am not an admin there.`);
    }
    return;
  }
  loggedNotAdmin.delete(chat.id._serialized);

  const targetId = msg.author || [...candidateIds][0];
  const key = `${chat.id._serialized}|${targetId}`;
  const previous = inFlight.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => processDetectedBot({ msg, chat, targetId }));
  inFlight.set(key, run);
  try {
    await run;
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key);
  }
}

// ─── Command helpers ────────────────────────────────────────────────────────
async function requireAdmin(msg) {
  const contact = await msg.getContact().catch(() => null);
  if (contact && isOwner(contact.id._serialized)) return true;

  const ok = await isAdmin(msg);
  if (!ok) {
    await msg.reply('❌ Admins only!');
    return false;
  }
  return true;
}

module.exports = {
  // .antibot on | off | id
  async antibot(client, msg, args) {
    const chat = await safeGetChat(msg).catch(async err => {
      console.error('getChat failed:', err.message);
      await msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
      return null;
    });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');
    if (!await requireAdmin(msg)) return;

    const sub = (args[0] || '').toLowerCase();

    if (sub === 'on' || sub === 'off') {
      const enabled = sub === 'on';
      if (enabled) {
        // Checked against this chat's participant list (not msg.to). If the
        // bot's own entry can't be found, enabling is still allowed and the
        // listener re-checks admin status on every detection.
        const botId = client.info.wid._serialized;
        const botUser = client.info.wid.user;
        const botParticipant = chat.participants.find(p => p.id._serialized === botId || p.id.user === botUser);
        if (botParticipant && !(botParticipant.isAdmin || botParticipant.isSuperAdmin)) {
          return msg.reply('❌ Make me an admin first!');
        }
      }
      await Group.findOneAndUpdate(
        { id: chat.id._serialized },
        { $set: { antibot: enabled } },
        { upsert: true }
      );
      return msg.reply(`✅ Anti-Bot is now *${enabled ? 'on' : 'off'}* for this group.`);
    }

    if (sub === 'id') {
      if (!msg.hasQuotedMsg) {
        return msg.reply(`❌ Reply to a message with *${BOT_PREFIX}antibot id* to see how it is detected.`);
      }
      const quoted = await safeGetQuotedMessage(msg).catch(() => null);
      if (!quoted) return msg.reply('⚠️ Could not read that message — please try again.');
      const id = String(quoted.id?.id || '');
      const detection = detectBot(quoted);
      return msg.reply(
        `🔎 *Anti-Bot check*\n\n` +
        `Message ID: \`${id || 'unknown'}\`\n` +
        `Length: ${id.length}\n` +
        `Type: ${quoted.type || 'unknown'}\n` +
        `Device: ${quoted.deviceType || 'unknown'}\n` +
        `Detected as a bot: ${detection.isBot ? `*Yes* (${detection.signal})` : '*No*'}`
      );
    }

    const groupDoc = await Group.findOne({ id: chat.id._serialized }).select('antibot').lean();
    return msg.reply(
      `ℹ️ Anti-Bot is currently *${groupDoc?.antibot ? 'on' : 'off'}* for this group.\n\n` +
      `Usage: *${BOT_PREFIX}antibot on* | *${BOT_PREFIX}antibot off* | *${BOT_PREFIX}antibot id* (reply to a message)`
    );
  },

  // Exported for index.js (the listener) and for tests; the leading
  // underscore keeps them out of the command table.
  _handleAntibot,
  _detectBot: detectBot,
};
