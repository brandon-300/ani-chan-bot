// Format Numbers
// Fancy Unicode text (used by .profile, .feedback, etc.)
// Generated from plain ASCII at runtime instead of hardcoding the actual
// glyphs in source — same visual result, but avoids any risk of a
// mistyped/mis-copied Unicode character sitting invisibly in the file. Both
// are simple fixed offsets into the "Mathematical Alphanumeric Symbols"
// Unicode block; doubleStruck has a handful of letters (C, H, N, P, Q, R, Z)
// that live at their own legacy Letter-like Symbol codepoints instead of the
// main block, which is just how Unicode assigned them.
import User from '../models/User.js';
import identity from '../whatsapp/identity.js';
import groups from '../whatsapp/groups.js';
import { MIN_REGISTRATION_AGE } from './config.js';

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

// AniList description sanitizer
// AniList character descriptions come formatted with AniList's own markdown
// (bold/italic/strikethrough, spoiler markers, and — the one that was
// showing up raw in card views — [label](url) links to other AniList
// character pages) plus the occasional stray HTML tag. WhatsApp renders
// none of that, so it was showing up as literal bracket/paren text instead
// of a link.
//
// Single source of truth used in two places: commands/cardmanager.js calls
// this once when a description is first pulled from AniList, AND
// commands/cards.js calls it again at display time on whatever's already
// saved. The display-time call is what matters for descriptions that were
// saved to Mongo before this sanitizer existed (or gained the markdown-link
// step) — cleaning at display time fixes those retroactively with no
// database migration needed, since nothing about the stored data has to
// change for it to display correctly.
function cleanDescription(text) {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/~!|!~/g, '') // AniList spoiler markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [label](url) -> label
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
    .replace(/__([^_]+)__/g, '$1')     // __bold__
    .replace(/~~([^~]+)~~/g, '$1')     // ~~strikethrough~~
    .replace(/<[^>]+>/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Flexible Amount Parsing (K/M/B shorthand)
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

// Cooldown Helper
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

// Date of Birth Parsing & Age Calculation (.setdob)
// Single source of truth for both — used by commands/economy.js's .setdob.
// Strict DD/MM/YYYY only (matches the format shown in the .setdob usage text
// and the registration instructions below), parsed/validated in UTC to avoid
// any local-timezone off-by-one on day boundaries.
function parseDobInput(input) {
  if (!input) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(input).trim());
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);
  if (month < 1 || month > 12) return null;
  if (year < 1900) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  if (date.getTime() > Date.now()) return null;

  return date;
}

function calculateAge(dob, now = new Date()) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const hadBirthdayThisYear =
    now.getUTCMonth() > dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() >= dob.getUTCDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

// Registration Steps (.setname/.setdob/.bio/.setpic, commands/economy.js)
// Single source of truth for what counts as a "complete" profile and how to
// describe outstanding steps — read by BOTH the registration gate in
// index.js (deciding whether to block a command for an incomplete account)
// and the registration commands themselves in commands/economy.js (the
// "here's what's left" nudge after each step).
function registrationSteps(user) {
  const reg = (user && user.registration) || {};
  return [
    { done: !!reg.nameSet, label: 'Name', cmd: '.setname [name]' },
    { done: !!reg.dobSet, label: 'Date of birth', cmd: '.setdob [DD/MM/YYYY]' },
    { done: !!reg.bioSet, label: 'Bio', cmd: '.setbio [bio]  (alias: .bio)' },
    { done: !!reg.picSet, label: 'Profile picture', cmd: '.setpic (reply to a photo)' },
  ];
}

function isRegistrationComplete(user) {
  return registrationSteps(user).every(s => s.done);
}

function isVerifiedAdult(user) {
  if (!user || !user.registration || !user.registration.dobSet || !user.dob) return false;
  return calculateAge(user.dob) >= MIN_REGISTRATION_AGE;
}

function buildRegistrationProgressText(user) {
  const lines = registrationSteps(user).map(
    s => `${s.done ? '\u2705' : '\u274c'} ${s.label}${s.done ? '' : ` \u2014 ${s.cmd}`}`
  );
  return `\ud83d\udccb *Profile Progress*\n\n${lines.join('\n')}\n\n\u26a0\ufe0f Your profile isn't finished yet \u2014 complete the step(s) above to activate your account.`;
}

function buildRegistrationIntroText(botName) {
  return `\ud83d\udc4b Hey there! I'm *${botName}*, your anime companion.\n\n` +
    `Before you can use my features, start your profile registration in this private chat with *.reg*.\n\n` +
    `You must be 18 or older to register. Once you complete the existing profile steps, I'll activate your account and show you the command menu.`;
}

// Random Range
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Pick Random from Array
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Safe Chat Fetch (with retries)
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

// Safe Quoted-Message Fetch (with retries)
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

// Safe Contact Fetch (with retries)
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

// Generic Retry Wrapper
// Same retry-with-backoff shape as safeGetChat/safeGetQuotedMessage/
// safeGetContact above, generalized for anything else that can hit a
// transient failure on an unstable connection — most notably MongoDB
// operations.
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

// Robust sender display-name resolution
// WhatsApp's "LID" (Linked ID) privacy layer means group participants can
// show up as "@lid" instead of their phone number. The identity service
// now properly handles both LID and PN formats.
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

// Check if user is group admin
async function isAdmin(msg) {
  try {
    const chatId = msg?.chatId || msg?.from;
    if (!chatId?.endsWith('@g.us')) return false;
    const sender = identity.getSender(msg);
    if (!sender?.id) return false;
    return await groups.isAdmin(chatId, sender.id);
  } catch (err) {
    console.error('isAdmin: group admin status could not be verified:', err.message);
    return false;
  }
}

// Returns true/false normally, or null specifically when the chat fetch fails
// (connection glitch) — distinct from false, so callers don't confuse
// "couldn't verify" with "genuinely not an admin".
async function botIsAdmin(msg) {
  const chatId = msg?.chatId || msg?.from;
  if (!chatId?.endsWith('@g.us')) return false;
  try {
    return await groups.isBotAdmin(chatId);
  } catch (err) {
    console.error('botIsAdmin: group admin status could not be verified:', err.message);
    return null;
  }
}

// XP & Level
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
// which is exactly the old per-level cost.
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
  user.xp += amount;
  while (user.xp >= xpNeededForLevel(user.level + 1)) {
    user.level += 1;
    user.coins += user.level * 200;
  }
  const levelUp = user.level > startingLevel;
  await user.save();
  return { levelUp, level: user.level };
}

// Card Tier Roll
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
  return TIER_DROP_RATES[TIER_DROP_RATES.length - 1].tier;
}

// Tier Emoji
function tierEmoji(tier) {
  return { C: '\u26aa', B: '\ud83d\udfe2', A: '\ud83d\udd35', S: '\ud83d\udfe1', SS: '\ud83d\udfe0', SSS: '\ud83d\udd34' }[tier] || '\u26aa';
}

// Card Value by Tier
// Canonical ascending tier order — lowest to highest. Used by fusion (Phase
// 10) to find "the tier above" a given card.
const TIER_ORDER = ['C', 'B', 'A', 'S', 'SS', 'SSS'];

function tierAbove(tier, steps = 1) {
  const i = TIER_ORDER.indexOf(tier);
  if (i === -1) return null;
  return TIER_ORDER[i + steps] || null;
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
  return contact.name || contact.pushname || contact.number || contact.id?.user || 'Unknown';
}

// Real WhatsApp @mention text
// A message only gets an actual tappable @mention when its TEXT contains "@"
// followed by the exact digits from the contact's JID (contact.id.user) —
// that's what WhatsApp itself matches against the separate `mentions` array
// passed to sendMessage/reply to render the tag. mentionName() above returns
// a *display* name instead, for read-only text (leaderboards, etc.) — used
// as "@${mentionName(c)}" it looks like a mention but isn't one, since the
// digits WhatsApp needs aren't actually there; it just prints as plain text.
// Use this whenever the goal is a real, tappable mention.
//
// For Baileys v7 with LID support: use identity service for proper resolution
function mentionTag(contact) {
  if (!contact) return '';
  
  // Use identity service to get the canonical phone number
  // This handles both LID and PN formats properly
  const phoneNumber = identity.getPhoneNumber(contact.id?._serialized || contact.id || contact.number || '');
  
  if (!phoneNumber) return '';
  
  return phoneNumber;
}

// Owner/Mod Identification
// Use the identity service which properly handles both LID and PN formats
function isOwner(id) {
  return identity.isOwner(id);
}

// Bot-level moderators, distinct from WhatsApp group admins (isAdmin above) —
// people the owner trusts bot-wide, across every group, the same way
// OWNER_NUMBER already works. Configured as a comma-separated list of
// WhatsApp ids in MOD_NUMBERS; empty/unset means no mods configured yet.
// The owner always counts as a mod too.
function getModIds() {
  return (process.env.MOD_NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function isMod(id) {
  return identity.isMod(id) || isOwner(id);
}

// Map-Safe Key Encoding
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

// Export all helper functions
export {
  boldSans,
  doubleStruck,
  cleanDescription,
  formatNum,
  parseAmount,
  formatCooldown,
  parseDobInput,
  calculateAge,
  registrationSteps,
  isRegistrationComplete,
  isVerifiedAdult,
  buildRegistrationProgressText,
  buildRegistrationIntroText,
  rand,
  pick,
  safeGetChat,
  safeGetQuotedMessage,
  safeGetContact,
  withRetry,
  resolveSenderName,
  isAdmin,
  botIsAdmin,
  addXP,
  XP_REWARDS,
  xpNeededForLevel,
  rollTier,
  TIER_DROP_RATES,
  tierEmoji,
  TIER_ORDER,
  tierAbove,
  cardValue,
  TIER_VALUES,
  mentionName,
  mentionTag,
  isOwner,
  getModIds,
  isMod,
  encodeIdKey,
  decodeIdKey,
};
