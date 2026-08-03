const Group = require('../models/Group');
const User = require('../models/User');
const fs = require('fs');
const path = require('path');
const { safeGetChat, isAdmin, isOwner, resolveNameById, formatCooldown, getModIds } = require('../utils/helpers');

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

  // .stats — bot-wide info (see .groupstats for per-group numbers)
  async stats(client, msg, args) {
    const [groupCount, userCount] = await Promise.all([
      Group.countDocuments().catch(() => null),
      User.countDocuments().catch(() => null),
    ]);
    const uptime = formatCooldown(process.uptime() * 1000);
    const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);

    msg.reply(
      `📈 *${BOT_NAME} Stats*\n\n` +
      `⏱️ Uptime: ${uptime}\n` +
      `📦 Commands: ${countRegisteredCommands()}\n` +
      `👥 Groups: ${groupCount ?? 'N/A'}\n` +
      `🧑 Registered users: ${userCount ?? 'N/A'}\n` +
      `💾 Memory: ${memMb} MB\n` +
      `🟢 Node: ${process.version}`
    );
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
