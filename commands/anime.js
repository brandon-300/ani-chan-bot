const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const Group = require('../models/Group');

// ─── nekos.best — SFW anime images ───────────────────────────────────────────
async function getSFW(endpoint) {
  const res = await axios.get(`https://nekos.best/api/v2/${endpoint}`);
  return res.data.results[0].url;
}

// ─── waifu.im — NSFW anime images ────────────────────────────────────────────
async function getNSFW(tag) {
  const res = await axios.get('https://api.waifu.im/search', {
    params: { included_tags: tag, is_nsfw: 'true' },
  });
  return res.data.images[0].url;
}

async function sendAnimeImg(msg, url, caption, nsfw = false) {
  try {
    if (nsfw) {
      const chat = await msg.getChat();
      if (!chat.isGroup) return msg.reply('❌ NSFW commands can only be used in groups.');

      const group = await Group.findOne({ id: chat.id._serialized });
      if (!group?.nsfw) {
        return msg.reply('❌ NSFW is disabled in this group.\nAdmin can enable it with *.nsfw on*');
      }
    }

    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    const chat = await msg.getChat();
    await chat.sendMessage(media, { caption });
  } catch (err) {
    msg.reply(`❌ Failed to fetch image. API may be down.\n${caption}`);
  }
}

// ─── SFW Commands ─────────────────────────────────────────────────────────────
module.exports = {
  // .waifu
  async waifu(client, msg, args) {
    const url = await getSFW('waifu').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🌸 Waifu');
  },

  // .neko
  async neko(client, msg, args) {
    const url = await getSFW('neko').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🐱 Neko');
  },

  // .maid
  async maid(client, msg, args) {
    const url = await getSFW('maid').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🧹 Maid');
  },

  // .mori-calliope
  async ['mori-calliope'](client, msg, args) {
    try {
      const res = await axios.get('https://nekos.best/api/v2/neko');
      await sendAnimeImg(msg, res.data.results[0].url, '💀 Mori Calliope');
    } catch {
      msg.reply('❌ API unavailable.');
    }
  },

  // .raiden-shogun
  async ['raiden-shogun'](client, msg, args) {
    try {
      const res = await axios.get('https://nekos.best/api/v2/waifu');
      await sendAnimeImg(msg, res.data.results[0].url, '⚡ Raiden Shogun');
    } catch {
      msg.reply('❌ API unavailable.');
    }
  },

  // .oppai
  async oppai(client, msg, args) {
    try {
      const res = await axios.get('https://nekos.best/api/v2/waifu');
      await sendAnimeImg(msg, res.data.results[0].url, '🌸 Oppai');
    } catch {
      msg.reply('❌ API unavailable.');
    }
  },

  // .selfies
  async selfies(client, msg, args) {
    const url = await getSFW('waifu').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🤳 Anime Selfie');
  },

  // .uniform
  async uniform(client, msg, args) {
    const url = await getSFW('maid').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '👘 Uniform');
  },

  // .kamisato-ayaka
  async ['kamisato-ayaka'](client, msg, args) {
    try {
      const res = await axios.get('https://nekos.best/api/v2/waifu');
      await sendAnimeImg(msg, res.data.results[0].url, '❄️ Kamisato Ayaka');
    } catch {
      msg.reply('❌ API unavailable.');
    }
  },

  // ─── NSFW Toggle ─────────────────────────────────────────────────────────────
  // .nsfw on/off
  async nsfw(client, msg, args) {
    const chat = await msg.getChat();
    if (!chat.isGroup) return msg.reply('❌ Group only.');

    const contact = await msg.getContact();
    const participant = chat.participants.find(p => p.id._serialized === contact.id._serialized);
    if (!participant?.isAdmin && !participant?.isSuperAdmin) {
      return msg.reply('❌ Admins only!');
    }

    const sub = args[0]?.toLowerCase();
    if (!sub || !['on', 'off'].includes(sub)) return msg.reply('❌ Usage: .nsfw [on/off]');

    const group = await Group.findOneAndUpdate(
      { id: chat.id._serialized },
      { nsfw: sub === 'on' },
      { upsert: true, new: true }
    );

    msg.reply(`🔞 NSFW is now *${group.nsfw ? 'ON' : 'OFF'}* in this group.`);
  },

  // ─── NSFW Commands ────────────────────────────────────────────────────────────
  // .milf
  async milf(client, msg, args) {
    const url = await getNSFW('milf').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🔞 Milf', true);
  },

  // .ass
  async ass(client, msg, args) {
    const url = await getNSFW('ass').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🍑 Ass', true);
  },

  // .hentai
  async hentai(client, msg, args) {
    const url = await getNSFW('hentai').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🔞 Hentai', true);
  },

  // .oral
  async oral(client, msg, args) {
    const url = await getNSFW('oral').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🔞 Oral', true);
  },

  // .ecchi
  async ecchi(client, msg, args) {
    const url = await getNSFW('ecchi').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🔞 Ecchi', true);
  },

  // .paizuri
  async paizuri(client, msg, args) {
    const url = await getNSFW('paizuri').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🔞 Paizuri', true);
  },

  // .ero
  async ero(client, msg, args) {
    const url = await getNSFW('ero').catch(() => null);
    if (!url) return msg.reply('❌ API unavailable.');
    await sendAnimeImg(msg, url, '🔞 Ero', true);
  },

  // .ehentai — link to e-hentai with tag
  async ehentai(client, msg, args) {
    const chat = await msg.getChat();
    if (chat.isGroup) {
      const group = await Group.findOne({ id: chat.id._serialized });
      if (!group?.nsfw) return msg.reply('❌ NSFW is disabled here.');
    }
    const tag = args.join('+') || 'anime';
    msg.reply(`🔞 *E-Hentai Search*\n\n🔗 https://e-hentai.org/?f_search=${tag}`);
  },

  // .nhentai — link to nhentai with code or tag
  async nhentai(client, msg, args) {
    const chat = await msg.getChat();
    if (chat.isGroup) {
      const group = await Group.findOne({ id: chat.id._serialized });
      if (!group?.nsfw) return msg.reply('❌ NSFW is disabled here.');
    }
    const code = args[0];
    if (code && /^\d+$/.test(code)) {
      msg.reply(`🔞 *NHentai*\n\n🔗 https://nhentai.net/g/${code}/`);
    } else {
      const tag = args.join('+') || 'anime';
      msg.reply(`🔞 *NHentai Search*\n\n🔗 https://nhentai.net/search/?q=${tag}`);
    }
  },
};
