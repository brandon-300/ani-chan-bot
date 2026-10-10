const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { mentionTag, safeGetQuotedMessage, safeGetContact } = require('../utils/helpers');

const TMP = os.tmpdir();

function tmpFile(ext) {
  return path.join(TMP, `ani-chan_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

function runFfmpeg(inputPath, outputPath, outputOptions = []) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function cleanup(...files) {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

// nekos.best requires an application name and contact URL, not a browser UA.
// https://docs.nekos.best/getting-started/api-reference.html#user-agent
const API_HEADERS = {
  'User-Agent': 'AniChan (https://github.com/brandon-300/ani-chan-bot)',
  Accept: 'application/json',
};

// Shared error-detail formatter: prefers the real HTTP status + response
// body over axios's generic error code (axios sets err.code to the same
// "ERR_BAD_REQUEST" string for ANY 4xx, which tells you nothing useful).
function describeAxiosError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  return status
    ? `HTTP ${status}${body ? ' — ' + JSON.stringify(body).slice(0, 300) : ''}`
    : (err.code || err.message);
}

// One retry on network-level failures (DNS lookup, connection refused/
// reset, timeout — anything with no HTTP response at all) since that's
// exactly the kind of thing that self-heals on an unstable mobile
// connection. An actual HTTP error response (4xx/5xx) won't change on
// retry, so those fail immediately without wasting a second round trip.
function isRetryableNetworkError(err) {
  return !err.response;
}

// ─── nekos.best — primary anime GIF source ─────────────────────────────────
// Set an explicit timeout because axios otherwise waits indefinitely. The
// API-specific application User-Agent above is required; a browser UA may be
// rejected. If this endpoint is unavailable, getGif() can use the fallback
// source below for reactions that it supports.
async function getGifFromNekosBest(endpoint) {
  try {
    const res = await axios.get(`https://nekos.best/api/v2/${endpoint}`, {
      timeout: 15000,
      headers: API_HEADERS,
    });
    const url = res.data?.results?.[0]?.url;
    if (!url) {
      console.error(`nekos.best(${endpoint}): unexpected response shape:`, JSON.stringify(res.data)?.slice(0, 300));
      return null;
    }
    return url;
  } catch (err) {
    console.error(`nekos.best(${endpoint}) failed: ${describeAxiosError(err)}`);
    return null;
  }
}

// ─── otakugifs.xyz — fallback anime GIF source ─────────────────────────────
// Used only when nekos.best fails AND a matching reaction exists here.
// No API key required. Confirmed live via direct curl test (Aug 2026) —
// its full reaction list was pulled straight from its own /gif/allreactions
// endpoint rather than third-party docs, after a previous fallback choice
// (waifu.pics) turned out to be a dead domain (NXDOMAIN). Covers common
// social reactions but not Nekos.best's `shoot`/`carry`; .kill and .kidnap
// therefore use bundled local GIF fallbacks if Nekos.best is unavailable.
async function getGifFromOtakuGifs(reaction, attempt = 1) {
  try {
    const res = await axios.get('https://api.otakugifs.xyz/gif', {
      params: { reaction, format: 'gif' },
      timeout: 15000,
      headers: API_HEADERS,
    });
    const url = res.data?.url;
    if (!url) {
      console.error(`otakugifs.xyz(${reaction}): unexpected response shape:`, JSON.stringify(res.data)?.slice(0, 300));
      return null;
    }
    return url;
  } catch (err) {
    if (attempt === 1 && isRetryableNetworkError(err)) {
      console.error(`otakugifs.xyz(${reaction}) attempt 1 failed (${err.code || err.message}), retrying once...`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return getGifFromOtakuGifs(reaction, 2);
    }
    console.error(`otakugifs.xyz(${reaction}) failed: ${describeAxiosError(err)}`);
    return null;
  }
}

// Try nekos.best first, then OtakuGIFS when supported. Returns null if
// providers fail. GIF commands never use bundled/local media.
async function getGif(nekosEndpoint, otakuReaction) {
  const primary = nekosEndpoint ? await getGifFromNekosBest(nekosEndpoint) : null;
  if (primary) return primary;
  if (otakuReaction) return await getGifFromOtakuGifs(otakuReaction);
  return null;
}

// Fetch and convert a remote GIF, then send it using WhatsApp's looping-GIF
// mode. On API/download/conversion failure, send the same caption as text;
// never use local media.
async function sendGif(msg, nekosEndpoint, otakuReaction, text, mentions = []) {
  const url = await getGif(nekosEndpoint, otakuReaction);
  const textFallback = () => msg.reply(`No GIFs found.\n${text}`, undefined, { mentions });
  if (!url) return textFallback();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const inputPath = tmpFile('gif');
    const outputPath = tmpFile('mp4');
    try {
      const gifMedia = await MessageMedia.fromUrl(url);
      fs.writeFileSync(inputPath, Buffer.from(gifMedia.data, 'base64'));
      await runFfmpeg(inputPath, outputPath, [
        '-movflags', 'faststart',
        '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ]);
      const videoData = fs.readFileSync(outputPath).toString('base64');
      const media = new MessageMedia('video/mp4', videoData);
      return await msg.reply(media, undefined, { sendVideoAsGif: true, caption: text, mentions });
    } catch (err) {
      console.error(`sendGif(${nekosEndpoint}) attempt ${attempt} failed: ${err.message}`);
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 800));
    } finally {
      cleanup(inputPath, outputPath);
    }
  }
  return textFallback();
}

// Targets come only from the author of a quoted message. Mentions in the
// command text are ignored. Replies to the sender's own message are rejected.
async function resolveTarget(msg, senderContact) {
  if (!msg.hasQuotedMsg) return null;
  try {
    const quoted = await safeGetQuotedMessage(msg);
    if (!quoted) return null;
    const target = await safeGetContact(quoted);
    const senderId = senderContact?.id?._serialized;
    const targetId = target?.id?._serialized;
    if (!senderId || !targetId || senderId === targetId) return null;
    return target;
  } catch (err) {
    console.error('resolveTarget: quoted message/contact fetch failed:', err.message);
    return null;
  }
}

// Every action requires a different quoted author and mentions both users.
async function buildAction(msg, { pair }) {
  let sender;
  try {
    sender = await msg.getContact();
  } catch (err) {
    console.error('buildAction: sender contact fetch failed:', err.message);
    return null;
  }
  if (!sender?.id?._serialized) return null;
  const target = await resolveTarget(msg, sender);
  if (!target?.id?._serialized) return null;
  return {
    text: pair(mentionTag(sender), mentionTag(target)),
    mentions: [sender.id._serialized, target.id._serialized],
  };
}

module.exports = {
  // ─── Reply-only GIF actions ─────────────────────────────────────────
  // Every handler is reply-only and sends an animated media result.
  async hug(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} hugs @${t}` });
    if (!built) return null;
    await sendGif(msg, 'hug', 'hug', built.text, built.mentions);
  },

  async kiss(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} kisses @${t}` });
    if (!built) return null;
    await sendGif(msg, 'kiss', 'kiss', built.text, built.mentions);
  },

  async slap(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} slaps @${t}` });
    if (!built) return null;
    await sendGif(msg, 'slap', 'slap', built.text, built.mentions);
  },

  async wave(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} waves at @${t}` });
    if (!built) return null;
    await sendGif(msg, 'wave', 'wave', built.text, built.mentions);
  },

  async pat(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} pats @${t}` });
    if (!built) return null;
    await sendGif(msg, 'pat', 'pat', built.text, built.mentions);
  },

  async lick(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} licks @${t}` });
    if (!built) return null;
    await sendGif(msg, 'lick', 'lick', built.text, built.mentions);
  },

  async punch(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} punches @${t}` });
    if (!built) return null;
    await sendGif(msg, 'punch', 'punch', built.text, built.mentions);
  },

  async kill(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} kills @${t}` });
    if (!built) return null;
    await sendGif(msg, 'shoot', null, built.text, built.mentions);
  },

  async bonk(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} bonks @${t}` });
    if (!built) return null;
    await sendGif(msg, 'slap', 'slap', built.text, built.mentions);
  },

  // API-only: use nekos.best's closest available death reaction.
  async die(client, msg, args) {
    const built = await buildAction(msg, {
      pair: (sender, target) => `💀 @${sender} sent @${target} flying to their dramatic end.`,
    });
    if (!built) return null;
    return sendGif(msg, 'shoot', null, built.text, built.mentions);
  },

  async tickle(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} tickles @${t}` });
    if (!built) return null;
    await sendGif(msg, 'tickle', 'tickle', built.text, built.mentions);
  },

  // API-only: nekos.best's `baka` is the closest available insult reaction.
  async fuck(client, msg, args) {
    const built = await buildAction(msg, {
      pair: (sender, target) => `😤 @${sender} flipped off @${target}.`,
    });
    if (!built) return null;
    return sendGif(msg, 'baka', null, built.text, built.mentions);
  },

  // API-only: use nekos.best's closest available carry reaction.
  async kidnap(client, msg, args) {
    const built = await buildAction(msg, {
      pair: (sender, target) => `🚨 @${sender} kidnapped @${target}! 🚓 Police on the way!`,
    });
    if (!built) return null;
    await sendGif(msg, 'carry', null, built.text, built.mentions);
  },

  // These actions also require replying to another user's message.
  async dance(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} dances for @${t}!` });
    if (!built) return null;
    await sendGif(msg, 'dance', 'dance', built.text, built.mentions);
  },

  async sad(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} feels sad for @${t}...` });
    if (!built) return null;
    await sendGif(msg, 'cry', 'cry', built.text, built.mentions);
  },

  async smile(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} smiles at @${t}!` });
    if (!built) return null;
    await sendGif(msg, 'smile', 'smile', built.text, built.mentions);
  },

  async laugh(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} is laughing at @${t}` });
    if (!built) return null;
    await sendGif(msg, 'laugh', 'laugh', built.text, built.mentions);
  },

  async angry(client, msg, args) {
    const built = await buildAction(msg, { pair: (s, t) => `@${s} is angry at @${t}` });
    if (!built) return null;
    // nekos.best has no reliable angry endpoint; OtakuGIFS `mad` is the
    // closest available API reaction.
    await sendGif(msg, null, 'mad', built.text, built.mentions);
  },

};
