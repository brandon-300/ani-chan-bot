const User = require('../models/User');

// ─── Format Numbers ───────────────────────────────────────────────────────────
function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Cooldown Helper ──────────────────────────────────────────────────────────
function formatCooldown(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

// ─── Random Range ─────────────────────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Pick Random from Array ───────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Safe Chat Fetch (with retries) ────────────────────────────────────────────
// msg.getChat() occasionally throws a generic WhatsApp-internal error when the
// connection is momentarily unstable. Usually transient, so retry a couple
// times with increasing backoff before giving up.
async function safeGetChat(msg, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await msg.getChat();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// ─── Safe Quoted-Message Fetch (with retries) ─────────────────────────────────
async function safeGetQuotedMessage(msg, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await msg.getQuotedMessage();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// ─── Safe Contact Fetch (with retries) ─────────────────────────────────────────
// msg.getContact() can hit the same transient WhatsApp-internal glitch as
// getChat()/getQuotedMessage() above. Same retry-with-backoff pattern.
async function safeGetContact(msg, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await msg.getContact();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// ─── Generic Retry Wrapper ──────────────────────────────────────────────────
// Same retry-with-backoff shape as safeGetChat/safeGetQuotedMessage/
// safeGetContact above, generalized for anything else that can hit a
// transient failure on an unstable connection — most notably MongoDB
// operations, which see the same kind of momentary timeout as WhatsApp's own
// calls do.
async function withRetry(fn, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// ─── Robust sender display-name resolution ─────────────────────────────────────
// WhatsApp's "LID" (Linked ID) privacy layer means group participants can
// show up as "@lid" instead of their phone number, and whatsapp-web.js has a
// known, currently-unresolved bug where getContact() can misresolve a @lid
// sender into the BOT'S OWN contact instead of throwing — so a broken lookup
// silently shows up as "Me" rather than failing loudly and triggering our
// usual fallback.
//
// This resolves a display name in three steps, each one only used if the
// previous one comes up empty/untrustworthy:
//   1. The push name WhatsApp attaches to the message itself
//      (msg._data.notifyName) — comes straight from the sender and doesn't
//      depend on contact/LID resolution at all, so the bug above can't touch it.
//   2. getContact(), but only if it doesn't look like the "resolved as me"
//      misfire (contact.isMe true while the id we looked up isn't the bot's).
//   3. The raw WhatsApp id as a last resort.
async function resolveSenderName(msg, client) {
  const senderId = msg.author || msg.from || '';

  const pushName = msg._data?.notifyName;
  if (pushName && pushName.trim()) return pushName.trim();

  try {
    const contact = await safeGetContact(msg, 1);
    const myId = client?.info?.wid?._serialized;
    if (contact.isMe && senderId !== myId) {
      return senderId.split('@')[0] || 'Unknown';
    }
    return mentionName(contact);
  } catch {
    return senderId.split('@')[0] || 'Unknown';
  }
}

// ─── Check if user is group admin ─────────────────────────────────────────────
async function isAdmin(msg) {
  let chat;
  try {
    chat = await msg.getChat();
  } catch (err) {
    console.error('isAdmin: could not get chat, skipping:', err.message);
    return false;
  }
  if (!chat || !chat.isGroup) return false;
  const contact = await msg.getContact();
  const participant = chat.participants.find(
    p => p.id._serialized === contact.id._serialized
  );
  return participant && (participant.isAdmin || participant.isSuperAdmin);
}

// ─── Check if bot is admin ────────────────────────────────────────────────────
// Returns true/false normally, or null specifically when the chat fetch fails
// (connection glitch) — distinct from false, so callers don't confuse
// "couldn't verify" with "genuinely not an admin".
async function botIsAdmin(msg) {
  let chat;
  try {
    chat = await msg.getChat();
  } catch (err) {
    console.error('botIsAdmin: could not get chat, skipping:', err.message);
    return null;
  }
  if (!chat || !chat.isGroup) return false;
  const botId = msg.to;
  const participant = chat.participants.find(p => p.id._serialized === botId);
  return participant && (participant.isAdmin || participant.isSuperAdmin);
}

// ─── XP & Level ──────────────────────────────────────────────────────────────
async function addXP(userId, amount) {
  const user = await User.findOne({ id: userId });
  if (!user) return;
  user.xp += amount;
  const nextLevel = user.level * 100;
  if (user.xp >= nextLevel) {
    user.xp -= nextLevel;
    user.level += 1;
    user.coins += user.level * 200;
    return { levelUp: true, level: user.level };
  }
  await user.save();
  return { levelUp: false };
}

// ─── Card Tier Roll ───────────────────────────────────────────────────────────
// Drop rates:
//   C   70%
//   B   20%
//   A   7.5%
//   S   2%
//   SS  0.4%
//   SSS 0.1%  (ultra-rare, above SS)
function rollTier() {
  const r = Math.random() * 100;
  if (r < 70) return 'C';
  if (r < 90) return 'B';
  if (r < 97.5) return 'A';
  if (r < 99.5) return 'S';
  if (r < 99.9) return 'SS';
  return 'SSS';
}

// ─── Tier Emoji ───────────────────────────────────────────────────────────────
function tierEmoji(tier) {
  return { C: '⚪', B: '🟢', A: '🔵', S: '🟡', SS: '🟠', SSS: '🔴' }[tier] || '⚪';
}

// ─── Card Value by Tier ───────────────────────────────────────────────────────
// Canonical ascending tier order — lowest to highest. Used by fusion (Phase
// 10) to find "the tier above" a given card.
const TIER_ORDER = ['C', 'B', 'A', 'S', 'SS', 'SSS'];

function tierAbove(tier, steps = 1) {
  const i = TIER_ORDER.indexOf(tier);
  if (i === -1) return null;
  return TIER_ORDER[i + steps] || null; // null if already at/above the top
}

// Baseline coin value per tier. Used by .cardinfo, leaderboards, and auctions
// (starting/reserve prices) in later phases — not surfaced anywhere yet.
const TIER_VALUES = {
  C: 500,
  B: 2000,
  A: 5000,
  S: 10000,
  SS: 25000,
  SSS: 100000
};

function cardValue(tier) {
  return TIER_VALUES[tier] || 0;
}

function mentionName(contact) {
  return contact.name || contact.pushname || contact.number || 'Unknown';
}

function isOwner(id) {
  return id === process.env.OWNER_NUMBER;
}

// ─── Resolve a display name from a raw WhatsApp id ────────────────────────────
// Guilds (and anything else storing bare ids like leaderId/members[]) only
// have the WhatsApp id string to go on, not a live Contact object. This
// resolves the best available display name:
//   1. Our own User.name (set on first interaction, or via .setname) — no
//      network round-trip needed, works even if the person left every group.
//   2. client.getContactById() → mentionName() as a fallback for users the
//      bot has never seen a command from yet.
//   3. The raw phone-number portion of the id as a last resort.
async function resolveNameById(client, id) {
  if (!id) return 'Unknown';
  try {
    const user = await User.findOne({ id });
    if (user?.name && user.name !== 'Unknown') return user.name;
  } catch (err) {
    console.error('resolveNameById: User lookup failed:', err.message);
  }
  try {
    const contact = await client.getContactById(id);
    // Same known whatsapp-web.js bug documented on resolveSenderName above:
    // getContactById() can misresolve a @lid id into the bot's OWN contact
    // instead of throwing — which previously showed up here as a real but
    // completely unrelated name (the bot account's own registered profile
    // name) for whoever we were actually looking up. Guard against it the
    // same way: don't trust a contact claiming to be "me" unless the id we
    // looked up actually was the bot's own.
    const myId = client?.info?.wid?._serialized;
    if (!(contact.isMe && id !== myId)) {
      const name = mentionName(contact);
      if (name && name !== 'Unknown') return name;
    }
  } catch (err) {
    // Not fatal — likely a contact the bot can't resolve (left all shared groups, etc).
  }
  return id.split('@')[0] || 'Unknown';
}

// ─── Generic unique 6-char code generator ─────────────────────────────────────
// Used for anything that needs a short, human-typeable ID (shop listings,
// auctions, etc). Pass the mongoose Model and the field name to check against.
async function generateUniqueCode(Model, field = 'code') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skips ambiguous 0/O/1/I
  let code;
  let exists = true;
  while (exists) {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    exists = await Model.findOne({ [field]: code });
  }
  return code;
}

module.exports = {
  formatNum,
  formatCooldown,
  rand,
  pick,
  isAdmin,
  botIsAdmin,
  addXP,
  rollTier,
  tierEmoji,
  TIER_VALUES,
  TIER_ORDER,
  tierAbove,
  cardValue,
  mentionName,
  isOwner,
  resolveNameById,
  generateUniqueCode,
  safeGetChat,
  safeGetQuotedMessage,
  safeGetContact,
  withRetry,
  resolveSenderName
};
