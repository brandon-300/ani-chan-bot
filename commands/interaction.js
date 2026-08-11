const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { mentionTag } = require('../utils/helpers');

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

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json',
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
// A 15s timeout is set explicitly since axios has no timeout by default,
// and a realistic browser User-Agent is sent since APIs commonly reject
// axios's default UA string outright.
//
// KNOWN ISSUE (Aug 2026): confirmed via pm2 logs that nekos.best returns
// Cloudflare's interactive "Just a moment..." challenge page (HTTP 403) for
// at least one user's connection. That's a JS/browser challenge, not a
// header check — no amount of request tweaking from Node/axios can pass
// it. getGifFromOtakuGifs() below is the fallback for exactly this
// situation, confirmed working via direct curl test on the affected device.
async function getGifFromNekosBest(endpoint) {
  try {
    const res = await axios.get(`https://nekos.best/api/v2/${endpoint}`, {
      timeout: 15000,
      headers: BROWSER_HEADERS,
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
// (waifu.pics) turned out to be a dead domain (NXDOMAIN even via 8.8.8.8).
// Covers hug/kiss/slap/wave/pat/dance/cry/smile/laugh/lick/punch/tickle —
// only "kill" has no equivalent (this API's list is all wholesome/social
// reactions, no violence-themed categories), so .kill stays nekos.best-only.
async function getGifFromOtakuGifs(reaction, attempt = 1) {
  try {
    const res = await axios.get('https://api.otakugifs.xyz/gif', {
      params: { reaction, format: 'gif' },
      timeout: 15000,
      headers: BROWSER_HEADERS,
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

// Tries nekos.best first, falls back to otakugifs.xyz (when a matching
// reaction is given) if that fails for any reason. Returns null — never
// throws — so sendGif() below always has a text-only path if both sources
// are down.
async function getGif(nekosEndpoint, otakuReaction) {
  const primary = await getGifFromNekosBest(nekosEndpoint);
  if (primary) return primary;
  if (otakuReaction) return await getGifFromOtakuGifs(otakuReaction);
  return null;
}

// Sends the reaction GIF with the given caption, passing WhatsApp's
// `mentions` array through so any @tags in the caption actually render as
// tappable mentions. WhatsApp only does this when the exact digits in the
// TEXT also appear in this array (see mentionTag() in utils/helpers.js,
// and the same pattern already used throughout admin.js/cards.js/
// guilds.js) — text alone, no matter how it's formatted, just shows as a
// literal "@1234567890" instead of a real tag.
//
// Falls back to a plain text reply (still with the same mentions) if the
// GIF pipeline fails entirely, so a flaky/blocked connection never makes
// the command look like it silently did nothing — and logs exactly which
// step failed instead of swallowing it.
//
// BUGFIX (Aug 2026, round 1): this used to send the raw .gif straight
// through as an "image" message with no video flag. WhatsApp only plays a
// genuine looping "GIF" when the media is an MP4 sent with sendVideoAsGif —
// a raw .gif sent as a plain image gets flattened to its first frame. Now
// converts to MP4 with the same ffmpeg recipe already proven working in
// .tovid (converter.js).
//
// BUGFIX (Aug 2026, round 2): the first version of the round-1 fix
// downloaded the GIF bytes with a manual axios arraybuffer request, which
// failed with "stream has been aborted" on this connection.
// MessageMedia.fromUrl() is the one download method already confirmed
// reliable here — it's what worked when this command sent a static image,
// before the animation fix — so there's no reason to use a second, less-
// proven download path for the exact same file. The whole
// fetch→convert→send pipeline also now retries once, since any single step
// can still fail transiently on an unstable connection.
//
// BUGFIX (Aug 2026, round 2): also switched from chat.sendMessage() to
// msg.reply() for BOTH the GIF and text-fallback paths — sendMessage()
// sends a fresh, unquoted message, which is why replies weren't showing up
// as a quoted bubble under the triggering command.
async function sendGif(msg, nekosEndpoint, otakuReaction, text, mentions = []) {
  const url = await getGif(nekosEndpoint, otakuReaction);
  if (url) {
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
        await msg.reply(media, undefined, { sendVideoAsGif: true, caption: text, mentions });
        return;
      } catch (err) {
        console.error(`sendGif(${nekosEndpoint}) attempt ${attempt} failed: ${err.message}`);
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      } finally {
        cleanup(inputPath, outputPath);
      }
    }
  }
  // Fallback: text only, same mentions so the tag still works — also a
  // reply (quoted), not a fresh chat.sendMessage.
  msg.reply(text, undefined, { mentions });
}

// ─── Two-party actions (hug, kiss, slap, etc.) ─────────────────────────────
// Builds "@sender <action> @target" — a REAL tappable mention on both
// sides, not the sender's plain pushname and not inert "@number" text —
// plus the matching `mentions` array to hand to sendGif/msg.reply. Falls
// back to "everyone" (plain text, nothing to tag) when nobody was
// @-mentioned, same as before.
async function buildInteraction(msg, action) {
  const contact = await msg.getContact();
  const mentioned = await msg.getMentions();
  const target = mentioned[0];

  const mentions = [contact.id._serialized];
  let targetText = 'everyone';
  if (target) {
    targetText = `@${mentionTag(target)}`;
    mentions.push(target.id._serialized);
  }

  return {
    text: `@${mentionTag(contact)} ${action} ${targetText}`,
    mentions,
  };
}

// ─── Solo actions (dance, sad, smile, laugh) ───────────────────────────────
// Same real-tappable-mention treatment for the sender, just no second party.
async function buildSelf(msg, action) {
  const contact = await msg.getContact();
  return {
    text: `@${mentionTag(contact)} ${action}`,
    mentions: [contact.id._serialized],
  };
}

module.exports = {
  async hug(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'hugs');
    await sendGif(msg, 'hug', 'hug', text, mentions);
  },

  async kiss(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'kisses');
    await sendGif(msg, 'kiss', 'kiss', text, mentions);
  },

  async slap(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'slaps');
    await sendGif(msg, 'slap', 'slap', text, mentions);
  },

  async wave(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'waves at');
    await sendGif(msg, 'wave', 'wave', text, mentions);
  },

  async pat(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'pats');
    await sendGif(msg, 'pat', 'pat', text, mentions);
  },

  async dance(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is dancing!');
    await sendGif(msg, 'dance', 'dance', text, mentions);
  },

  async sad(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is feeling sad...');
    await sendGif(msg, 'cry', 'cry', text, mentions);
  },

  async smile(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is smiling!');
    await sendGif(msg, 'smile', 'smile', text, mentions);
  },

  async laugh(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is laughing!');
    await sendGif(msg, 'laugh', 'laugh', text, mentions);
  },

  async lick(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'licks');
    await sendGif(msg, 'lick', 'lick', text, mentions);
  },

  async punch(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'punches');
    await sendGif(msg, 'punch', 'punch', text, mentions);
  },

  async jihad(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(
      `☪️ @${mentionTag(contact)} declared a holy war on the chat! 💣 (meme command)`,
      undefined,
      { mentions: [contact.id._serialized] }
    );
  },

  async crusade(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(
      `✝️ @${mentionTag(contact)} called for a crusade! ⚔️ Deus Vult! (meme command)`,
      undefined,
      { mentions: [contact.id._serialized] }
    );
  },

  async kill(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'kills');
    // No otakugifs.xyz equivalent — nekos.best only. Falls back to text if
    // nekos.best is unreachable.
    await sendGif(msg, 'shoot', null, text, mentions);
  },

  async bonk(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'bonks');
    await sendGif(msg, 'slap', 'slap', text, mentions);
  },

  // intentionally left as text — family-friendly bot
  async fuck(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned[0];

    const mentions = [contact.id._serialized];
    let targetText = 'the void';
    if (target) {
      targetText = `@${mentionTag(target)}`;
      mentions.push(target.id._serialized);
    }

    msg.reply(
      `😤 @${mentionTag(contact)} said a bad word at ${targetText}! (meme command)`,
      undefined,
      { mentions }
    );
  },

  async tickle(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'tickles');
    await sendGif(msg, 'tickle', 'tickle', text, mentions);
  },

  async shrug(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(
      `🤷 @${mentionTag(contact)}: ¯\\_(ツ)_/¯`,
      undefined,
      { mentions: [contact.id._serialized] }
    );
  },

  async wank(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(
      `😏 @${mentionTag(contact)} is... busy. Please do not disturb. (meme command)`,
      undefined,
      { mentions: [contact.id._serialized] }
    );
  },

  async kidnap(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned[0];

    const mentions = [contact.id._serialized];
    let targetText = 'someone';
    if (target) {
      targetText = `@${mentionTag(target)}`;
      mentions.push(target.id._serialized);
    }

    msg.reply(
      `🚨 @${mentionTag(contact)} tried to kidnap ${targetText}! 🚓 Police on the way! (meme command)`,
      undefined,
      { mentions }
    );
  },
};
