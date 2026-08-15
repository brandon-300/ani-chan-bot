const Group = require('../models/Group');
const User = require('../models/User');
const CommandUsage = require('../models/CommandUsage');
const BotState = require('../models/BotState');
const fs = require('fs');
const path = require('path');
const { safeGetChat, isAdmin, isOwner, resolveNameById, formatCooldown, getModIds, boldSans, doubleStruck } = require('../utils/helpers');

const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';
const PREFIX = process.env.BOT_PREFIX || '.';

async function getOrCreateGroup(chatId) {
  return Group.findOneAndUpdate({ id: chatId }, {}, { upsert: true, new: true });
}

// Small inline admin gate, matching requireAdmin's behavior in admin.js
// (kept local here rather than importing it, since it isn't exported from
// there — this avoids a cross-file dependency for a handful of lines).
async function requireAdminHere(msg) {
  const contact = await msg.getContact().catch(() => null);
  if (contact && isOwner(contact.id._serialized)) return true;
  const ok = await isAdmin(msg);
  if (!ok) { msg.reply('❌ Admins only!'); return false; }
  return true;
}

// Counts every currently-registered command the same way index.js's own
// loader does — re-scanning commands/ rather than hardcoding a number that
// would silently go stale as commands get added or removed.
function countRegisteredCommands() {
  const commandDir = __dirname;
  let count = 0;
  for (const file of fs.readdirSync(commandDir)) {
    if (!file.endsWith('.js')) continue;
    try {
      const mod = require(path.join(commandDir, file));
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn === 'function' && !name.startsWith('_')) count++;
      }
    } catch {
      // A command file that fails to load (e.g. a missing API key at
      // require-time) shouldn't crash .stats — just skip it.
    }
  }
  return count;
}

// Same visual language as .profile (commands/economy.js) and .feedback
// (commands/feedback.js) — box-drawing header + bold-sans labels — instead
// of a plain quoted-text dump.
function statLine(label, value) {
  return `ꕥ ${boldSans(label)}: ${value}`;
}

// WhatsApp has no real "profile link" URL — the closest equivalent is a
// wa.me/<number> link, which WhatsApp auto-turns into a tappable link that
// opens a chat with that person. Building it needs a live contact lookup
// (the phone number isn't stored anywhere in our own DB), and that lookup
// can fail for some ids (see resolveSenderName's @lid comment in
// utils/helpers.js) — falls back to a plain name with no link rather than
// breaking the whole report.
async function resolveUserLink(client, userId) {
  const userDoc = await User.findOne({ id: userId }).lean().catch(() => null);
  let name = userDoc?.name || userId.split('@')[0];
  try {
    const contact = await client.getContactById(userId);
    name = contact.name || contact.pushname || name;
    if (contact.number) return `${name} (https://wa.me/${contact.number})`;
  } catch (err) {
    console.error(`resolveUserLink: contact lookup failed for ${userId}:`, err.message);
  }
  return name;
}

// Group documents don't cache a display name (only the WhatsApp id), so
// this needs a live lookup too — falls back to the raw id if the bot was
// removed from the group since (Group doc still exists but the chat doesn't).
async function resolveGroupName(client, groupId) {
  try {
    const chat = await client.getChatById(groupId);
    return chat?.name || groupId;
  } catch (err) {
    console.error(`resolveGroupName: lookup failed for ${groupId}:`, err.message);
    return groupId;
  }
}

// Shared by both the manual .stats command and the scheduled daily digest
// (see _maybeSendDailyStats below) so the two can never drift apart.
async function buildStatsReport(client, { isDigest = false } = {}) {
  const groups = await Group.find({}).lean();

  // Two aggregations across the whole CommandUsage collection instead of
  // separate per-group queries — cheaper as the number of groups grows,
  // and simpler than juggling N parallel query sets.
  const [byUser, byCommand] = await Promise.all([
    CommandUsage.aggregate([
      { $group: {
          _id: { groupId: '$groupId', userId: '$userId' },
          usageCount: { $sum: '$count' },
          apiCalls: { $sum: '$apiCallCount' },
      } },
    ]),
    CommandUsage.aggregate([
      { $group: {
          _id: { groupId: '$groupId', command: '$command' },
          usageCount: { $sum: '$count' },
      } },
    ]),
  ]);

  // Bucket both aggregations by groupId for fast per-group lookups below.
  const usersByGroup = new Map();
  for (const row of byUser) {
    const list = usersByGroup.get(row._id.groupId) || [];
    list.push({ userId: row._id.userId, usageCount: row.usageCount, apiCalls: row.apiCalls });
    usersByGroup.set(row._id.groupId, list);
  }

  const commandsByGroup = new Map();
  for (const row of byCommand) {
    const list = commandsByGroup.get(row._id.groupId) || [];
    list.push({ command: row._id.command, usageCount: row.usageCount });
    commandsByGroup.set(row._id.groupId, list);
  }

  // Top group overall, by total command usage. Only compares against real
  // Group documents — CommandUsage also has a 'DM' bucket for commands run
  // outside any group (see the schema comment), which must never win here.
  let topGroupId = null;
  let topGroupUsage = -1;
  for (const group of groups) {
    const total = (usersByGroup.get(group.id) || []).reduce((sum, u) => sum + u.usageCount, 0);
    if (total > topGroupUsage) {
      topGroupUsage = total;
      topGroupId = group.id;
    }
  }

  // Original health-metric fields .stats always had — kept alongside the
  // new usage breakdown below rather than replaced by it, since "the
  // entire bot's statistics" (as asked for) reads as additive, not a swap.
  const userCount = await User.countDocuments().catch(() => null);
  const uptime = formatCooldown(process.uptime() * 1000);
  const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

  const lines = [
    `╭━━━★彡 ${doubleStruck('BOT STATS')} 彡★━━━╮`,
    '',
    statLine('Uptime', uptime),
    statLine('Commands', countRegisteredCommands()),
    statLine('Registered users', userCount ?? 'N/A'),
    statLine('Memory', `${memMb} MB`),
    statLine('Node', process.version),
    '',
    statLine('Groups', groups.length),
  ];

  if (topGroupId) {
    const topGroupName = await resolveGroupName(client, topGroupId);
    lines.push(statLine('Top group (overall)', `${topGroupName} (${topGroupUsage} uses)`));
  } else {
    lines.push(statLine('Top group (overall)', 'No usage recorded yet'));
  }

  lines.push('', `───  ${boldSans('Per-Group Breakdown')}  ───`);

  for (const group of groups) {
    const groupName = await resolveGroupName(client, group.id);
    const users = (usersByGroup.get(group.id) || []).slice().sort((a, b) => b.usageCount - a.usageCount);
    const commandsList = (commandsByGroup.get(group.id) || []).slice().sort((a, b) => b.usageCount - a.usageCount);
    const byApiCalls = users.slice().sort((a, b) => b.apiCalls - a.apiCalls);
    const totalApiCalls = users.reduce((sum, u) => sum + u.apiCalls, 0);

    lines.push('', `📌 ${groupName}`);

    if (!users.length) {
      lines.push('ꕥ No usage recorded yet');
      continue;
    }

    lines.push(statLine('Top user', await resolveUserLink(client, users[0].userId)));
    lines.push(statLine('Top command', commandsList.length
      ? `${PREFIX}${commandsList[0].command} (${commandsList[0].usageCount} uses)`
      : 'N/A'));
    lines.push(statLine('API calls', totalApiCalls));
    lines.push(statLine('Top API user', byApiCalls.length && byApiCalls[0].apiCalls > 0
      ? await resolveUserLink(client, byApiCalls[0].userId)
      : 'N/A'));
  }

  const report = lines.join('\n');
  return isDigest ? `📅 *Daily Stats Digest*\n\n${report}` : report;
}

module.exports = {
  // .rules — view this group's rules
  async rules(client, msg, args) {
    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const group = await getOrCreateGroup(chat.id._serialized);
    if (!group.rules) {
      return msg.reply(`📜 No rules have been set for this group yet.\nAn admin can set them with *${PREFIX}setrules [text]*.`);
    }
    msg.reply(`📜 *Group Rules*\n\n${group.rules}`);
  },

  // .setrules [text] — admin only
  async setrules(client, msg, args) {
    if (!await requireAdminHere(msg)) return;
    const text = args.join(' ');
    if (!text) return msg.reply(`❌ Usage: ${PREFIX}setrules [text]`);

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    const group = await getOrCreateGroup(chat.id._serialized);
    group.rules = text;
    await group.save();
    msg.reply(`✅ Rules updated:\n\n${text}`);
  },

  // .ping — ping/latency check (was .test — kept as an alias below, both
  // call this exact same function so nothing that already used .test breaks)
  async ping(client, msg, args) {
    // msg.timestamp is WhatsApp's own send-time, in seconds
    const latencyMs = Date.now() - msg.timestamp * 1000;
    msg.reply(`🏓 Pong! ${BOT_NAME} is online.\nLatency: ${latencyMs}ms`);
  },

  // .test — old name for .ping, kept working as an alias to the same function.
  get test() {
    return module.exports.ping;
  },

  // .stats — bot usage stats (owner only, DM only — see .groupstats for
  // per-group settings/member info instead). Also auto-sent daily at
  // 8:00 AM WAT regardless of whether this was ever typed — see
  // _maybeSendDailyStats below, called from index.js's scheduler.
  async stats(client, msg, args) {
    const senderId = msg.author || msg.from;
    if (!isOwner(senderId)) {
      return msg.reply('❌ This command is for the bot owner only.');
    }

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (chat.isGroup) {
      return msg.reply('❌ .stats only works in a DM with the bot — not in a group.');
    }

    try {
      const report = await buildStatsReport(client);
      msg.reply(report);
    } catch (err) {
      console.error('.stats failed:', err.message);
      msg.reply('❌ Could not build stats right now — check `pm2 logs` for details.');
    }
  },

  // Internal — called every minute by index.js's scheduler, not a real
  // dot-command (leading underscore excludes it from both
  // countRegisteredCommands() above and the command dispatcher itself —
  // same convention as _initCardDrops/_seedParticipants/etc. in the other
  // command files). Sends the same report .stats builds, unprompted, once
  // a day right after 8:00 AM WAT (= 07:00 UTC — Nigeria has used WAT
  // year-round with no DST since 1919, so this fixed offset never needs
  // adjusting). BotState remembers the last date this actually sent, so a
  // PM2 restart landing in that exact minute can't cause a duplicate send.
  async _maybeSendDailyStats(client) {
    const now = new Date();
    if (now.getUTCHours() !== 7 || now.getUTCMinutes() !== 0) return;

    const todayKey = now.toISOString().slice(0, 10);
    const state = await BotState.findOne({ key: 'dailyStatsLastSent' }).catch(() => null);
    if (state?.value === todayKey) return;

    const ownerId = process.env.OWNER_NUMBER;
    if (!ownerId) return;

    try {
      const report = await buildStatsReport(client, { isDigest: true });
      await client.sendMessage(ownerId, report);
      await BotState.findOneAndUpdate(
        { key: 'dailyStatsLastSent' },
        { value: todayKey },
        { upsert: true }
      );
      console.log(`✅ Daily stats digest sent to owner at ${now.toLocaleString()}`);
    } catch (err) {
      console.error('❌ Failed to send daily stats digest:', err.message);
    }
  },

  // .owner — reach the bot owner
  async owner(client, msg, args) {
    const ownerId = process.env.OWNER_NUMBER;
    if (!ownerId) return msg.reply('❌ No owner configured.');

    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');

    try {
      const ownerContact = await client.getContactById(ownerId);
      await msg.reply(`👑 *${BOT_NAME}'s* owner:`);
      await chat.sendMessage(ownerContact);
    } catch (err) {
      console.error('owner command failed:', err.message);
      msg.reply(`❌ Couldn't fetch the owner's contact card right now.`);
    }
  },

  // .mods — bot-level moderators (distinct from WhatsApp group admins)
  async mods(client, msg, args) {
    const ownerId = process.env.OWNER_NUMBER;
    const modIds = getModIds();

    const lines = [];
    if (ownerId) lines.push(`👑 ${await resolveNameById(client, ownerId)} (Owner)`);
    for (const id of modIds) {
      if (id === ownerId) continue; // don't list the owner twice
      lines.push(`🛡️ ${await resolveNameById(client, id)}`);
    }

    if (!lines.length) return msg.reply('❌ No moderators configured.');
    msg.reply(`🛡️ *${BOT_NAME} Moderators*\n\n${lines.join('\n')}`);
  },

  // .url — this group's invite link (admin only — anyone holding it can invite people)
  async url(client, msg, args) {
    if (!await requireAdminHere(msg)) return;
    const chat = await safeGetChat(msg).catch(() => null);
    if (!chat) return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    try {
      const code = await chat.getInviteCode();
      msg.reply(`🔗 Invite link:\nhttps://chat.whatsapp.com/${code}`);
    } catch (err) {
      console.error('url command failed:', err.message);
      msg.reply(`❌ Couldn't fetch the invite link — make sure ${BOT_NAME} is a group admin.`);
    }
  },

  // .otp — random 6-digit one-time code (utility/fun; not tied to any account system)
  async otp(client, msg, args) {
    const code = Math.floor(100000 + Math.random() * 900000);
    msg.reply(`🔐 Your OTP: *${code}*\n(Valid for this message only — generate a new one anytime with ${PREFIX}otp.)`);
  },
};
