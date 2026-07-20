const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');

// ─── nekos.best API — free anime GIFs ─────────────────────────────────────────
async function getGif(endpoint) {
  try {
    const res = await axios.get(`https://nekos.best/api/v2/${endpoint}`);
    return res.data.results[0].url;
  } catch {
    return null;
  }
}

async function sendGif(msg, endpoint, text) {
  const url = await getGif(endpoint);
  if (url) {
    try {
      const media = await MessageMedia.fromUrl(url);
      const contact = await msg.getContact();
      const chat = await msg.getChat();
      await chat.sendMessage(media, { caption: text });
      return;
    } catch {}
  }
  // Fallback: text only
  msg.reply(text);
}

async function buildText(msg, action, emoji) {
  const contact = await msg.getContact();
  const mentioned = await msg.getMentions();
  const target = mentioned.length ? `@${mentioned[0].number}` : 'everyone';
  return `${emoji} *${contact.pushname}* ${action} *${target}*`;
}

module.exports = {
  async hug(client, msg, args) {
    const text = await buildText(msg, 'hugged', '🤗');
    await sendGif(msg, 'hug', text);
  },

  async kiss(client, msg, args) {
    const text = await buildText(msg, 'kissed', '💋');
    await sendGif(msg, 'kiss', text);
  },

  async slap(client, msg, args) {
    const text = await buildText(msg, 'slapped', '👋');
    await sendGif(msg, 'slap', text);
  },

  async wave(client, msg, args) {
    const text = await buildText(msg, 'waved at', '👋');
    await sendGif(msg, 'wave', text);
  },

  async pat(client, msg, args) {
    const text = await buildText(msg, 'patted', '🫶');
    await sendGif(msg, 'pat', text);
  },

  async dance(client, msg, args) {
    const contact = await msg.getContact();
    await sendGif(msg, 'dance', `💃 *${contact.pushname}* is dancing!`);
  },

  async sad(client, msg, args) {
    const contact = await msg.getContact();
    await sendGif(msg, 'cry', `😢 *${contact.pushname}* is feeling sad...`);
  },

  async smile(client, msg, args) {
    const contact = await msg.getContact();
    await sendGif(msg, 'smile', `😊 *${contact.pushname}* is smiling!`);
  },

  async laugh(client, msg, args) {
    const contact = await msg.getContact();
    await sendGif(msg, 'laugh', `😂 *${contact.pushname}* is laughing!`);
  },

  async lick(client, msg, args) {
    const text = await buildText(msg, 'licked', '👅');
    await sendGif(msg, 'lick', text);
  },

  async punch(client, msg, args) {
    const text = await buildText(msg, 'punched', '👊');
    await sendGif(msg, 'punch', text);
  },

  async jihad(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(`☪️ *${contact.pushname}* declared a holy war on the chat! 💣 (meme command)`);
  },

  async crusade(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(`✝️ *${contact.pushname}* called for a crusade! ⚔️ Deus Vult! (meme command)`);
  },

  async kill(client, msg, args) {
    const text = await buildText(msg, 'eliminated', '💀');
    await sendGif(msg, 'shoot', text);
  },

  async bonk(client, msg, args) {
    const text = await buildText(msg, 'bonked', '🔨');
    await sendGif(msg, 'slap', text);
  },

  // intentionally left as text — family-friendly bot
  async fuck(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'the void';
    msg.reply(`😤 *${contact.pushname}* said a bad word at *${target}*! (meme command)`);
  },

  async tickle(client, msg, args) {
    const text = await buildText(msg, 'tickled', '🤣');
    await sendGif(msg, 'tickle', text);
  },

  async shrug(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(`🤷 *${contact.pushname}*: ¯\\_(ツ)_/¯`);
  },

  async wank(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(`😏 *${contact.pushname}* is... busy. Please do not disturb. (meme command)`);
  },

  async kidnap(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'someone';
    msg.reply(`🚨 *${contact.pushname}* tried to kidnap *${target}*! 🚓 Police on the way! (meme command)`);
  },
};
