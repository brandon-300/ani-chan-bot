const { formatCooldown } = require('../utils/helpers');

// AFK is a property of the person, not a specific chat — keyed by WhatsApp
// id, not chatId, so it follows them across groups/DMs the same way a
// Discord-style AFK status would.
const afkUsers = new Map(); // id -> { reason, since }

// Tracks the last time each person used a recognized command, regardless of
// whether they ever ran .afk themselves. Powers the automatic "welcome
// back" below: if someone goes quiet for over an hour and then sends
// another command, they're treated as having been away even though they
// never explicitly set themselves AFK. Kept separate from afkUsers so the
// two never interfere with each other: an explicit .afk still always shows
// its own reason-based welcome-back (and clears immediately after, exactly
// as before) — this map just tracks everyone's activity in the background.
const lastActive = new Map(); // id -> timestamp

const AUTO_AFK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = {
  afkUsers,
  lastActive,

  // .afk [reason]
  async afk(client, msg, args) {
    const contact = await msg.getContact();
    const reason = args.length ? capitalize(args.join(' ')) : 'No reason given';
    afkUsers.set(contact.id._serialized, { reason, since: Date.now() });
    msg.reply(`🛑 You are now AFK: ${reason}`);
  },

  // Called from index.js right before any recognized command actually
  // runs (see the dispatch loop there) — for every command, in both groups
  // and DMs, since that dispatch loop handles both. Two things happen
  // here, in order:
  //
  // 1. Explicit AFK (.afk [reason]) — if `senderId` has an active entry,
  //    send the reason-based welcome-back and clear it. Unchanged from
  //    before.
  // 2. Automatic AFK — otherwise, if it's been over an hour since this
  //    person's last recognized command (tracked in lastActive, regardless
  //    of whether they ever ran .afk), treat that gap itself as an AFK
  //    period and welcome them back the same way, just without a reason.
  //    Someone's very first command ever has no lastActive entry yet, so
  //    it's correctly skipped rather than treated as an hour+ absence.
  //
  // Either way, lastActive is stamped to "now" at the end, so the 1-hour
  // clock always measures from this person's most recent command.
  //
  // Prefixed with _ so the command loader in index.js (which auto-registers
  // every exported function as a slash command) doesn't turn this into a
  // callable .checkafkreturn command — it's only meant to be called
  // directly from the dispatch loop, the same convention already used by
  // _initCardDrops in commands/cards.js.
  async _checkAfkReturn(msg, senderId) {
    const entry = afkUsers.get(senderId);
    if (entry) {
      afkUsers.delete(senderId);
      const duration = formatCooldown(Date.now() - entry.since);
      await msg.reply(`✅ *Welcome back!*\nYou had been AFK for ${duration}.\nReason: ${entry.reason}`);
    } else {
      const last = lastActive.get(senderId);
      if (last && Date.now() - last >= AUTO_AFK_THRESHOLD_MS) {
        const duration = formatCooldown(Date.now() - last);
        await msg.reply(`✅ *Welcome back!*\nYou had been away for ${duration}.`);
      }
    }
    lastActive.set(senderId, Date.now());
  },
};
