require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
});

const PREFIX = process.env.PREFIX || '.';
const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';

const commands = {};
const commandDir = path.join(__dirname, 'commands');

fs.readdirSync(commandDir).forEach(file => {
  if (!file.endsWith('.js')) return;
  const module = require(path.join(commandDir, file));
  Object.entries(module).forEach(([name, fn]) => {
    commands[name.toLowerCase()] = fn;
  });
});

console.log(`✅ Loaded ${Object.keys(commands).length} commands`);

const aliases = {
  bal: 'balance',
  wd: 'withdraw',
  dep: 'deposit',
  p: 'profile',
  inv: 'inventory',
  lb: 'leaderboard',
  s: 'sticker',
  lc: 'lendcard',
  gs: 'groupstats',
  aki: 'akinator',
  gg: 'greekgod',
  wyr: 'wouldyourather',
  pint: 'pinterest',
  reverseimg: 'sauce',
  tt: 'translate',
  tb: 'transcribe',
};

async function sendQuickMenu(msg) {
  const menu = `👋 *${BOT_NAME}* — Quick Menu

Prefix: *${PREFIX}*

🛡️ *Admin*: kick, mute, warn, antilink, welcome
🤖 *AI*: gpt, imagine, upscale, translate
⬇️ *Download*: ig, ttk, yt, x, fb
🔍 *Search*: lyrics, pinterest, sauce, wallpaper
🎴 *Cards*: card, claim, deck, auction
💰 *Economy*: balance, daily, shop, gamble
🎮 *Games*: chess, ttt, c4, akinator
🎉 *Fun*: joke, truth, dare, ship, roast
🐾 *Pets*: pet adopt, pet feed, pet play
🖼️ *Media*: sticker, toimg, tovid

Type *${PREFIX}<command>* to use one.`;

  await msg.reply(menu);
}

client.on('qr', qr => {
  console.log('📱 Scan this QR code:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log(`
╭━━★彡 ${BOT_NAME} is ONLINE 彡★━━╮
┃  Prefix : ${PREFIX}
┃  Commands: ${Object.keys(commands).length}
╰━━━━━━━━━━━━━━━━━━━━━━╯
  `);
});

client.on('message', async (msg) => {
  try {
    const body = msg.body || '';

    // ── @mention or reply-to-bot trigger: show quick menu ────────────────────
    if (!body.startsWith(PREFIX)) {
      const mentionsBot = msg.mentionedIds &&
        msg.mentionedIds.includes(client.info.wid._serialized);

      let repliedToBot = false;
      if (!mentionsBot && msg.hasQuotedMsg) {
        const quoted = await msg.getQuotedMessage();
        repliedToBot = quoted.fromMe;
      }

      if (mentionsBot || repliedToBot) {
        return await sendQuickMenu(msg);
      }
      return;
    }

    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    let command = args.shift().toLowerCase();

    if (aliases[command]) command = aliases[command];

    if (command === 'guild' && args.length > 0) {
      const sub = `guild_${args.shift().toLowerCase()}`;
      if (commands[sub]) return await commands[sub](client, msg, args);
    }

    if (command === 'pet' && args.length > 0) {
      const sub = `pet_${args[0].toLowerCase()}`;
      if (commands[sub]) {
        args.shift();
        return await commands[sub](client, msg, args);
      }
    }

    if (!commands[command]) return;

    await commands[command](client, msg, args);
  } catch (err) {
    console.error('Command error:', err);
    msg.reply('❌ An error occurred. Please try again.');
  }
});

client.on('group_join', async (notification) => {
  const { commands: cmds } = require('./commands/admin');
  if (cmds && cmds.onJoin) await cmds.onJoin(client, notification);
});

client.on('group_leave', async (notification) => {
  const { commands: cmds } = require('./commands/admin');
  if (cmds && cmds.onLeave) await cmds.onLeave(client, notification);
});

client.on('message', async (msg) => {
  const Group = require('./models/Group');
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  const group = await Group.findOne({ id: chat.id._serialized });
  if (!group || !group.antilink) return;

  const hasLink = /(https?:\/\/|wa\.me|chat\.whatsapp\.com)/i.test(msg.body);
  if (!hasLink) return;

  const contact = await msg.getContact();
  const isAdmin = chat.participants.find(
    p => p.id._serialized === contact.id._serialized && p.isAdmin
  );
  if (isAdmin) return;

  await msg.delete(true);
  const action = group.antilinkAction || 'warn';
  if (action === 'kick') {
    await chat.removeParticipants([contact.id._serialized]);
    chat.sendMessage(`🚫 @${contact.number} was kicked for sending a link.`, { mentions: [contact] });
  } else {
    chat.sendMessage(`⚠️ @${contact.number} don't send links here!`, { mentions: [contact] });
  }
});

client.initialize();
