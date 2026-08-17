const Group = require('../models/Group');
const User = require('../models/User');
const { OwnedCard } = require('../models/Card');
const BotState = require('../models/BotState');
const { isAdmin, botIsAdmin, mentionName, mentionTag, isOwner, safeGetChat, safeGetQuotedMessage, resolveNameById, withRetry, decodeIdKey, formatNum } = require('../utils/helpers');

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
  const tags = recipients.map(c => `@${mentionTag(c)}`).join(' ');
  welcomeMsg = welcomeMsg.replace('@user', tags);

  await chat.sendMessage(welcomeMsg, { mentions: recipients.map(c => c.id._serialized) });
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
  const tags = recipients.map(c => `@${mentionTag(c)}`).join(' ');
  leaveMsg = leaveMsg.replace('@user', tags);

  await chat.sendMessage(leaveMsg, { mentions: recipients.map(c => c.id._serialized) });
}

// ─── Inactive User Cleanup ──────────────────────────────────────────────────
const INACTIVITY_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

// Internal — called once a minute by index.js's scheduler, same shape as
// _maybeSendDailyStats in commands/general.js (gated to one specific
// UTC minute per day, with BotState remembering the last date it actually
// ran so a PM2 restart landing in that minute can't double-run it).
//
// Deletes the PROFILE (economy/xp/level/pet/loan record — the User
// document) of anyone who hasn't triggered User.findOrCreate in 60+ days.
// Deliberately does NOT touch their OwnedCard documents — this runs
// completely unattended with no human review, so it only does exactly what
// was asked ("his profile should be deleted") rather than also cascading
// into permanently destroying what could be rare/valuable cards. Those
// cards just become ownerless; a fresh profile is created automatically
// the moment this person messages the bot again, in a group or DM, same as
// any brand new user (see User.findOrCreate) — .deluser below works the
// same way, for the same reason.
//
// Anyone whose lastActiveAt is still null (pre-dates this feature, hasn't
// run a single command since it was deployed) is deliberately excluded —
// otherwise the very first sweep after deploy would treat "we've simply
// never recorded this" as "maximally inactive" and wipe every existing
// user in one shot. They get a real 60-day grace window starting from
// their next command instead.
async function _sweepInactiveUsers(client) {
  const now = new Date();
  if (now.getUTCHours() !== 3 || now.getUTCMinutes() !== 0) return; // 4AM WAT — off-peak

  const todayKey = now.toISOString().slice(0, 10);
  const state = await BotState.findOne({ key: 'inactiveUserSweepLastRun' }).catch(() => null);
  if (state?.value === todayKey) return;

  try {
    const cutoff = Date.now() - INACTIVITY_THRESHOLD_MS;
    // The owner is never a cleanup candidate — same reasoning as .users
    // excluding them from its listing above, but more important to get
    // right here: this runs completely unattended, so without this check
    // the owner's OWN profile would get silently deleted the first time
    // they went 60 days without messaging the bot themselves.
    const stale = (await User.find({ lastActiveAt: { $ne: null, $lt: cutoff } }).lean())
      .filter(u => !isOwner(u.id));

    if (stale.length) {
      await User.deleteMany({ id: { $in: stale.map(u => u.id) } });
      console.log(`🧹 Auto-deleted ${stale.length} inactive user profile(s) (60+ days idle): ${stale.map(u => u.name || u.id).join(', ')}`);

      const ownerId = process.env.OWNER_NUMBER;
      if (ownerId) {
        const list = stale.slice(0, 20).map(u => `• ${u.name || u.id.split('@')[0]}`).join('\n');
        await client.sendMessage(
          ownerId,
          `🧹 *Auto-Cleanup*\n\nDeleted ${stale.length} profile(s) inactive 60+ days:\n${list}${stale.length > 20 ? `\n...and ${stale.length - 20} more` : ''}\n\nTheir cards weren't touched — just sitting there for them to reclaim if they come back.`
        ).catch(() => {});
      }
    }

    await BotState.findOneAndUpdate(
      { key: 'inactiveUserSweepLastRun' },
      { value: todayKey },
      { upsert: true }
    );
  } catch (err) {
    console.error('❌ Inactive user sweep failed:', err.message);
  }
}

module.exports = {
  commands: { onJoin, onLeave },
  _seedParticipants,
  _sweepInactiveUsers,

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
        // Note: WhatsApp resolves a mention against who's currently in the
        // group. This fires right after removal, so — same honest caveat
        // as everywhere else in this file — it's not fully certain this
        // renders as a tappable tag versus falling back to plain digits
        // for someone who's just been removed; best-effort either way.
        msg.reply(`👢 @${mentionTag(user)} has been kicked.`, undefined, { mentions: [user.id._serialized] });
      } catch {
        msg.reply(`❌ Could not kick @${mentionTag(user)}.`, undefined, { mentions: [user.id._serialized] });
      }
    }
  },

  // .delete — delete a replied message. Deleting the bot's OWN message
  // never needs bot-admin status (any account can always delete its own
  // sent message) — but deleting someone ELSE's message for everyone only
  // works if WhatsApp recognizes the bot as a group admin. Without this
  // check, quoted.delete(true) on someone else's message used to silently
  // fall back to a LOCAL-ONLY delete (removed from the bot's own view,
  // still visible to everyone else) instead of throwing an error — so it
  // looked like it worked, but nothing actually happened for the group.
  // Same requireBotAdmin pattern already used by .kick above.
  async delete(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const quoted = await safeGetQuotedMessage(msg).catch(err => { console.error("getQuotedMessage failed:", err.message); return 'ERROR'; });
    if (quoted === 'ERROR') return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!quoted) return msg.reply('❌ Reply to a message to delete it.');

    if (!quoted.fromMe && !await requireBotAdmin(msg)) return;

    // Deleted separately (not one shared try/catch) so a failure on either
    // side is diagnosable instead of both looking identical in the logs.
    // The delay between them is a mitigation for a suspected timing issue:
    // firing two back-to-back "delete for everyone" actions in the same
    // WhatsApp Web session — the second one targeting the very message
    // still being actively processed by this handler — appears able to
    // silently no-op (no thrown error, but nothing actually deletes for
    // the group) rather than fail loudly. Unconfirmed without a live
    // session; if this message still doesn't delete, the two console.error
    // lines below will show exactly which call is the problem.
    let quotedOk = false;
    try {
      await quoted.delete(true);
      quotedOk = true;
    } catch (err) {
      console.error('.delete: quoted.delete(true) failed:', err.message);
    }

    await new Promise(r => setTimeout(r, 400));

    let msgOk = false;
    try {
      await msg.delete(true);
      msgOk = true;
    } catch (err) {
      console.error('.delete: msg.delete(true) failed:', err.message);
    }

    if (!quotedOk || !msgOk) {
      msg.reply(
        !quotedOk
          ? '❌ Could not delete that message.'
          : '⚠️ Deleted the message, but could not delete this command.'
      );
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
       `⚠️ *Warning* for @${mentionTag(target)}\n\nReason: ${reason}\nTotal warns: ${user.warns}/3\n${user.warns >= 3 ? '🔴 Auto-kick threshold reached!' : ''}`,
      { mentions: [target.id._serialized] }
    );

    if (user.warns >= 3 && await botIsAdmin(msg)) {
      await chat.removeParticipants([target.id._serialized]);
      chat.sendMessage(`👢 @${mentionTag(target)} was auto-kicked after 3 warnings.`, { mentions: [target.id._serialized] });
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
     msg.reply(`✅ Warnings reset for @${mentionTag(mentioned[0])}.`, undefined, { mentions: [mentioned[0].id._serialized] });
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
       msg.reply(`⬆️ @${mentionTag(mentioned[0])} is now an admin!`, undefined, { mentions: [mentioned[0].id._serialized] });
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
      msg.reply(`⬇️ @${mentionTag(mentioned[0])} is no longer an admin.`, undefined, { mentions: [mentioned[0].id._serialized] });
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

  // .users [page] — owner-only, DM-only. Lists every registered user,
  // grouped by which of the bot's CURRENT WhatsApp groups they're a member
  // of (live-checked via client.getChats(), not stored — always reflects
  // real membership even if someone left a group since they last used the
  // bot). Sorted stalest-first within each group, since this exists mainly
  // as a pre-flight list for deciding who to .deluser.
  async users(client, msg, args) {
    const senderId = msg.author || msg.from;
    if (!isOwner(senderId)) return msg.reply('❌ This command is for the bot owner only.');

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (chat.isGroup) return msg.reply('❌ .users only works in a DM with the bot — not in a group.');

    const allUsers = (await User.find({}).lean()).filter(u => !isOwner(u.id));
    if (!allUsers.length) return msg.reply('📭 No registered users yet.');

    const now = Date.now();
    const fmtUser = (u) => {
      const days = u.lastActiveAt ? Math.floor((now - u.lastActiveAt) / 86_400_000) : null;
      const activity = days === null ? 'never active' : days === 0 ? 'active today' : `inactive ${days}d`;
      const flag = (days !== null && days >= 60) ? ' ⚠️' : '';
      return `• ${u.name || u.id.split('@')[0]} (${u.id.split('@')[0]}) — Lv.${u.level} — ${activity}${flag}`;
    };

    let groupChats = [];
    try {
      groupChats = (await client.getChats()).filter(c => c.isGroup);
    } catch (err) {
      console.error('.users: getChats failed:', err.message);
    }

    const seenIds = new Set();
    let text = `👥 *Registered Users* (${allUsers.length} total)\n`;

    for (const g of groupChats) {
      const memberIds = new Set(g.participants.map(p => p.id._serialized));
      const groupUsers = allUsers.filter(u => memberIds.has(u.id));
      if (!groupUsers.length) continue;
      groupUsers.forEach(u => seenIds.add(u.id));
      groupUsers.sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
      text += `\n📍 *${g.name}* (${groupUsers.length})\n` + groupUsers.slice(0, 25).map(fmtUser).join('\n');
      if (groupUsers.length > 25) text += `\n...and ${groupUsers.length - 25} more`;
    }

    const unseen = allUsers.filter(u => !seenIds.has(u.id));
    if (unseen.length) {
      unseen.sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
      text += `\n\n📍 *Not in any group with the bot right now* (${unseen.length})\n` + unseen.slice(0, 25).map(fmtUser).join('\n');
      if (unseen.length > 25) text += `\n...and ${unseen.length - 25} more`;
    }

    text += `\n\n⚠️ = inactive 60+ days (auto-cleanup candidate — see .deluser)`;

    msg.reply(text);
  },

  // .deluser [phone number] [confirm] — owner-only, DM-only. Permanently
  // deletes a registered user's PROFILE (economy/xp/level/pet/loan
  // record). Their OwnedCard documents are deliberately left untouched —
  // same reasoning as the automatic 60-day sweep above
  // (_sweepInactiveUsers): this only deletes what was asked for, not their
  // card collection too. A fresh profile is created automatically if/when
  // they message the bot again.
  //
  // BUGFIX (Aug 2026): this used to require @mentioning the target, which
  // can never actually work here — WhatsApp mentions only resolve to
  // participants of the CURRENT chat, and this command can only be run in
  // a private 1:1 DM with the bot (nobody else is ever "in" that chat to
  // mention). Takes a plain phone number instead — exactly the number
  // .users already prints next to each name — and matches it against the
  // stored id by prefix rather than requiring an exact full id, since a
  // user's stored id isn't always "<number>@c.us": WhatsApp sometimes
  // hands back an opaque "@lid" id instead of the real number for privacy
  // reasons (see the @lid notes in utils/helpers.js) — either way, the
  // digits typed here are exactly the prefix .users already showed.
  async deluser(client, msg, args) {
    const senderId = msg.author || msg.from;
    if (!isOwner(senderId)) return msg.reply('❌ This command is for the bot owner only.');

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (chat.isGroup) return msg.reply('❌ .deluser only works in a DM with the bot — not in a group.');

    const raw = (args[0] || '').replace(/\D/g, ''); // digits only — strips +, spaces, punctuation
    if (!raw) {
      return msg.reply('❌ Usage: .deluser [phone number] [confirm]\n\nUse the number shown in *.users* — e.g. .deluser 2347079911744');
    }

    const targetUser = await User.findOne({ id: { $regex: '^' + raw + '@' } });
    if (!targetUser) return msg.reply(`❌ No registered user found with number *${raw}*. Check *.users* for the exact number.`);

    const targetId = targetUser.id;
    const confirm = args.some(a => a.toLowerCase() === 'confirm');
    if (!confirm) {
      const cardCount = await OwnedCard.countDocuments({ ownerId: targetId });
      return msg.reply(
        `⚠️ This will permanently delete *${targetUser.name || raw}*'s profile:\n` +
        `Level ${targetUser.level} — 💰 ${formatNum(targetUser.coins)} wallet — 🏦 ${formatNum(targetUser.bank)} bank\n\n` +
        `They own ${cardCount} card(s) — these are NOT deleted, just left ownerless until they message the bot again (a fresh profile is created automatically then, but today's stats are gone for good).\n\n` +
        `Run *.deluser ${raw} confirm* to actually delete.`
      );
    }

    await User.deleteOne({ id: targetId });
    msg.reply(`🗑 Deleted *${targetUser.name || raw}*'s profile. A fresh one is created automatically if they message the bot again.`);
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
    chat.sendMessage(`🚫 @${mentionTag(contact)} used a blacklisted word.`, { mentions: [contact.id._serialized] });
  } catch {}
};
