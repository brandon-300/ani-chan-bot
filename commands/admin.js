const Group = require('../models/Group');
const User = require('../models/User');
const { isAdmin, botIsAdmin } = require('../utils/helpers');

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function requireAdmin(msg) {
  const ok = await isAdmin(msg);
  if (!ok) { msg.reply('❌ Admins only!'); return false; }
  return true;
}

async function requireBotAdmin(msg) {
  const ok = await botIsAdmin(msg);
  if (!ok) { msg.reply('❌ Make me an admin first!'); return false; }
  return true;
}

async function getOrCreateGroup(chatId) {
  return Group.findOneAndUpdate({ id: chatId }, {}, { upsert: true, new: true });
}

// ─── Welcome/Leave Event Handlers (called from index.js) ─────────────────────
async function onJoin(client, notification) {
  const chat = await notification.getChat();
  const group = await Group.findOne({ id: chat.id._serialized });
  if (!group?.welcome) return;

  const contact = await notification.getContact();
  const name = contact.pushname || contact.number;
  let welcomeMsg = group.welcomeMsg || '👋 Welcome to the group, @user!';
  welcomeMsg = welcomeMsg.replace('@user', `@${contact.number}`);

  await chat.sendMessage(welcomeMsg, { mentions: [contact] });
}

async function onLeave(client, notification) {
  const chat = await notification.getChat();
  const group = await Group.findOne({ id: chat.id._serialized });
  if (!group?.leave) return;

  const contact = await notification.getContact();
  let leaveMsg = group.leaveMsg || '👋 @user has left the group.';
  leaveMsg = leaveMsg.replace('@user', `@${contact.number}`);

  await chat.sendMessage(leaveMsg, { mentions: [contact] });
}

module.exports = {
  commands: { onJoin, onLeave },

  // .kick @user
  async kick(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to kick.');

    const chat = await msg.getChat();
    for (const user of mentioned) {
      try {
        await chat.removeParticipants([user.id._serialized]);
        msg.reply(`👢 @${user.number} has been kicked.`);
      } catch {
        msg.reply(`❌ Could not kick @${user.number}.`);
      }
    }
  },

  // .delete — delete a replied message
  async delete(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const quoted = await msg.getQuotedMessage().catch(() => null);
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
    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
    chat.sendMessage(
      `⚠️ *Warning* for @${target.number}\n\nReason: ${reason}\nTotal warns: ${user.warns}/3\n${user.warns >= 3 ? '🔴 Auto-kick threshold reached!' : ''}`,
      { mentions: [target] }
    );

    if (user.warns >= 3 && await botIsAdmin(msg)) {
      await chat.removeParticipants([target.id._serialized]);
      chat.sendMessage(`👢 @${target.number} was auto-kicked after 3 warnings.`, { mentions: [target] });
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
    msg.reply(`✅ Warnings reset for @${mentioned[0].number}.`);
  },

  // .groupstats
  async groupstats(client, msg, args) {
    const chat = await msg.getChat();
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await Group.findOne({ id: chat.id._serialized });
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

    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
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
    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
    try {
      await chat.promoteParticipants([mentioned[0].id._serialized]);
      msg.reply(`⬆️ @${mentioned[0].number} is now an admin!`);
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

    const chat = await msg.getChat();
    try {
      await chat.demoteParticipants([mentioned[0].id._serialized]);
      msg.reply(`⬇️ @${mentioned[0].number} is no longer an admin.`);
    } catch {
      msg.reply('❌ Could not demote.');
    }
  },

  // .mute
  async mute(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await msg.getChat();
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

    const chat = await msg.getChat();
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
    const chat = await msg.getChat();
    const mentions = chat.participants.map(p => p.id._serialized);
    const hiddenMentions = mentions.map(() => '‎').join('');
    await chat.sendMessage(text + hiddenMentions, { mentions });
  },

  // .tagall [message]
  async tagall(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    const text = args.join(' ') || '📢 Attention everyone!';
    const chat = await msg.getChat();

    const mentions = [];
    let tagText = `${text}\n\n`;
    for (const p of chat.participants) {
      tagText += `@${p.id.user} `;
      mentions.push(p.id._serialized);
    }

    await chat.sendMessage(tagText, { mentions });
  },

  // .activity — show member activity
  async activity(client, msg, args) {
    const chat = await msg.getChat();
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await Group.findOne({ id: chat.id._serialized });
    if (!group?.activityLog?.size) return msg.reply('📊 No activity data yet.');

    const sorted = [...(group.activityLog || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 10);
    let text = '📊 *Member Activity*\n\n';
    sorted.forEach(([id, count], i) => {
      text += `${i + 1}. ${id} — ${count} messages\n`;
    });
    msg.reply(text);
  },

  // .active — most active members
  async active(client, msg, args) {
    return module.exports.activity(client, msg, args);
  },

  // .inactive — least active
  async inactive(client, msg, args) {
    const chat = await msg.getChat();
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await Group.findOne({ id: chat.id._serialized });
    const allIds = chat.participants.map(p => p.id._serialized);
    const log = group?.activityLog || new Map();

    const inactive = allIds.filter(id => !log.has(id) || log.get(id) < 5);
    let text = `😴 *Inactive Members* (< 5 messages)\n\n`;
    inactive.slice(0, 10).forEach((id, i) => { text += `${i + 1}. @${id.replace('@c.us', '')}\n`; });
    msg.reply(text);
  },

  // .open
  async open(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await msg.getChat();
    await chat.setMessagesAdminsOnly(false);
    msg.reply('🟢 Group is now *open*. Everyone can send messages.');
  },

  // .close
  async close(client, msg, args) {
    if (!await requireAdmin(msg)) return;
    if (!await requireBotAdmin(msg)) return;

    const chat = await msg.getChat();
    await chat.setMessagesAdminsOnly(true);
    msg.reply('🔴 Group is now *closed*. Only admins can send messages.');
  },
};

// ─── Blacklist listener (passive, called from index.js or separate listener) ──
module.exports.handleBlacklist = async (msg) => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    const group = await Group.findOne({ id: chat.id._serialized });
    if (!group?.blacklist?.length) return;

    const body = msg.body.toLowerCase();
    const triggered = group.blacklist.some(word => body.includes(word));
    if (!triggered) return;

    await msg.delete(true);
    const contact = await msg.getContact();
    chat.sendMessage(`🚫 @${contact.number} used a blacklisted word.`, { mentions: [contact] });
  } catch {}
};
