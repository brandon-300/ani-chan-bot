const { formatCooldown, resolveNameById } = require('../utils/helpers');

// AFK is a property of the person, not a specific chat — keyed by WhatsApp
// id, not chatId, so it follows them across groups/DMs the same way a
// Discord-style AFK status would.
const afkUsers = new Map(); // id -> { reason, since }

// Tracks the last time each person used a recognized command, regardless of
// whether they ever ran .afk themselves. Powers the automatic "welcome
// back" below: if someone goes quiet for over AUTO_AFK_THRESHOLD_MS and then
// sends another command, they're treated as having been away even though
// they never explicitly set themselves AFK. Kept separate from afkUsers so
// the two never interfere with each other: an explicit .afk still always
// shows its own reason-based welcome-back (and clears immediately after,
// exactly as before) — this map just tracks everyone's activity in the
// background.
const lastActive = new Map(); // id -> timestamp

const AUTO_AFK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

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
  // 2. Automatic AFK — otherwise, if it's been over AUTO_AFK_THRESHOLD_MS
  //    since this person's last recognized command (tracked in lastActive,
  //    regardless of whether they ever ran .afk), treat that gap itself as
  //    an AFK period and welcome them back the same way, just without a
  //    reason. Someone's very first command ever has no lastActive entry
  //    yet, so it's correctly skipped rather than treated as an absence.
  //
  // Either way, lastActive is stamped to "now" at the end, so the clock
  // always measures from this person's most recent command.
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

  // Called from a dedicated client.on('message') listener in index.js, for
  // EVERY incoming message — not just recognized commands, since mentioning
  // someone doesn't require the mentioner to run a command themselves. If
  // any @-mentioned person is currently AFK, replies once per mentioned AFK
  // person with their reason and how long they've been away, e.g.:
  //   🔔 *Kurayami* is currently AFK: AFK
  //   ▎(since 2h 44m 22s ago)
  //
  // msg.mentionedIds isn't guaranteed to already be in the same id format
  // afkUsers was keyed under — see the @lid-vs-phone-number id
  // inconsistency documented elsewhere in this codebase (resolveSenderName,
  // isOwner, the Group activity-log fix). Falls back to resolving each id's
  // canonical form through getContactById() before giving up on it.
  //
  // Prefixed with _ for the same reason as _checkAfkReturn above.
  async _checkAfkMentions(client, msg) {
    if (!msg.mentionedIds || msg.mentionedIds.length === 0) return;
    if (afkUsers.size === 0) return; // nobody's AFK — skip all the lookups

    const seen = new Set(); // a message can @-mention the same person twice
    for (const rawId of msg.mentionedIds) {
      if (seen.has(rawId)) continue;
      seen.add(rawId);

      let canonicalId = rawId;
      let entry = afkUsers.get(rawId);
      if (!entry) {
        try {
          const contact = await client.getContactById(rawId);
          canonicalId = contact.id._serialized;
          entry = afkUsers.get(canonicalId);
        } catch (err) {
          // Contact lookup failed — nothing more we can try for this id.
        }
      }
      if (!entry) continue;

      const name = await resolveNameById(client, canonicalId);
      const duration = formatCooldown(Date.now() - entry.since);
      await msg.reply(`🔔 _*${name}*_ is currently AFK: ${entry.reason}\n▎(since ${duration} ago)`);
    }
  },
};
