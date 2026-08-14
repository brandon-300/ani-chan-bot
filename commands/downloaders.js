const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const yts = require('yt-search');

// NOTE: All downloaders require RapidAPI keys or alternative APIs.
// Sign up at https://rapidapi.com and get keys for:
// - Instagram DL: social-media-video-downloader.p.rapidapi.com
// - TikTok DL: social-media-video-downloader.p.rapidapi.com (same family as IG/FB — /tiktok/v3/post/details)
// - YouTube DL: youtube-mp36.p.rapidapi.com
// - Twitter/X DL: twittr-v2-fastest-twitter-x-api-150k-requests-for-15.p.rapidapi.com
// - Facebook DL: social-media-video-downloader.p.rapidapi.com

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST_IG = 'social-media-video-downloader.p.rapidapi.com';
const RAPIDAPI_HOST_TT = 'social-media-video-downloader.p.rapidapi.com';
const RAPIDAPI_HOST_YT = 'youtube-mp36.p.rapidapi.com';
const RAPIDAPI_HOST_TW = 'twittr-v2-fastest-twitter-x-api-150k-requests-for-15.p.rapidapi.com';
const RAPIDAPI_HOST_FB = 'social-media-video-downloader.p.rapidapi.com';

async function downloadAndSend(msg, url, caption) {
  try {
    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    // msg.reply() (not chat.sendMessage()) so the downloaded media appears
    // as a quoted reply under the triggering command — same fix already
    // applied to the game board sends and to converter.js.
    await msg.reply(media, undefined, { caption });
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

// Shared extraction logic for the "Social Media Video Downloader" API family
// (Instagram and Facebook both return the same contents[].videos[]/images[]
// shape from this provider).
function extractSmvdMediaUrl(content) {
  if (content.videos?.length) {
    // Several video entries are silent DASH tracks meant to be paired with
    // a separate audios[] track by a player — pick the entry whose own
    // metadata says it already has audio (the platform's own canonical
    // combined file, e.g. IG's video_versions[0] / FB's native_hd).
    return content.videos.find(v => v.metadata?.has_audio)?.url || content.videos[0]?.url;
  }
  if (content.images?.length) {
    // NOTE: unverified — only confirmed against video posts on both
    // platforms so far. First field name to check if a photo post fails.
    return content.images[0]?.url;
  }
  return null;
}

module.exports = {
  // .ig [url]
  async ig(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('instagram.com')) return msg.reply('❌ Usage: .ig [instagram url]');

    msg.reply('⏳ Downloading from Instagram...');
    try {
      const shortcode = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[1];
      if (!shortcode) return msg.reply('❌ Could not parse Instagram post/reel URL.');

      const res = await axios.get(
        'https://social-media-video-downloader.p.rapidapi.com/instagram/v3/media/post/details',
        {
          params: { shortcode, renderableFormats: '720p,highres' },
          headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST_IG,
          },
          timeout: 20000,
        }
      );

      const content = res.data?.contents?.[0];
      if (!content) {
        console.error('[ig] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract media.');
      }

      const mediaUrl = extractSmvdMediaUrl(content);
      if (!mediaUrl) {
        console.error('[ig] Content present but no usable media URL. Content object:', JSON.stringify(content)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from post.');
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
      const res = await axios.get(
        'https://social-media-video-downloader.p.rapidapi.com/tiktok/v3/post/details',
        {
          params: { url },
          headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST_TT,
          },
          timeout: 20000,
        }
      );

      const content = res.data?.contents?.[0];
      if (!content) {
        console.error('[ttk] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract media.');
      }

      const mediaUrl = extractSmvdMediaUrl(content);
      if (!mediaUrl) {
        console.error('[ttk] Content present but no usable media URL. Content object:', JSON.stringify(content)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from post.');
      }

      await downloadAndSend(msg, mediaUrl, '🎵 Downloaded from TikTok');
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

      const res = await axios.get(
        `https://${RAPIDAPI_HOST_TW}/tweet/${tweetId}`,
        {
          headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST_TW,
          },
          timeout: 20000,
        }
      );

      // This API passes through Twitter's own internal GraphQL response
      // almost unmodified. The tweet we asked for isn't always entries[0]
      // (replies/cursors/other modules can be interleaved), so find it by
      // its entryId ("tweet-<id>") rather than assuming position.
      const instructions = res.data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
      let tweetResult = null;
      for (const instruction of instructions) {
        const match = (instruction.entries || []).find(e => e.entryId === `tweet-${tweetId}`);
        if (match) {
          tweetResult = match.content?.itemContent?.tweet_results?.result || null;
          break;
        }
      }

      if (!tweetResult) {
        console.error('[x] Could not locate tweet entry in response. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not read tweet content from the API response.');
      }

      const mediaList = tweetResult?.legacy?.extended_entities?.media || tweetResult?.legacy?.entities?.media || [];
      if (!mediaList.length) {
        // Genuinely valid outcome — this tweet has no photo/video attached.
        return msg.reply('❌ No media found in tweet.');
      }

      const media = mediaList[0];
      let mediaUrl;
      if (media.type === 'photo') {
        mediaUrl = media.media_url_https;
      } else {
        // video or animated_gif — pick the highest-bitrate mp4 variant
        const mp4Variants = (media.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
        mediaUrl = mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;
      }

      if (!mediaUrl) {
        console.error('[x] Media object present but no usable URL. Media object:', JSON.stringify(media)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from tweet.');
      }

      await downloadAndSend(msg, mediaUrl, '🐦 Downloaded from X');
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
      const res = await axios.get(
        'https://social-media-video-downloader.p.rapidapi.com/facebook/v3/post/details',
        {
          params: { url, renderableFormats: '720p,highres' },
          headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST_FB,
          },
          timeout: 20000,
        }
      );

      const content = res.data?.contents?.[0];
      if (!content) {
        console.error('[fb] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract media.');
      }

      const mediaUrl = extractSmvdMediaUrl(content);
      if (!mediaUrl) {
        console.error('[fb] Content present but no usable media URL. Content object:', JSON.stringify(content)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from post.');
      }

      await downloadAndSend(msg, mediaUrl, '📘 Downloaded from Facebook');
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
