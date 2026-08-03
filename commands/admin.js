const Group = require('../models/Group');
const User = require('../models/User');
const { isAdmin, botIsAdmin, mentionName, isOwner, safeGetChat, safeGetQuotedMessage, resolveNameById, withRetry, decodeIdKey } = require('../utils/helpers');

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function requireAdmin(msg) {
  const contact = await msg.getContact().catch(() => null);
  if (contact && isOwner(contact.id._serialized)) return true;

  const ok = await isAdmin(msg);
  if (!ok) { msg.reply('❌ Admins only!'); return false; }
  return true;
}

async function requireBotAdmin(msg) {
  const ok = await botIsAdmin(msg);
  if (ok === null) { msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.'); return false; }
  if (!ok) { msg.reply('❌ Make me an admin first!'); return false; }
  return true;
}

async function getOrCreateGroup(chatId) {
  return Group.findOneAndUpdate({ id: chatId }, {}, { upsert: true, new: true });
}

// ─── Participant snapshot (fallback for empty join/leave recipients) ─────────
// notification.getRecipients() resolves from WhatsApp's own `recipients`
// field on the raw event. That's populated reliably when an admin explicitly
// adds someone ('add') or for a linked-community join ('linked_group_join'),
// but WhatsApp Web commonly sends it EMPTY for someone joining via invite
// link ('invite') — a gap in what WhatsApp itself sends, not something a
// better call on our end can fix directly. That's the concrete reason
// welcome messages "didn't work" specifically for invite-link joins even
// though the code looked correct.
//
// Workaround: keep our own snapshot of each group's participant list. If the
// event's own recipients come back empty, diff the chat's current
// (post-join/leave) participant list against the last snapshot taken for
// that chat to figure out who actually joined or left, then resolve those
// ids to Contacts ourselves. Assumes chat.participants already reflects the
// join/leave by the time the notification fires — true in every case this
// was checked against, but flagging it since it's WhatsApp Web's internal
// timing, not something this library or this code controls.
const lastParticipants = new Map(); // chatId -> Set<participantId>

// Seeds the snapshot for every group the bot is currently in. Called once
// from index.js's 'ready' handler (same pattern as _initCardDrops in
// commands/cards.js) so the very first join/leave event for each group
// already has a baseline to diff against, instead of either treating every
// existing member as a new joiner or having nothing to compare a leave to.
async function _seedParticipants(client) {
  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (!chat.isGroup) continue;
      lastParticipants.set(
        chat.id._serialized,
        new Set(chat.participants.map(p => p.id._serialized))
      );
    }
    console.log(`👥 Seeded participant snapshots for ${lastParticipants.size} group(s)`);
  } catch (err) {
    console.error('Participant snapshot failed:', err.message);
  }
}

// Shared by onJoin/onLeave: returns the affected Contacts, falling back to
// diffing against the snapshot when the event itself gave us nothing, then
// always refreshes the snapshot to the chat's current membership so the
// next join/leave event has an up-to-date baseline — this runs regardless
// of whether welcome/leave messages are even turned on for this group, so
// the snapshot never goes stale just because a toggle is off.
async function resolveJoinLeaveRecipients(client, chat, notification, { isJoin }) {
  const chatId = chat.id._serialized;
  const currentIds = chat.participants.map(p => p.id._serialized);
  const previous = lastParticipants.get(chatId);
  lastParticipants.set(chatId, new Set(currentIds));

  let recipients = await notification.getRecipients();
  if (recipients.length || !previous) return recipients;

  const currentSet = new Set(currentIds);
  const diffIds = isJoin
    ? currentIds.filter(id => !previous.has(id))
    : [...previous].filter(id => !currentSet.has(id));
  if (!diffIds.length) return [];

  const resolved = await Promise.all(
    diffIds.map(id => client.getContactById(id).catch(() => null))
  );
  return resolved.filter(Boolean);
}

// ─── Welcome/Leave Event Handlers (called from index.js) ─────────────────────
async function onJoin(client, notification) {
  const chat = await notification.getChat();

  // notification.getContact() resolves to `author` — the person who
  // PERFORMED the join action, not the person who actually joined. For the
  // 'add' subtype (an admin adds someone) that's the admin, not the new
  // member, so this was welcoming the wrong person. resolveJoinLeaveRecipients
  // always resolves the actual joiner(s), correct for every join path:
  // admin-add, invite link, or linked-group join (see its comment above for
  // why the invite-link path specifically needed a fallback beyond just
  // calling notification.getRecipients() directly).
  const recipients = await resolveJoinLeaveRecipients(client, chat, notification, { isJoin: true });

  const group = await Group.findOne({ id: chat.id._serialized });
  if (!group?.welcome) return;
  if (!recipients.length) return;

  let welcomeMsg = group.welcomeMsg || '👋 Welcome to the group, @user!';
  const tags = recipients.map(c => `@${mentionName(c)}`).join(' ');
  welcomeMsg = welcomeMsg.replace('@user', tags);

  await chat.sendMessage(welcomeMsg, { mentions: recipients });
}

async function onLeave(client, notification) {
  const chat = await notification.getChat();

  // Same author-vs-recipient issue as onJoin above, plus the same
  // invite-link-style empty-recipients gap can happen on the leave side too
  // (e.g. someone leaving on their own) — resolveJoinLeaveRecipients covers
  // both.
  const recipients = await resolveJoinLeaveRecipients(client, chat, notification, { isJoin: false });

  // Guild membership needs to stay in sync whenever someone leaves a
  // WhatsApp group the bot is in — independent of whether this group has
  // leave-messages turned on, so this runs before that check/early-return.
  for (const contact of recipients) {
    try {
      const { _removeMemberFromGuild } = require('./guilds');
      await _removeMemberFromGuild(contact.id._serialized);
    } catch (err) {
      console.error('Guild cleanup on group_leave failed:', err.message);
    }
  }

  if (!recipients.length) return;

  const group = await Group.findOne({ id: chat.id._serialized });
  if (!group?.leave) return;

  let leaveMsg = group.leaveMsg || '👋 @user has left the group.';
  const tags = recipients.map(c => `@${mentionName(c)}`).join(' ');
  leaveMsg = leaveMsg.replace('@user', tags);

  await chat.sendMessage(leaveMsg, { mentions: recipients });
}

module.exports = {
  commands: { onJoin, onLeave },
  _seedParticipants,

  // .kick @user
  async kick(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to kick.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    for (const user of mentioned) {
      try {
        await chat.removeParticipants([user.id._serialized]);
        msg.reply(`👢 @${mentionName(user)} has been kicked.`);
      } catch {
        msg.reply(`❌ Could not kick @${mentionName(user)}.`);
      }
    }
  },

  // .delete — delete a replied message
  async delete(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const quoted = await safeGetQuotedMessage(msg).catch(err => { console.error("getQuotedMessage failed:", err.message); return 'ERROR'; });
    if (quoted === 'ERROR') return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!quoted) return msg.reply('❌ Reply to a message to delete it.');
    try {
      await quoted.delete(true);
      await msg.delete(true);
    } catch {
      msg.reply('❌ Could not delete message.');
    }
  },

  // .antilink
  async antilink(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);

    group.antilink = !group.antilink;
    await group.save();
    msg.reply(`🔗 Anti-link is now *${group.antilink ? 'ON' : 'OFF'}*`);
  },

  // .antilink action [warn/kick]
  async antilinkaction(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const action = args[0]?.toLowerCase();
    if (!['warn', 'kick'].includes(action)) return msg.reply('❌ Usage: .antilink action [warn/kick]');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);
    group.antilinkAction = action;
    await group.save();
    msg.reply(`✅ Anti-link action set to *${action}*`);
  },

  // .antism on/off
  async antism(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const sub = args[0]?.toLowerCase();
    if (!['on', 'off'].includes(sub)) return msg.reply('❌ Usage: .antism [on/off]');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);
    group.antispam = sub === 'on';
    await group.save();
    msg.reply(`🚫 Anti-spam is now *${group.antispam ? 'ON' : 'OFF'}*`);
  },

  // .warn @user [reason]
  async warn(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .warn @user [reason]');

    const reason = args.slice(1).join(' ') || 'No reason given';
    const target = mentioned[0];
    const user = await User.findOrCreate(target.id._serialized);
    user.warns += 1;
    await user.save();

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    chat.sendMessage(
       `⚠️ *Warning* for @${mentionName(target)}\n\nReason: ${reason}\nTotal warns: ${user.warns}/3\n${user.warns >= 3 ? '🔴 Auto-kick threshold reached!' : ''}`,
      { mentions: [target] }
    );

    if (user.warns >= 3 && await botIsAdmin(msg)) {
      await chat.removeParticipants([target.id._serialized]);
      chat.sendMessage(`👢 @${mentionName(target)} was auto-kicked after 3 warnings.`, { mentions: [target] });
    }
  },

  // .resetwarn @user
  async resetwarn(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to reset warns.');

    const user = await User.findOrCreate(mentioned[0].id._serialized);
    user.warns = 0;
    await user.save();
     msg.reply(`✅ Warnings reset for @${mentionName(mentioned[0])}.`);
  },

  // .groupstats
  async groupstats(client, msg, args) {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await withRetry(() => Group.findOne({ id: chat.id._serialized }))
      .catch(err => { console.error('groupstats: Group lookup failed:', err.message); return null; });
    const totalMembers = chat.participants.length;
    const admins = chat.participants.filter(p => p.isAdmin || p.isSuperAdmin).length;

    msg.reply(
      `📊 *Group Stats*\n\n👥 Members: ${totalMembers}\n👑 Admins: ${admins}\n🔗 Anti-link: ${group?.antilink ? '✅' : '❌'}\n🚫 Anti-spam: ${group?.antispam ? '✅' : '❌'}\n👋 Welcome: ${group?.welcome ? '✅' : '❌'}\n🔞 NSFW: ${group?.nsfw ? '✅' : '❌'}\n🎴 Cards: ${group?.cardsEnabled ? '✅' : '❌'}\n📨 Messages: ${group?.messageCount || 0}`
    );
  },

  // .welcome on/off
  async welcome(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const sub = args[0]?.toLowerCase();
    if (!['on', 'off'].includes(sub)) return msg.reply('❌ Usage: .welcome [on/off]');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);
    group.welcome = sub === 'on';
    await group.save();
    msg.reply(`👋 Welcome message is now *${group.welcome ? 'ON' : 'OFF'}*`);
  },

  // .setwelcome [message] — use @user as placeholder
  async setwelcome(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const welcomeMsg = args.join(' ');
    if (!welcomeMsg) return msg.reply('❌ Usage: .setwelcome [message]\n\nUse @user as a placeholder for the new member\'s name.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);
    group.welcomeMsg = welcomeMsg;
    await group.save();
    msg.reply(`✅ Welcome message set:\n\n${welcomeMsg}`);
  },

  // .leave on/off
  async leave(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const sub = args[0]?.toLowerCase();
    if (!['on', 'off'].includes(sub)) return msg.reply('❌ Usage: .leave [on/off]');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);
    group.leave = sub === 'on';
    await group.save();
    msg.reply(`👋 Leave message is now *${group.leave ? 'ON' : 'OFF'}*`);
  },

  // .setleave [message]
  async setleave(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const leaveMsg = args.join(' ');
    if (!leaveMsg) return msg.reply('❌ Usage: .setleave [message]\n\nUse @user as a placeholder.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);
    group.leaveMsg = leaveMsg;
    await group.save();
    msg.reply(`✅ Leave message set:\n\n${leaveMsg}`);
  },

  // .purge [count] — delete last N messages
  async purge(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const count = parseInt(args[0]) || 10;
    msg.reply(`🗑️ Purging ${count} messages... (Note: WhatsApp limits bulk delete. Messages will be deleted one by one.)`);
    // WhatsApp Web JS doesn't support bulk delete; guide user
    msg.reply('⚠️ Due to WhatsApp limitations, use the native group clear chat feature for bulk deletes.');
  },

  // .blacklist add/remove/list
  async blacklist(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const action = args[0]?.toLowerCase();
    const word = args[1]?.toLowerCase();
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const group = await getOrCreateGroup(chat.id._serialized);

    if (action === 'add' && word) {
      if (group.blacklist.includes(word)) return msg.reply('❌ Word already blacklisted.');
      group.blacklist.push(word);
      await group.save();
      msg.reply(`✅ *${word}* added to blacklist.`);
    } else if (action === 'remove' && word) {
      group.blacklist = group.blacklist.filter(w => w !== word);
      await group.save();
      msg.reply(`✅ *${word}* removed from blacklist.`);
    } else if (action === 'list') {
      if (!group.blacklist.length) return msg.reply('📋 Blacklist is empty.');
      msg.reply(`📋 *Blacklist*\n\n${group.blacklist.map((w, i) => `${i + 1}. ${w}`).join('\n')}`);
    } else {
      msg.reply('❌ Usage: .blacklist [add/remove/list] [word]');
    }
  },

  // .promote @user
  async promote(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to promote.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    try {
      await chat.promoteParticipants([mentioned[0].id._serialized]);
       msg.reply(`⬆️ @${mentionName(mentioned[0])} is now an admin!`);
    } catch {
      msg.reply('❌ Could not promote.');
    }
  },

  // .demote @user
  async demote(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to demote.');

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    try {
      await chat.demoteParticipants([mentioned[0].id._serialized]);
      msg.reply(`⬇️ @${mentionName(mentioned[0])} is no longer an admin.`);
    } catch {
      msg.reply('❌ Could not demote.');
    }
  },

  // .mute
  async mute(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    await chat.setMessagesAdminsOnly(true);
    const group = await getOrCreateGroup(chat.id._serialized);
    group.isMuted = true;
    await group.save();
    msg.reply('🔇 Group muted. Only admins can send messages.');
  },

  // .unmute
  async unmute(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    await chat.setMessagesAdminsOnly(false);
    const group = await getOrCreateGroup(chat.id._serialized);
    group.isMuted = false;
    await group.save();
    msg.reply('🔊 Group unmuted. Everyone can send messages.');
  },

  // .hidetag [message] — mention all without notification
  async hidetag(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const text = args.join(' ') || '📢';
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const botId = client.info.wid._serialized;
    const mentions = chat.participants.map(p => p.id._serialized).filter(id => id !== botId);
    const hiddenMentions = mentions.map(() => '‎').join('');
    await chat.sendMessage(text + hiddenMentions, { mentions });
  },

  // .tagall [message]
async tagall(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const text = args.join(' ') || '📢 Attention everyone!';
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    const botId = client.info.wid._serialized;

    const mentions = [];
    let tagText = `${text}\n\n`;
    for (const p of chat.participants) {
      if (p.id._serialized === botId) continue;
      tagText += `@${p.id.user} `;
      mentions.push(p.id._serialized);
    }

    await chat.sendMessage(tagText, { mentions });
  },

  // .activity — show member activity
  async activity(client, msg, args) {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await withRetry(() => Group.findOne({ id: chat.id._serialized }))
      .catch(err => { console.error('activity: Group lookup failed:', err.message); return null; });
    if (!group?.activityLog?.size) return msg.reply('📊 No activity data yet.');

    const botId = client.info.wid._serialized;
    // activityLog keys are stored "~"-encoded (see encodeIdKey in
    // utils/helpers.js — Mongoose's Map type rejects "." in keys outright,
    // and every WhatsApp id contains one). Decode back to real ids before
    // comparing to botId or resolving names.
    const sorted = [...(group.activityLog || new Map())]
      .map(([key, count]) => [decodeIdKey(key), count])
      .filter(([id]) => id !== botId)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (!sorted.length) return msg.reply('📊 No activity data yet.');
    // Previously showed the raw WhatsApp id (e.g. "2341234567890@c.us") here
    // instead of the person's actual name.
    const names = await Promise.all(sorted.map(([id]) => resolveNameById(client, id)));

    let text = '📊 *Member Activity*\n\n';
    sorted.forEach(([, count], i) => {
      text += `${i + 1}. ${names[i]} — ${count} messages\n`;
    });
    msg.reply(text);
  },

  // .active — most active members
  async active(client, msg, args) {
    return module.exports.activity(client, msg, args);
  },

  // .inactive — least active
  async inactive(client, msg, args) {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await withRetry(() => Group.findOne({ id: chat.id._serialized }))
      .catch(err => { console.error('inactive: Group lookup failed:', err.message); return null; });
    const botId = client.info.wid._serialized;
    const allIds = chat.participants.map(p => p.id._serialized).filter(id => id !== botId);
    // activityLog keys are stored "~"-encoded (see encodeIdKey in
    // utils/helpers.js — Mongoose's Map type rejects "." in keys outright).
    // Decode into a real id -> count map before doing any id comparisons.
    const rawLog = group?.activityLog || new Map();
    const log = new Map([...rawLog].map(([key, count]) => [decodeIdKey(key), count]));

    const inactive = allIds.filter(id => !log.has(id) || log.get(id) < 5).slice(0, 10);
    // Same fix as .activity — resolve to real names instead of showing raw ids.
    const names = await Promise.all(inactive.map(id => resolveNameById(client, id)));

    let text = `😴 *Inactive Members* (< 5 messages)\n\n`;
    inactive.forEach((id, i) => { text += `${i + 1}. ${names[i]} — ${log.get(id) || 0} messages\n`; });
    msg.reply(text);
  },

  // .open
  async open(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    await chat.setMessagesAdminsOnly(false);
    msg.reply('🟢 Group is now *open*. Everyone can send messages.');
  },

  // .close
  async close(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    await chat.setMessagesAdminsOnly(true);
    msg.reply('🔴 Group is now *closed*. Only admins can send messages.');
  },
};

// ─── Blacklist listener (passive, called from index.js or separate listener) ──
module.exports.handleBlacklist = async (msg) => {
  try {
    const chat = await safeGetChat(msg).catch(err => { console.error("getChat failed:", err.message); msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment."); return null; });
    if (!chat) return;
    if (!chat.isGroup) return;

    const group = await Group.findOne({ id: chat.id._serialized });
    if (!group?.blacklist?.length) return;

    const body = msg.body.toLowerCase();
    const triggered = group.blacklist.some(word => body.includes(word));
    if (!triggered) return;

    await msg.delete(true);
    const contact = await msg.getContact();
    chat.sendMessage(`🚫 @${mentionName(contact)} used a blacklisted word.`, { mentions: [contact] });
  } catch {}
};
