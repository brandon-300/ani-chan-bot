const { formatCooldown, resolveNameById } = require('../utils/helpers');
const User = require('../models/User');

// AFK is a property of the person, not a specific chat — keyed by WhatsApp
// id, not chatId, so it follows them across groups/DMs the same way a
// Discord-style AFK status would.
//
// Persisted in Mongo (User.afk — see models/User.js) so a PM2 restart
// doesn't silently drop someone's AFK status, but this Map stays the
// actual source of truth WHILE the bot is running: _checkAfkReturn and
// _checkAfkMentions below run on every single incoming message across
// every group (not just recognized commands — see the Aug 2026 bugfix
// note on their listeners in index.js), so reading this Map instead of
// querying Mongo on every message keeps that hot path exactly as fast as
// before. Mongo is only written to on the low-frequency .afk/welcome-back
// events, and only read back once at boot (_initAfk) to rehydrate this Map
// after a restart.
const afkUsers = new Map(); // id -> { reason, since }

// Called once from index.js on bot startup — same pattern as
// _initCardDrops in commands/cards.js. Rehydrates afkUsers from whoever
// was still marked AFK in Mongo when the bot last stopped, so a restart
// doesn't quietly clear everyone's AFK status.
async function _initAfk() {
  const stillAfk = await User.find({ 'afk.active': true }).catch(err => {
    console.error('_initAfk: lookup failed:', err.message);
    return [];
  });
  for (const user of stillAfk) {
    afkUsers.set(user.id, { reason: user.afk.reason, since: user.afk.since.getTime() });
  }
  if (stillAfk.length) {
    console.log(`😴 Restored ${stillAfk.length} pending AFK status(es)`);
  }
}

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
  _initAfk,

  // .afk [reason]
  async afk(client, msg, args) {
    const contact = await msg.getContact();
    const reason = args.length ? capitalize(args.join(' ')) : 'No reason given';
    const since = Date.now();
    afkUsers.set(contact.id._serialized, { reason, since });

    // Low-frequency write (once per .afk, not per message) — safe to await
    // without affecting the hot per-message path above.
    const user = await User.findOrCreate(contact.id._serialized, contact.pushname);
    user.afk = { active: true, reason, since: new Date(since) };
    await user.save().catch(err => console.error('afk: persist failed:', err.message));

    return msg.reply(`🛑 You are now AFK: ${reason}`);
  },

  // Called from a standalone client.on('message') listener in index.js
  // for EVERY incoming message, not just recognized commands (see that
  // listener's Aug 2026 bugfix comment for why). Two things happen here,
  // in order:
  //
  // 1. Explicit AFK (.afk [reason]) — if `senderId` has an active entry,
  //    send the reason-based welcome-back and clear it (both the in-memory
  //    Map and, in the background, Mongo — see afkUsers' comment above for
  //    why Mongo isn't read/written on this hot path itself).
  // 2. Automatic AFK — otherwise, if it's been over AUTO_AFK_THRESHOLD_MS
  //    since this person's last recognized command (tracked in lastActive,
  //    regardless of whether they ever ran .afk), treat that gap itself as
  //    an AFK period and welcome them back the same way, just without a
  //    reason. Someone's very first command ever has no lastActive entry
  //    yet, so it's correctly skipped rather than treated as an absence.
  //    Purely in-memory — see lastActive's own comment above for why this
  //    one deliberately isn't persisted to Mongo.
  //
  // Either way, lastActive is stamped to "now" at the end, so the clock
  // always measures from this person's most recent command.
  //
  // Prefixed with _ so the command loader in index.js (which auto-registers
  // every exported function as a slash command) doesn't turn this into a
  // callable .checkafkreturn command — it's only meant to be called
  // directly from that listener, the same convention already used by
  // _initCardDrops in commands/cards.js.
  async _checkAfkReturn(msg, senderId) {
    const entry = afkUsers.get(senderId);
    if (entry) {
      afkUsers.delete(senderId);
      User.findOneAndUpdate(
        { id: senderId },
        { $set: { 'afk.active': false, 'afk.reason': null, 'afk.since': null } }
      ).catch(err => console.error('_checkAfkReturn: clear failed:', err.message));
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
