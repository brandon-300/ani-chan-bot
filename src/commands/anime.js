// commands/anime.js — SFW anime image commands
// All NSFW commands live in commands/nsfw.js (enabled per-group with .nsfw on).

const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const { fetchRandomImage } = require('../utils/danbooru');

// Build tag-set variants: for each tag combo, try general first, then sensitive.
// Anonymous Danbooru searches allow max 2 tags, so each combo must be ONE tag
// (plus the rating: meta-tag). Animated/comic filtering happens client-side
// in utils/danbooru.js after the response comes back.
function sfwSets(...tagCombos) {
  const sets = [];
  for (const tags of tagCombos.filter(Boolean)) {
    sets.push(`rating:general ${tags}`);
    sets.push(`rating:sensitive ${tags}`);
  }
  return sets;
}

async function sendAnimeImg(msg, url, caption) {
  try {
    // Prefer downloading ourselves so we control the User-Agent / size.
    // Fall back to MessageMedia.fromUrl if the direct download fails.
    let media;
    try {
      const ext = String(url.split('.').pop() || 'jpg').toLowerCase();
      const mime =
        ext === 'png' ? 'image/png' :
        ext === 'webp' ? 'image/webp' : 'image/jpeg';

      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 45000,
        maxContentLength: 20 * 1024 * 1024,
        headers: {
          'User-Agent': 'AniChanBot/1.0 (anime-commands)',
          Referer: 'https://danbooru.donmai.us/',
        },
      });
      media = new MessageMedia(mime, Buffer.from(res.data).toString('base64'), `anichan_${Date.now()}.${ext}`);
    } catch {
      media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    }

    await msg.reply(media, undefined, { caption });
  } catch (err) {
    console.error(`[anime] send failed (${caption}):`, err.message);
    return msg.reply(`❌ Failed to fetch image. API may be down.\n${caption}`).catch(() => {});
  }
}

async function handleSfwImage(msg, tagSets, caption) {
  const post = await fetchRandomImage(tagSets).catch(() => null);
  if (!post) return msg.reply('❌ API unavailable.');
  await sendAnimeImg(msg, post.url, caption);
}

module.exports = {
  // .waifu
  async waifu(client, msg) {
    await handleSfwImage(msg, sfwSets('1girl', '2girls'), '🌸 Waifu');
  },

  // .neko
  async neko(client, msg) {
    await handleSfwImage(msg, sfwSets('cat_girl', 'cat_ears'), '🐱 Neko');
  },

  // .maid
  async maid(client, msg) {
    await handleSfwImage(msg, sfwSets('maid'), '🧹 Maid');
  },

  // .mori-calliope
  async ['mori-calliope'](client, msg) {
    await handleSfwImage(msg, sfwSets('mori_calliope'), '💀 Mori Calliope');
  },

  // .raiden-shogun
  async ['raiden-shogun'](client, msg) {
    await handleSfwImage(msg, sfwSets('raiden_shogun'), '⚡ Raiden Shogun');
  },

  // .selfies — SFW
  async selfies(client, msg) {
    await handleSfwImage(msg, sfwSets('taking_selfie', 'smartphone'), '🤳 Anime Selfie');
  },

  // .uniform
  async uniform(client, msg) {
    await handleSfwImage(msg, sfwSets('school_uniform', 'serafuku'), '👘 Uniform');
  },

  // .kamisato-ayaka
  async ['kamisato-ayaka'](client, msg) {
    await handleSfwImage(msg, sfwSets('kamisato_ayaka'), '❄️ Kamisato Ayaka');
  },
};