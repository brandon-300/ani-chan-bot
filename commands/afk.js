// AFK is a property of the person, not a specific chat — keyed by WhatsApp
// id, not chatId, so it follows them across groups/DMs the same way a
// Discord-style AFK status would.
const afkUsers = new Map(); // id -> { reason, since }

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = {
  afkUsers,

  // .afk [reason]
  async afk(client, msg, args) {
    const contact = await msg.getContact();
    const reason = args.length ? capitalize(args.join(' ')) : 'No reason given';
    afkUsers.set(contact.id._serialized, { reason, since: Date.now() });
    msg.reply(`🛑 You are now AFK: ${reason}`);
  },

  // Called from index.js right before any recognized command actually
  // runs (see the dispatch loop there). If `senderId` has an active AFK
  // entry, sends the welcome-back message and clears it — regardless of
  // which command they just sent, including .afk itself (if so, they'll be
  // marked AFK again immediately after this runs, which is expected: they
  // just explicitly asked to be).
  // Prefixed with _ so the command loader in index.js (which auto-registers
  // every exported function as a slash command) doesn't turn this into a
  // callable .checkafkreturn command — it's only meant to be called
  // directly from the dispatch loop, the same convention already used by
  // _initCardDrops in commands/cards.js.
  async _checkAfkReturn(msg, senderId) {
    const entry = afkUsers.get(senderId);
    if (!entry) return;
    afkUsers.delete(senderId);
    const duration = formatDuration(Date.now() - entry.since);
    await msg.reply(`✅ *Welcome back!*\nYou had been AFK for ${duration}.\nReason: ${entry.reason}`);
  },
};
