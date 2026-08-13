const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const yts = require('yt-search');
const { safeGetChat } = require('../utils/helpers');

// NOTE: All downloaders require RapidAPI keys or alternative APIs.
// Sign up at https://rapidapi.com and get keys for:
// - Instagram DL: instagram-downloader.p.rapidapi.com
// - TikTok DL: tiktok-downloader-download-videos-without-watermark.p.rapidapi.com
// - YouTube DL: youtube-mp36.p.rapidapi.com
// - Twitter/X DL: twitter241.p.rapidapi.com
// - Facebook DL: social-media-video-downloader.p.rapidapi.com

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST_IG = 'instagram-downloader.p.rapidapi.com';
const RAPIDAPI_HOST_TT = 'tiktok-downloader-download-videos-without-watermark.p.rapidapi.com';
const RAPIDAPI_HOST_YT = 'youtube-mp36.p.rapidapi.com';
const RAPIDAPI_HOST_TW = 'twitter241.p.rapidapi.com';
const RAPIDAPI_HOST_FB = 'social-media-video-downloader.p.rapidapi.com';

async function downloadAndSend(msg, url, caption) {
  try {
    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    await chat.sendMessage(media, { caption });
  } catch (err) {
    msg.reply(`❌ Failed to download. Error: ${err.message}`);
  }
}

// Shared status-code -> user message mapping so all downloaders report
// auth/quota/timeout problems consistently instead of one generic string.
function replyForError(msg, label, err) {
  const status = err.response?.status;
  console.error(`[${label}] request failed. status:`, status, 'body:', JSON.stringify(err.response?.data)?.slice(0, 1500) || err.message);

  if (status === 401 || status === 403) {
    msg.reply(`❌ ${label} download failed: RapidAPI rejected the key (401/403).\n💡 Check this RapidAPI account is subscribed to the right API for ${label}, and that the key is correct.`);
  } else if (status === 404) {
    msg.reply(`❌ ${label} download failed: not found (404). The link may be private, deleted, or region-locked.`);
  } else if (status === 429) {
    msg.reply(`❌ ${label} download failed: rate/quota limit hit (429).\n💡 Check your remaining quota on RapidAPI.`);
  } else if (err.code === 'ECONNABORTED') {
    msg.reply(`❌ ${label} download timed out (slow connection). Try again.`);
  } else {
    msg.reply(`❌ ${label} download failed. Check \`pm2 logs ani-chan-bot\` for the exact error.`);
  }
}

module.exports = {
  // .ig [url]
  async ig(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('instagram.com')) return msg.reply('❌ Usage: .ig [instagram url]');

    msg.reply('⏳ Downloading from Instagram...');
    try {
      const res = await axios.get('https://instagram-downloader.p.rapidapi.com/index', {
        params: { url },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST_IG,
        },
        timeout: 20000,
      });

      const mediaUrl = res.data?.media?.[0]?.url || res.data?.url;
      if (!mediaUrl) {
        console.error('[ig] 200 OK but no media URL parsed. Raw response:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract media.');
      }
      await downloadAndSend(msg, mediaUrl, '📸 Downloaded from Instagram');
    } catch (err) {
      replyForError(msg, 'Instagram', err);
    }
  },

  // .ttk [url]
  async ttk(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('tiktok.com')) return msg.reply('❌ Usage: .ttk [tiktok url]');

    msg.reply('⏳ Downloading from TikTok...');
    try {
      const res = await axios.get('https://tiktok-downloader-download-videos-without-watermark.p.rapidapi.com/index', {
        params: { url },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST_TT,
        },
        timeout: 20000,
      });

      const videoUrl = res.data?.video?.[0] || res.data?.url;
      if (!videoUrl) {
        console.error('[ttk] 200 OK but no video URL parsed. Raw response:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract video.');
      }
      await downloadAndSend(msg, videoUrl, '🎵 Downloaded from TikTok');
    } catch (err) {
      replyForError(msg, 'TikTok', err);
    }
  },

  // .yt [url or search query]
  async yt(client, msg, args) {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ Usage: .yt [youtube url or search]');

    msg.reply('⏳ Converting YouTube to MP3...');
    try {
      // Try direct URL first
      const videoId = query.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
      if (!videoId) return msg.reply('❌ Please provide a valid YouTube URL.');

      const res = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
        params: { id: videoId },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST_YT,
        },
      });

      if (res.data.status !== 'ok') {
        console.error('YT conversion non-ok status:', JSON.stringify(res.data));
        return msg.reply('❌ Conversion failed.');
      }
      await downloadAndSend(msg, res.data.link, `🎵 ${res.data.title}`);
    } catch (err) {
      console.error('YT download error:', err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 300) || err.message);
      msg.reply('❌ YouTube download failed.');
    }
  },

  // .x [url] — Twitter/X
  async x(client, msg, args) {
    const url = args[0];
    if (!url || (!url.includes('twitter.com') && !url.includes('x.com'))) {
      return msg.reply('❌ Usage: .x [twitter/x url]');
    }

    msg.reply('⏳ Downloading from X...');
    try {
      const tweetId = url.match(/status\/(\d+)/)?.[1];
      if (!tweetId) return msg.reply('❌ Invalid Twitter/X URL.');

      const res = await axios.get('https://twitter241.p.rapidapi.com/tweet', {
        params: { pid: tweetId },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST_TW,
        },
        timeout: 20000,
      });

      const media = res.data?.tweet?.entities?.media?.[0];
      if (!media) {
        console.error('[x] 200 OK but no media parsed. Raw response:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ No media found in tweet.');
      }

      const videoUrl = media?.video_info?.variants?.find(v => v.content_type === 'video/mp4')?.url;
      const imageUrl = media?.media_url_https;

      if (!videoUrl && !imageUrl) {
        console.error('[x] Media object present but no usable URL. Media object:', JSON.stringify(media)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from tweet.');
      }

      await downloadAndSend(msg, videoUrl || imageUrl, '🐦 Downloaded from X');
    } catch (err) {
      replyForError(msg, 'X', err);
    }
  },

  // .fb [url] — Facebook
  async fb(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('facebook.com')) return msg.reply('❌ Usage: .fb [facebook url]');

    msg.reply('⏳ Downloading from Facebook...');
    try {
      const res = await axios.get('https://social-media-video-downloader.p.rapidapi.com/smvd/get/all', {
        params: { url },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST_FB,
        },
        timeout: 20000,
      });

      const link = res.data?.links?.find(l => l.quality === 'hd')?.link || res.data?.links?.[0]?.link;
      if (!link) {
        console.error('[fb] 200 OK but no link parsed. Raw response:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract video.');
      }
      await downloadAndSend(msg, link, '📘 Downloaded from Facebook');
    } catch (err) {
      replyForError(msg, 'Facebook', err);
    }
  },

  // .play [song name] — search YouTube and return audio
  async play(client, msg, args) {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ Usage: .play [song name]');

    msg.reply(`🔍 Searching for "${query}"...`);
    try {
      // Real YouTube search (youtube-mp36 has no /search endpoint — it only converts a known ID)
      const searchResults = await yts(query);
      const firstResult = searchResults.videos?.[0];
      if (!firstResult) return msg.reply('❌ No results found.');

      // Convert to MP3 via the working /dl endpoint
      const dlRes = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
        params: { id: firstResult.videoId },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST_YT,
        },
      });

      if (dlRes.data.status !== 'ok') {
        console.error('Play conversion non-ok status:', JSON.stringify(dlRes.data));
        return msg.reply('❌ Conversion failed.');
      }
      await downloadAndSend(msg, dlRes.data.link, `🎵 ${dlRes.data.title || firstResult.title}`);
    } catch (err) {
      console.error('Play error:', err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 300) || err.message);
      msg.reply('❌ Play failed. Try with a direct YouTube URL using .yt');
    }
  },
};
