const Guild = require('../models/Guild');
const User = require('../models/User');
const { formatNum, mentionName, mentionTag, resolveNameById } = require('../utils/helpers');

// ─── Shared: leave/kick cleanup ────────────────────────────────────────────────
// Removes a user from whatever guild they're in and keeps the guild's own
// records (members[] / leaderId) consistent. Used by:
//   - .guild remove [name]      (leader kicking someone)
//   - group_leave event handler (someone leaving a WhatsApp group the bot is in)
//
// If the departing user is the leader, leadership is handed to the next
// member in the list rather than disbanding the guild outright — disbanding
// wipes the guild's bank/xp/level, which felt too destructive for something
// that can be triggered passively (e.g. a leader leaving a WhatsApp group).
// If that's not the behavior you want (e.g. you'd rather auto-disband when
// the leader leaves), let me know and I'll switch it.
//
// Prefixed with `_` so index.js's command loader (`!name.startsWith('_')`)
// does not register it as a chat command — same convention as
// `_initCardDrops` in cards.js.
async function _removeMemberFromGuild(userId) {
  const user = await User.findOne({ id: userId });
  if (!user || !user.guildId) return null;

  const guild = await Guild.findById(user.guildId);
  user.guildId = null;
  await user.save();

  if (!guild) return null;

  const remaining = guild.members.filter(id => id !== userId);

  if (guild.leaderId === userId) {
    if (remaining.length === 0) {
      await Guild.findByIdAndDelete(guild._id);
      return { disbanded: true, guildName: guild.name };
    }
    guild.leaderId = remaining[0];
    guild.members = remaining;
    await guild.save();
    return { disbanded: false, guildName: guild.name, newLeaderId: remaining[0] };
  }

  guild.members = remaining;
  await guild.save();
  return { disbanded: false, guildName: guild.name };
}

module.exports = {
  _removeMemberFromGuild,

  // .guild info
  async guild_info(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (!user.guildId) return msg.reply('❌ You are not in a guild. Use .guild create [name] to start one!');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    const leaderName = await resolveNameById(client, guild.leaderId);

    msg.reply(
      `🏰 *${guild.emblem} ${guild.name}*\n\n👑 Leader: ${leaderName}\n👥 Members: ${guild.members.length}\n⚡ Level: ${guild.level}\n⭐ XP: ${guild.xp}\n💰 Bank: ${formatNum(guild.bank)}\n\n📅 Created: ${guild.createdAt.toDateString()}`
    );
  },

  // .guild members — leader only
  async guild_members(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can view the member list.');
    }

    const names = await Promise.all(
      guild.members.map(id => resolveNameById(client, id))
    );

    const lines = names.map((name, i) => {
      const isLeader = guild.members[i] === guild.leaderId;
      return `${isLeader ? '👑' : '👤'} ${name}${isLeader ? ' (Leader)' : ''}`;
    });

    msg.reply(
      `🏰 *${guild.emblem} ${guild.name}* — Members (${guild.members.length})\n\n${lines.join('\n')}`
    );
  },

  // .guild remove [member's name] — leader only
  async guild_remove(client, msg, args) {
    const contact = await msg.getContact();
    const query = args.join(' ').trim();
    if (!query) return msg.reply('❌ Usage: .guild remove [member\'s name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (!guild) return msg.reply('❌ Guild not found.');

    if (guild.leaderId !== contact.id._serialized) {
      return msg.reply('❌ Only the guild leader can remove members.');
    }

    if (guild.members.length <= 1) {
      return msg.reply('❌ There are no other members to remove.');
    }

    // Resolve every member's display name so we can match against the typed name.
    const memberNames = await Promise.all(
      guild.members.map(id => resolveNameById(client, id))
    );

    const q = query.toLowerCase();
    const matches = guild.members
      .map((id, i) => ({ id, name: memberNames[i] }))
      .filter(m => m.id !== guild.leaderId && m.name.toLowerCase() === q);

    let target = matches[0];

    // Fall back to a partial match only if it's unambiguous.
    if (!target) {
      const partial = guild.members
        .map((id, i) => ({ id, name: memberNames[i] }))
        .filter(m => m.id !== guild.leaderId && m.name.toLowerCase().includes(q));
      if (partial.length === 1) target = partial[0];
      else if (partial.length > 1) {
        return msg.reply(`❌ That matches multiple members: ${partial.map(m => m.name).join(', ')}. Be more specific.`);
      }
    }

    if (!target) {
      return msg.reply(`❌ No member named "${query}" found in *${guild.name}*.`);
    }

    guild.members = guild.members.filter(id => id !== target.id);
    await guild.save();

    await User.findOneAndUpdate({ id: target.id }, { guildId: null });

    msg.reply(`✅ Removed *${target.name}* from *${guild.emblem} ${guild.name}*.`);
  },

  // .guild create [name]
  async guild_create(client, msg, args) {
    const contact = await msg.getContact();
    const name = args.join(' ');
    if (!name) return msg.reply('❌ Usage: .guild create [name]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (user.guildId) return msg.reply('❌ You are already in a guild. Leave first!');

    const exists = await Guild.findOne({ name });
    if (exists) return msg.reply('❌ A guild with that name already exists.');

    if (user.coins < 1000) return msg.reply('❌ Creating a guild costs 💰 1000 coins.');

    user.coins -= 1000;
    user.guildId = null;

    const guild = await Guild.create({
      name,
      leaderId: contact.id._serialized,
      members: [contact.id._serialized],
    });

    user.guildId = guild._id.toString();
    await user.save();

    msg.reply(`🏰 Guild *${name}* created! Invite members with .guild invite @user`);
  },

  // .guild invite @user
  async guild_invite(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Usage: .guild invite @user');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (guild.leaderId !== contact.id._serialized) return msg.reply('❌ Only the guild leader can invite.');

    const target = mentioned[0];
    if (guild.pendingInvites.includes(target.id._serialized)) return msg.reply('❌ Already invited!');

    guild.pendingInvites.push(target.id._serialized);
    await guild.save();
    msg.reply(
      `📨 Invited @${mentionTag(target)} to *${guild.name}*! They can type *.guild accept* to join.`,
      undefined,
      { mentions: [target.id._serialized] }
    );
  },

  // .guild accept
  async guild_accept(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);

    if (user.guildId) return msg.reply('❌ Leave your current guild first.');

    const guild = await Guild.findOne({ pendingInvites: contact.id._serialized });
    if (!guild) return msg.reply('❌ No pending guild invite found.');

    guild.pendingInvites = guild.pendingInvites.filter(id => id !== contact.id._serialized);
    guild.members.push(contact.id._serialized);
    user.guildId = guild._id.toString();

    await Promise.all([guild.save(), user.save()]);
    msg.reply(`🏰 You joined *${guild.emblem} ${guild.name}*!`);
  },

  // .guild decline
  async guild_decline(client, msg, args) {
    const contact = await msg.getContact();
    const guild = await Guild.findOne({ pendingInvites: contact.id._serialized });
    if (!guild) return msg.reply('❌ No pending invite.');

    guild.pendingInvites = guild.pendingInvites.filter(id => id !== contact.id._serialized);
    await guild.save();
    msg.reply('✅ Invite declined.');
  },

  // .guild emblem [emoji]
  async guild_emblem(client, msg, args) {
    const contact = await msg.getContact();
    const emblem = args[0];
    if (!emblem) return msg.reply('❌ Usage: .guild emblem [emoji]');

    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (guild.leaderId !== contact.id._serialized) return msg.reply('❌ Only the leader can change emblem.');

    guild.emblem = emblem;
    await guild.save();
    msg.reply(`✅ Guild emblem updated to ${emblem}!`);
  },

  // .guild leave
  async guild_leave(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (guild.leaderId === contact.id._serialized) return msg.reply('❌ Leaders cannot leave. Disband the guild instead.');

    guild.members = guild.members.filter(id => id !== contact.id._serialized);
    user.guildId = null;
    await Promise.all([guild.save(), user.save()]);
    msg.reply(`✅ You left *${guild.name}*.`);
  },

  // .guild disband
  async guild_disband(client, msg, args) {
    const contact = await msg.getContact();
    const user = await User.findOrCreate(contact.id._serialized);
    if (!user.guildId) return msg.reply('❌ You are not in a guild.');

    const guild = await Guild.findById(user.guildId);
    if (guild.leaderId !== contact.id._serialized) return msg.reply('❌ Only the leader can disband.');

    // Remove guild from all members
    await User.updateMany({ guildId: guild._id.toString() }, { guildId: null });
    await Guild.findByIdAndDelete(guild._id);
    msg.reply(`🏰 Guild *${guild.name}* has been disbanded.`);
  },
};
