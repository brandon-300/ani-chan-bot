const User = require('../models/User');

// ─── Format Numbers ───────────────────────────────────────────────────────────
// ─── Fancy Unicode text (used by .profile, .feedback, etc.) ──────────────────
// Generated from plain ASCII at runtime instead of hardcoding the actual
// glyphs in source — same visual result, but avoids any risk of a
// mistyped/mis-copied Unicode character sitting invisibly in the file. Both
// are simple fixed offsets into the "Mathematical Alphanumeric Symbols"
// Unicode block; doubleStruck has a handful of letters (C, H, N, P, Q, R, Z)
// that live at their own legacy Letter-like Symbol codepoints instead of the
// main block, which is just how Unicode assigned them.
function boldSans(text) {
  return [...text].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));   // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));  // a-z
    return ch;
  }).join('');
}
function doubleStruck(text) {
  const legacy = { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 };
  return [...text].map(ch => {
    if (legacy[ch]) return String.fromCodePoint(legacy[ch]);
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D538 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D552 + (code - 97));
    return ch;
  }).join('');
}

function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── Flexible Amount Parsing (K/M/B shorthand) ────────────────────────────────
// Accepts plain integers ("50000") as well as shorthand people actually type
// on a phone keyboard ("50k", "1.5m", "2B"), case-insensitive, with optional
// thousands separators ("1,500,000"). Returns a positive integer (rounded)
// on success, or null on anything that doesn't parse — callers should treat
// null exactly like a failed parseInt() (i.e. show a usage error), same as
// every existing amount field in the bot already does.
function parseAmount(input) {
  if (input === undefined || input === null) return null;
  const str = String(input).trim().toLowerCase().replace(/,/g, '');
  const match = str.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const base = parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const value = Math.round(base * (multipliers[match[2]] || 1));
  return value > 0 ? value : null;
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
// XP granted per action. Numbers are a starting point — tune freely, nothing
// else needs to change since every caller reads from this one table.
const XP_REWARDS = {
  claim: 20,
  shopBuy: 15,
  trade: 10,
  fusion: 30,
  daily: 25,
};

// DESIGN CHANGE (Aug 2026): user.xp is now a LIFETIME cumulative total that
// only ever goes up — it used to reset to a leftover remainder at every
// level-up (e.g. Level 2 at 25 XP into that level displayed as just "25",
// not "125" total). Levels still cost exactly the same as before — this
// only changes what gets displayed/stored, not how fast you level.
//
// xpNeededForLevel(N) = cumulative lifetime XP required to REACH level N.
// Levels still each cost `level * 100` XP to clear (unchanged from before):
// the gap between consecutive thresholds is
//   xpNeededForLevel(N+1) - xpNeededForLevel(N) = 50*N*(N+1) - 50*N*(N-1) = 100*N
// which is exactly the old per-level cost. Level 1 = 0, Level 2 = 100,
// Level 3 = 300, Level 4 = 600, Level 5 = 1000, etc.
function xpNeededForLevel(level) {
  return 50 * level * (level - 1);
}

// BUGFIX (Aug 2026): the level-up branch used to `return` before ever calling
// user.save() — so every level-up computed correctly in memory and then
// silently discarded itself. Only the no-level-up path actually persisted.
// Also switched the single `if` to a `while` so a big enough XP grant can
// correctly carry a user through more than one level in one call, instead of
// only ever advancing one level per call regardless of how much XP came in.
async function addXP(userId, amount) {
  const user = await User.findOne({ id: userId });
  if (!user) return { levelUp: false };
  const startingLevel = user.level;
  user.xp += amount; // cumulative — never decremented, see note above
  while (user.xp >= xpNeededForLevel(user.level + 1)) {
    user.level += 1;
    user.coins += user.level * 200;
  }
  const levelUp = user.level > startingLevel;
  await user.save();
  return { levelUp, level: user.level };
}

// ─── Card Tier Roll ───────────────────────────────────────────────────────────
// Cumulative drop-rate thresholds, single source of truth for rollTier() below
// AND for the .tier command (commands/cards.js), which displays these odds to
// users. Exported (rather than kept as private magic numbers inside rollTier)
// specifically so that command can never show a stale percentage if these
// thresholds ever change — it always derives what it prints from this table.
//   C   70%    (0   - 70)
//   B   20%    (70  - 90)
//   A   7.5%   (90  - 97.5)
//   S   2%     (97.5- 99.5)
//   SS  0.4%   (99.5- 99.9)
//   SSS 0.1%   (99.9-100)  (ultra-rare, above SS)
const TIER_DROP_RATES = [
  { tier: 'C', cumulative: 70 },
  { tier: 'B', cumulative: 90 },
  { tier: 'A', cumulative: 97.5 },
  { tier: 'S', cumulative: 99.5 },
  { tier: 'SS', cumulative: 99.9 },
  { tier: 'SSS', cumulative: 100 },
];

function rollTier() {
  const r = Math.random() * 100;
  for (const { tier, cumulative } of TIER_DROP_RATES) {
    if (r < cumulative) return tier;
  }
  return TIER_DROP_RATES[TIER_DROP_RATES.length - 1].tier; // r === 100 edge case
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

// ─── Real WhatsApp @mention text ──────────────────────────────────────────────
// A message only gets an actual tappable @mention when its TEXT contains "@"
// followed by the exact digits from the contact's JID (contact.id.user) —
// that's what WhatsApp itself matches against the separate `mentions` array
// passed to sendMessage/reply to render the tag. mentionName() above returns
// a *display* name instead, for read-only text (leaderboards, etc.) — used
// as "@${mentionName(c)}" it looks like a mention but isn't one, since the
// digits WhatsApp needs aren't actually there; it just prints as plain text.
// Use this whenever the goal is a real, tappable mention.
function mentionTag(contact) {
  return contact.id.user;
}

// WhatsApp's LID privacy layer means the same account can arrive under two
// different ids depending on context — its normal phone-based JID, or a
// "@lid" id — and there's no guarantee a message from the owner always
// carries the same one (same underlying whatsapp-web.js quirk documented on
// resolveSenderName above, just biting a raw id comparison here instead of a
// display name). A single OWNER_NUMBER can't cover both, so this also
// checks an optional OWNER_IDS env var — a comma-separated list of any other
// ids that should also count as the owner. To find the exact id to add: run
// any command that logs the sender id (.feedback does) from the affected
// chat, then check pm2 logs for the full id it printed.
function ownerIds() {
  const extra = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return [process.env.OWNER_NUMBER, ...extra].filter(Boolean);
}

function isOwner(id) {
  return ownerIds().includes(id);
}

// ─── Moderators ──────────────────────────────────────────────────────────────
// Bot-level moderators, distinct from WhatsApp group admins (isAdmin above) —
// people the owner trusts bot-wide, across every group, the same way
// OWNER_NUMBER already works. Configured as a comma-separated list of
// WhatsApp ids in MOD_NUMBERS; empty/unset means no mods configured yet.
// The owner always counts as a mod too.
function getModIds() {
  return (process.env.MOD_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isMod(id) {
  return isOwner(id) || getModIds().includes(id);
}
// ─── Map-Safe Key Encoding ─────────────────────────────────────────────────────
// Mongoose's Map schema type hard-rejects any key containing "." — it throws
// 'Mongoose maps do not support keys that contain "."' from checkValidKey()
// any time a Map value is fully cast (.set() on a document, $set updates).
// WhatsApp ids like "234801234567@c.us" always contain one, so they can never
// be used as literal Map keys (activityLog: Map of Number). "~" never appears
// in a WhatsApp id, so swapping it in for "." is a safe, reversible encoding.
// Encode before writing an id as a Map key; decode a Map key back before
// treating it as a real id again (comparing to botId, resolveNameById(), etc).
function encodeIdKey(id) {
  return String(id).replace(/\./g, '~');
}
function decodeIdKey(key) {
  return String(key).replace(/~/g, '.');
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
  boldSans,
  doubleStruck,
  formatNum,
  parseAmount,
  formatCooldown,
  rand,
  pick,
  isAdmin,
  isMod,
  getModIds,
  botIsAdmin,
  addXP,
  XP_REWARDS,
  xpNeededForLevel,
  rollTier,
  tierEmoji,
  TIER_VALUES,
  TIER_DROP_RATES,
  TIER_ORDER,
  tierAbove,
  cardValue,
  mentionName,
  mentionTag,
  isOwner,
  resolveNameById,
  generateUniqueCode,
  safeGetChat,
  safeGetQuotedMessage,
  safeGetContact,
  withRetry,
  resolveSenderName,
  encodeIdKey,
  decodeIdKey
};
