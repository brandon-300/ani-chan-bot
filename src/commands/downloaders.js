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
    return msg.reply(`❌ Failed to download. Error: ${err.message}`);
  }
}

// Sends a "downloading, please wait" preview card (thumbnail + caption)
// before the actual media fetch/conversion happens — same UX .play already
// established. Falls back to a plain-text version of the same caption if
// there's no thumbnail URL at all, or if fetching it fails for any reason,
// so a flaky thumbnail can never block the actual download. No separate
// immediate text reply exists alongside this anymore for any downloader —
// .ig/.ttk/.yt/.x/.fb are all HEAVY_COMMANDS in index.js, which already
// reacts with ⏳ the instant the command is queued, so this preview card
// (sent once the API call resolves enough to know what's being fetched)
// is the richer replacement for what used to be a separate "⏳
// Downloading..." text message, not an addition on top of it.
async function sendDownloadPreview(msg, thumbnailUrl, caption) {
  if (thumbnailUrl) {
    try {
      const thumbMedia = await MessageMedia.fromUrl(thumbnailUrl, { unsafeMime: true });
      await msg.reply(thumbMedia, undefined, { caption });
      return;
    } catch (err) {
      console.error('Download preview: thumbnail fetch failed, falling back to text:', err.message);
    }
  }
  await msg.reply(caption);
}

// Shared status-code -> user message mapping so all downloaders report
// auth/quota/timeout problems consistently instead of one generic string.
function replyForError(msg, label, err) {
  const status = err.response?.status;
  console.error(`[${label}] request failed. status:`, status, 'body:', JSON.stringify(err.response?.data)?.slice(0, 1500) || err.message);

  if (status === 401 || status === 403) {
    return msg.reply(`❌ ${label} download failed: RapidAPI rejected the key (401/403).\n💡 Check this RapidAPI account is subscribed to the right API for ${label}, and that the key is correct.`);
  } else if (status === 404) {
    return msg.reply(`❌ ${label} download failed: not found (404). The link may be private, deleted, or region-locked.`);
  } else if (status === 429) {
    return msg.reply(`❌ ${label} download failed: rate/quota limit hit (429).\n💡 Check your remaining quota on RapidAPI.`);
  } else if (err.code === 'ECONNABORTED') {
    return msg.reply(`❌ ${label} download timed out (slow connection). Try again.`);
  } else {
    return msg.reply(`❌ ${label} download failed. Check \`pm2 logs ani-chan-bot\` for the exact error.`);
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

// The "Social Media Video Downloader" API family returns HTTP 200 even when
// it can't actually get the post — the real reason lives in a top-level
// `error` field instead (e.g. {"error":{"message":"...age-restricted...",
// "code":"not_found"}}). Without checking this, a perfectly legitimate
// "Instagram won't let this API see that post" response looked identical to
// an actual parsing bug — the person just got a generic "could not extract
// media" with the real reason buried in pm2 logs only.
function smvdErrorReason(data) {
  const msg = data?.error?.message;
  return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
}

// CONFIRMED against a real captured Facebook response from this API
// (Brandon ran it directly against RapidAPI and shared the raw JSON) —
// the thumbnail is NOT nested inside contents[0] the way extractSmvdMediaUrl's
// media is; it lives at the top level, under metadata. This function takes
// the full response body (`res.data`), not the content entry.
// metadata.thumbnailUrl is the confirmed primary field; the other two are
// fallbacks seen in that same real response, kept in case thumbnailUrl is
// ever missing on some post type. Same shared API family as
// extractSmvdMediaUrl (Instagram/TikTok/Facebook), so this applies to all
// three the same way.
function extractSmvdThumbnail(data) {
  return (
    data.metadata?.thumbnailUrl ||
    data.metadata?.additionalData?.first_frame_thumbnail ||
    data.metadata?.preferred_thumbnail?.image?.uri ||
    null
  );
}

// YouTube's own video-details endpoint shares the same API family/host as
// extractSmvdMediaUrl but has a different response shape: contents[0].videos[]
// is mostly video-ONLY streams (has_audio: false) at various resolutions —
// that's how YouTube serves anything above roughly 360p — with separate
// contents[0].audios[] streams to match. Only the handful of legacy
// "progressive" formats bundle audio+video together, and those are the only
// ones downloadable and sendable directly the same way the other platforms
// already work, without merging two separate streams via ffmpeg. Confirmed
// against a real captured response (itag 18, 360p, was the progressive
// stream present there).
function extractYtProgressiveStream(content) {
  const progressive = (content.videos || []).find(
    (v) => v.metadata?.has_audio && v.metadata?.has_video
  );
  return progressive?.url || null;
}

module.exports = {




  // .ig [url]
  async ig(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('instagram.com')) return msg.reply('❌ Usage: .ig [instagram url]');

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
        const reason = smvdErrorReason(res.data);
        console.error('[ig] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply(reason
          ? `❌ Instagram couldn't be reached for this post: ${reason}`
          : '❌ Could not extract media.');
      }

      // Preview only for video posts — a photo post's "thumbnail" would
      // just be a redundant preview of the exact same image about to be
      // sent as the actual download a moment later.
      if (content.videos?.length) {
        await sendDownloadPreview(msg, extractSmvdThumbnail(res.data), '📸 Downloading from Instagram...\nPlease wait...');
      }

      const mediaUrl = extractSmvdMediaUrl(content);
      if (!mediaUrl) {
        console.error('[ig] Content present but no usable media URL. Content object:', JSON.stringify(content)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from post.');
      }

      await downloadAndSend(msg, mediaUrl, '📸 Downloaded from Instagram');
    } catch (err) {
      return replyForError(msg, 'Instagram', err);
    }
  },

  // .ttk [url]
  async ttk(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('tiktok.com')) return msg.reply('❌ Usage: .ttk [tiktok url]');

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
        const reason = smvdErrorReason(res.data);
        console.error('[ttk] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply(reason
          ? `❌ TikTok couldn't be reached for this post: ${reason}`
          : '❌ Could not extract media.');
      }

      // Preview only for video posts — see .ig's identical comment above.
      if (content.videos?.length) {
        await sendDownloadPreview(msg, extractSmvdThumbnail(res.data), '🎵 Downloading from TikTok...\nPlease wait...');
      }

      const mediaUrl = extractSmvdMediaUrl(content);
      if (!mediaUrl) {
        console.error('[ttk] Content present but no usable media URL. Content object:', JSON.stringify(content)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from post.');
      }

      await downloadAndSend(msg, mediaUrl, '🎵 Downloaded from TikTok');
    } catch (err) {
      return replyForError(msg, 'TikTok', err);
    }
  },

  // .yt [url or search query]
  async yt(client, msg, args) {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ Usage: .yt [youtube url or search]');

    try {
      const videoId = query.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([a-zA-Z0-9_-]{11})/)?.[1];
      if (!videoId) return msg.reply('❌ Please provide a valid YouTube URL.');

      // music.youtube.com is the one unambiguous signal that this is an
      // audio track rather than a video — a regular youtube.com link to a
      // song upload looks identical to any other video link from the URL
      // alone, so this is the only case that can be told apart reliably.
      // Keeps the existing mp3-conversion flow, since that's genuinely the
      // right tool for actual music.
      if (/music\.youtube\.com/i.test(query)) {
        await sendDownloadPreview(msg, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, '🎵 Converting YouTube Music track to MP3...\nPlease wait...');

        const res = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
          params: { id: videoId },
          headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST_YT,
          },
        });

        if (res.data.status !== 'ok') {
          console.error('YT Music conversion non-ok status:', JSON.stringify(res.data));
          return msg.reply('❌ Conversion failed.');
        }
        return await downloadAndSend(msg, res.data.link, `🎵 ${res.data.title}`);
      }

      // Regular YouTube video or Shorts — download the actual video, same
      // as .ig/.ttk/.fb/.x, instead of converting to mp3.
      const res = await axios.get(
        'https://social-media-video-downloader.p.rapidapi.com/youtube/v3/video/details',
        {
          params: { videoId, urlAccess: 'proxied', renderableFormats: '720p,highres', getTranscript: false },
          headers: {
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': RAPIDAPI_HOST_IG, // same host/subscription as IG/TikTok/FB
          },
          timeout: 20000,
        }
      );

      const content = res.data?.contents?.[0];
      if (!content) {
        console.error('[yt] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply('❌ Could not extract media from this video.');
      }

      // metadata.thumbnailUrl is confirmed present for YouTube too (same
      // field as Facebook), with the hqdefault.jpg construction as a
      // YouTube-only extra fallback since we already have the video ID.
      const thumbnailUrl = extractSmvdThumbnail(res.data) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      await sendDownloadPreview(msg, thumbnailUrl, '🎬 Downloading from YouTube...\nPlease wait...');

      const mediaUrl = extractYtProgressiveStream(content);
      if (!mediaUrl) {
        console.error('[yt] No progressive (audio+video) stream found. Videos:', JSON.stringify(content.videos?.map(v => ({ label: v.label, has_audio: v.metadata?.has_audio, has_video: v.metadata?.has_video })))?.slice(0, 500));
        return msg.reply('❌ Could not find a downloadable format for this video — it may only have separate audio and video tracks.');
      }

      const title = res.data?.metadata?.title;
      await downloadAndSend(msg, mediaUrl, title ? `🎬 ${title}` : '🎬 Downloaded from YouTube');
    } catch (err) {
      console.error('YT download error:', err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 300) || err.message);
      return msg.reply('❌ YouTube download failed.');
    }
  },

  // .x [url] — Twitter/X
  async x(client, msg, args) {
    const url = args[0];
    if (!url || (!url.includes('twitter.com') && !url.includes('x.com'))) {
      return msg.reply('❌ Usage: .x [twitter/x url]');
    }

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
        // video or animated_gif — media_url_https here is the poster/
        // thumbnail image (Twitter's own API reuses this same field for
        // that purpose on video entries), distinct from the actual video
        // file URLs in video_info.variants below.
        await sendDownloadPreview(msg, media.media_url_https, '🐦 Downloading from X...\nPlease wait...');
        const mp4Variants = (media.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
        mediaUrl = mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;
      }

      if (!mediaUrl) {
        console.error('[x] Media object present but no usable URL. Media object:', JSON.stringify(media)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from tweet.');
      }

      await downloadAndSend(msg, mediaUrl, '🐦 Downloaded from X');
    } catch (err) {
      return replyForError(msg, 'X', err);
    }
  },

  // .fb [url] — Facebook
  async fb(client, msg, args) {
    const url = args[0];
    if (!url || !url.includes('facebook.com')) return msg.reply('❌ Usage: .fb [facebook url]');

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
        const reason = smvdErrorReason(res.data);
        console.error('[fb] 200 OK but no contents parsed. Raw:', JSON.stringify(res.data)?.slice(0, 1500));
        return msg.reply(reason
          ? `❌ Facebook couldn't be reached for this post: ${reason}`
          : '❌ Could not extract media.');
      }

      // Preview only for video posts — see .ig's identical comment above.
      if (content.videos?.length) {
        await sendDownloadPreview(msg, extractSmvdThumbnail(res.data), '📘 Downloading from Facebook...\nPlease wait...');
      }

      const mediaUrl = extractSmvdMediaUrl(content);
      if (!mediaUrl) {
        console.error('[fb] Content present but no usable media URL. Content object:', JSON.stringify(content)?.slice(0, 1000));
        return msg.reply('❌ Could not extract media from post.');
      }

      await downloadAndSend(msg, mediaUrl, '📘 Downloaded from Facebook');
    } catch (err) {
      return replyForError(msg, 'Facebook', err);
    }
  },

  // .play [song name] — search YouTube and return audio
  async play(client, msg, args) {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ Usage: .play [song name]');

    try {
      // Real YouTube search (youtube-mp36 has no /search endpoint — it only converts a known ID)
      const searchResults = await yts(query);
      const firstResult = searchResults.videos?.[0];
      if (!firstResult) return msg.reply('❌ No results found.');

      const title = firstResult.title;

      // "Now processing" card — thumbnail + caption, sent while the actual
      // audio conversion (below) is still in flight. Matches the reference
      // bot: the ▶️ reaction (index.js's heavy-command handling) already
      // acknowledges the command itself, so there's no separate plain-text
      // "Searching..." message anymore — this thumbnail IS that
      // acknowledgment now. Per Brandon, only sent "if there is any [thumbnail]
      // for that particular request" — falls back to a plain-text version
      // of the same message if there's no thumbnail URL at all, or if
      // fetching it fails for any reason, so a flaky thumbnail fetch can
      // never block the actual song from playing.
      const nowPlayingCaption = `Playing: ${title.toUpperCase()}\nPlease wait...`;
      if (firstResult.thumbnail) {
        try {
          const thumbMedia = await MessageMedia.fromUrl(firstResult.thumbnail, { unsafeMime: true });
          await msg.reply(thumbMedia, undefined, { caption: nowPlayingCaption });
        } catch (err) {
          console.error('Play: thumbnail fetch failed, falling back to text:', err.message);
          await msg.reply(nowPlayingCaption);
        }
      } else {
        await msg.reply(nowPlayingCaption);
      }

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
      return msg.reply('❌ Play failed. Try with a direct YouTube URL using .yt');
    }
  },
};
