const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const SentWallpaper = require('../models/SentWallpaper');
const { safeGetChat, safeGetQuotedMessage } = require('../utils/helpers');
const gemini = require('../utils/gemini');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

async function sendImage(msg, url, caption) {
  try {
    const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
    const chat = await safeGetChat(msg);
    if (!chat) return;
    if (!chat) return;
    await chat.sendMessage(media, { caption });
  } catch {
    msg.reply(caption + `\n🔗 ${url}`);
  }
}

// LRCLIB only guarantees syncedLyrics for some entries — strips the
// leading "[mm:ss.xx] " timestamp off each line so it reads as plain text
// when plainLyrics itself isn't available for that entry.
function stripLrcTimestamps(syncedLyrics) {
  if (!syncedLyrics) return '';
  return syncedLyrics
    .split('\n')
    .map(line => line.replace(/^\[\d{2}:\d{2}(?:\.\d{2,3})?\]\s*/, ''))
    .join('\n')
    .trim();
}

module.exports = {
  // .pinterest [query]
  async pinterest(client, msg, args) {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ Usage: .pinterest [search term]');

    msg.reply(`🔍 Searching Pinterest for "${query}"...`);
    try {
      const res = await axios.get('https://pinterest-scraper.p.rapidapi.com/search', {
        params: { query, limit: '5' },
        headers: {
          'X-RapidAPI-Key': RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'pinterest-scraper.p.rapidapi.com',
        },
      });

      const pins = res.data?.data || res.data?.results || [];
      if (!pins.length) return msg.reply('❌ No results found.');

      const pin = pins[0];
      const imgUrl = pin?.images?.['736x']?.url || pin?.image_url || pin?.imageUrl;
      if (!imgUrl) return msg.reply('❌ Could not extract image.');

      await sendImage(msg, imgUrl, `📌 Pinterest: ${query}`);
    } catch (err) {
      msg.reply('❌ Pinterest search failed. Check your RapidAPI key.\n💡 Tip: Subscribe to "Pinterest Scraper" on RapidAPI.');
    }
  },

  // .sauce / .reverseimg — reverse image search
  //
  // SauceNAO can only confirm a match if this EXACT image (or a near-identical
  // crop/recompression of it) already exists in one of its crawled databases
  // (Pixiv, Danbooru, Gelbooru, e-hentai, deviantArt, etc). Wallpaper edits,
  // AI-upscaled images, and anything not sourced from those sites are usually
  // NOT indexed at all — SauceNAO then returns its closest visual guesses
  // (often from totally unrelated indexes) at low similarity, which is noise,
  // not a real answer. Filtering those out is necessary, but leaves the
  // person with nothing. So: if SauceNAO can't confidently confirm a source,
  // fall back to asking Gemini vision to identify the character/scene
  // directly — clearly labeled as an AI guess, not a confirmed source, since
  // it's a fundamentally less certain kind of answer than a real source match.
  async sauce(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) {
      return msg.reply('❌ Reply to an image with .sauce to reverse search it.');
    }

    msg.reply('🔍 Reverse searching image...');

    let media;
    try {
      media = await targetMsg.downloadMedia();
    } catch (err) {
      return msg.reply('❌ Could not download that image — it may have expired. Try re-sending it.');
    }
    if (!media?.data) {
      return msg.reply('❌ Could not download that image — it may have expired. Try re-sending it.');
    }

    // Fixed, fairly strict floor. SauceNAO's own suggested
    // header.minimum_similarity can be as low as ~30%, which lets through
    // noise matches (wrong index, unrelated image) — it's a "don't bother
    // returning literal garbage" floor, not a "this is actually correct"
    // signal. 60% is the commonly used bar for a trustworthy exact match.
    const CONFIDENCE_FLOOR = 60;
    let sauceResult = null; // { confident: [...] } | { bestSimilarity: number|null } | null (hard error)

    try {
      const imageBuffer = Buffer.from(media.data, 'base64');

      // Use SauceNAO API for anime sources
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', imageBuffer, { filename: 'image.jpg', contentType: media.mimetype });
      form.append('output_type', '2');
      form.append('numres', '6');

      const res = await axios.post(
        `https://saucenao.com/search.php?api_key=${process.env.SAUCENAO_KEY || 'demo'}&output_type=2`,
        form,
        { headers: form.getHeaders(), timeout: 30000 }
      );

      const header = res.data?.header;

      // SauceNAO returns HTTP 200 even on errors — the real status lives in header.status.
      if (!header || header.status < 0) {
        console.error('[sauce] SauceNAO API error, header:', JSON.stringify(header));
        // Fall through to the Gemini fallback below rather than dead-ending here.
      } else {
        const allResults = res.data?.results || [];
        const sorted = [...allResults].sort(
          (a, b) => parseFloat(b.header?.similarity || 0) - parseFloat(a.header?.similarity || 0)
        );
        const confident = sorted.filter(r => parseFloat(r.header?.similarity) >= CONFIDENCE_FLOOR);

        sauceResult = confident.length
          ? { confident }
          : { bestSimilarity: sorted[0] ? parseFloat(sorted[0].header?.similarity) : null };
      }
    } catch (err) {
      console.error('[sauce] SauceNAO request failed:', err.response?.data || err.message);
      // Fall through to the Gemini fallback below rather than dead-ending here.
    }

    // Confident SauceNAO match — this is a confirmed source, show it and stop.
    if (sauceResult?.confident) {
      let text = `🔍 *Reverse Image Results*\n\n`;
      sauceResult.confident.slice(0, 3).forEach((r, i) => {
        text += `${i + 1}. *${r.header?.index_name || 'Unknown'}*\n`;
        text += `   Similarity: ${r.header?.similarity}%\n`;
        const ext = r.data?.ext_urls?.[0];
        if (ext) text += `   🔗 ${ext}\n`;
        text += '\n';
      });
      return msg.reply(text);
    }

    // No confident SauceNAO match (or SauceNAO errored/rate-limited/timed
    // out) — fall back to Gemini vision for a best-effort character/scene ID.
    try {
      const identification = await gemini.generateVision({
        prompt:
          'Identify the anime/manga character, series, and scene in this image if you recognize it. ' +
          'Reply in 2-3 short sentences: character name, series title, and any notable context ' +
          '(e.g. arc/season/outfit) if identifiable. If you do not recognize it or are not confident, say so plainly — do not guess.',
        base64Image: media.data,
        mimeType: media.mimetype,
        maxOutputTokens: 300,
      });

      const prefix = sauceResult?.bestSimilarity
        ? `🔍 No confirmed source found on SauceNAO (closest match only ${sauceResult.bestSimilarity}% similar — likely wrong, not shown).\n\n`
        : `🔍 SauceNAO couldn't confirm a source for this image.\n\n`;

      return msg.reply(`${prefix}🤖 *AI best guess* (not a confirmed source):\n${identification}`);
    } catch (err) {
      console.error('[sauce] Gemini fallback failed:', err.message);
      if (sauceResult?.bestSimilarity) {
        return msg.reply(
          `❌ No confident match found.\n📉 Closest SauceNAO result was only ${sauceResult.bestSimilarity}% similar, so it's likely wrong and wasn't shown.\n💡 Try a clearer, uncropped, or higher-resolution image.`
        );
      }
      return msg.reply('❌ Reverse search failed. Make sure to reply to an image.\n💡 Get a free SauceNAO API key at saucenao.com');
    }
  },

  // .wallpaper [query]
async wallpaper(client, msg, args) {
    const query = args.join(' ') || 'anime';
    msg.reply(`🖼️ Fetching wallpaper for "${query}"...`);

    try {
      const chat = await safeGetChat(msg);
    if (!chat) return;
      if (!chat) return;
      const chatId = chat.id._serialized;

      // Wallhaven API — free, no key needed for SFW
      const res = await axios.get('https://wallhaven.cc/api/v1/search', {
        params: {
          q: query,
          purity: '100',    // SFW only
          categories: '111',
          sorting: 'random',
          per_page: 24,
        },
      });

      const wallpapers = res.data?.data || [];
      if (!wallpapers.length) return msg.reply('❌ No wallpapers found.');

      const seenDocs = await SentWallpaper.find({
        chatId,
        wallpaperId: { $in: wallpapers.map(w => w.id) },
      }).select('wallpaperId -_id');
      const seenIds = new Set(seenDocs.map(d => d.wallpaperId));

      const fresh = wallpapers.filter(w => !seenIds.has(w.id));

      if (!fresh.length) {
        return msg.reply(`❌ You've seen all recent wallpapers for "${query}". Try a different search, or wait for new ones to be added.`);
      }

      const wall = fresh[Math.floor(Math.random() * fresh.length)];
      await SentWallpaper.create({ chatId, wallpaperId: wall.id }).catch(() => {});

      const imgUrl = wall.path;
      await sendImage(msg, imgUrl, `🖼️ Wallpaper: ${query}\n📐 ${wall.resolution}`);
    } catch (err) {
      msg.reply('❌ Wallpaper search failed.');
    }
  },

  // .lyrics [song name]
  //
  // Uses LRCLIB (https://lrclib.net) — free, no API key/signup, no rate
  // limit, and purpose-built for lyrics (as opposed to being one minor
  // endpoint on a general novelty API). Switched from Some Random API
  // after it repeatedly failed on mainstream, correctly-attributed anime
  // songs in production (e.g. "Inferno" by Mrs. GREEN APPLE — the Fire
  // Force OP — see pm2 logs 2026-08-13), which pointed to weak underlying
  // coverage rather than a query-formatting problem.
  async lyrics(client, msg, args) {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ Usage: .lyrics [song name]');

    msg.reply(`🎵 Searching lyrics for "${query}"...`);

    const search = (params) =>
      axios.get('https://lrclib.net/api/search', {
        params,
        headers: { 'User-Agent': 'AniChan-WhatsApp-Bot/1.0' },
        timeout: 15000,
      });

    // "Title by Artist" is a natural way to type it, and LRCLIB's search
    // matches better against track_name/artist_name split apart than
    // against one free-text string containing the literal word "by". If
    // that split search comes up empty (e.g. a wrong/tie-in artist credit),
    // fall back to a plain free-text search on the whole query.
    const byMatch = query.match(/^(.*?)\s+by\s+(.+)$/i);

    try {
      let results = [];

      if (byMatch) {
        const [, title, artist] = byMatch;
        const res = await search({ track_name: title.trim(), artist_name: artist.trim() });
        results = res.data || [];
      }

      if (!results.length) {
        const res = await search({ q: query });
        results = res.data || [];
      }

      const best = results.find(r => r.plainLyrics || r.syncedLyrics);

      if (!best) {
        return msg.reply(
          `❌ Lyrics not found for "${query}".\n💡 Try a different spelling/romanization, or drop the artist and just search the title.`
        );
      }

      const rawLyrics = best.plainLyrics || stripLrcTimestamps(best.syncedLyrics);
      const lyrics = rawLyrics.slice(0, 3000); // WhatsApp message limit
      const hasMore = rawLyrics.length > 3000;

      msg.reply(
        `🎵 *${best.trackName}*\n👤 ${best.artistName}\n\n${lyrics}${hasMore ? '\n\n... (truncated)' : ''}`
      );
    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        msg.reply('❌ Lyrics search timed out (slow connection). Try again.');
      } else {
        console.error('[lyrics] request failed:', err.response?.data || err.message);
        msg.reply('❌ Lyrics search failed.');
      }
    }
  },
};
