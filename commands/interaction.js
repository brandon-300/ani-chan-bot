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
// (waifu.pics) turned out to be a dead domain (NXDOMAIN). Covers
// hug/kiss/slap/wave/pat/dance/cry/smile/laugh/lick/punch/tickle — only
// "kill" has no equivalent (this API's list is all wholesome/social
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

// ─── Target resolution for two-party actions ───────────────────────────────
// Accepts a target two ways, matching the reference "Miyabi" bot:
//   1. An explicit @mention in the command message.
//   2. Replying to someone's earlier message (the quoted message's sender
//      becomes the target) — uses the same safeGetQuotedMessage/
//      safeGetContact retry helpers already used elsewhere in the codebase
//      for transient WhatsApp-internal glitches.
// Returns null if neither is present. Deliberately does NOT fall back to
// "everyone" — that was the bug: buildInteraction() used to silently tag
// nobody as a real target and just print the word "everyone" as inert
// text, which reads as if the command mass-mentioned the group.
async function resolveTarget(msg) {
  const mentioned = await msg.getMentions();
  if (mentioned[0]) return mentioned[0];

  if (msg.hasQuotedMsg) {
    try {
      const quoted = await safeGetQuotedMessage(msg);
      if (quoted) return await safeGetContact(quoted);
    } catch (err) {
      console.error('resolveTarget: quoted message/contact fetch failed:', err.message);
      // Fall through to "no target" — a transient fetch failure here
      // shouldn't crash the command, just means we ask the user to
      // mention/reply again.
    }
  }
  return null;
}

// ─── Unified action builder — every command in this file goes through ─────
// this ONE function now. Previously there were 3 separate, inconsistent
// implementations: buildInteraction() (two-party, required target),
// buildSelf() (solo, target support entirely missing — this was the bug:
// ".laugh @Anos" silently dropped the mention and replied as if solo),
// and four commands (jihad/crusade/shrug/wank) that skipped target
// resolution altogether with their own inline msg.reply() calls. All of
// them now use resolveTarget() — the exact same mention-or-reply rule
// .hug already used — so target detection behaves identically everywhere.
//
// `solo` and `pair` are functions that take mention tag(s) and return the
// full message text, so each command keeps its own emoji/flavor text
// exactly as before. `requireTarget: true` reproduces the old
// buildInteraction/buildFuck/buildKidnap behavior (hug, kiss, fuck, etc.
// still refuse to run with no target — returns null so the caller sends
// NO_TARGET_MSG). `requireTarget: false` (the default) reproduces the old
// buildSelf behavior when no target is given, but — unlike buildSelf —
// now actually honors a target when one is provided.
async function buildAction(msg, { solo, pair, requireTarget = false }) {
  const contact = await msg.getContact();
  const target = await resolveTarget(msg);
  const senderTag = mentionTag(contact);

  if (!target) {
    if (requireTarget) return null;
    return {
      text: solo(senderTag),
      mentions: [contact.id._serialized],
    };
  }

  return {
    text: pair(senderTag, mentionTag(target)),
    mentions: [contact.id._serialized, target.id._serialized],
  };
}

const NO_TARGET_MSG = 'Please mention or reply to a user to use this command.';

module.exports = {
  // ─── Required-target actions ─────────────────────────────────────────
  // Unchanged behavior: no mention/reply => NO_TARGET_MSG, exact same
  // wording as before.
  async hug(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} hugs @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'hug', 'hug', built.text, built.mentions);
  },

  async kiss(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} kisses @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'kiss', 'kiss', built.text, built.mentions);
  },

  async slap(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} slaps @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'slap', 'slap', built.text, built.mentions);
  },

  async wave(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} waves at @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'wave', 'wave', built.text, built.mentions);
  },

  async pat(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} pats @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'pat', 'pat', built.text, built.mentions);
  },

  async lick(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} licks @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'lick', 'lick', built.text, built.mentions);
  },

  async punch(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} punches @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'punch', 'punch', built.text, built.mentions);
  },

  async kill(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} kills @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    // No otakugifs.xyz equivalent — nekos.best only. Falls back to text if
    // nekos.best is unreachable.
    await sendGif(msg, 'shoot', null, built.text, built.mentions);
  },

  async bonk(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} bonks @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'slap', 'slap', built.text, built.mentions);
  },

  async tickle(client, msg, args) {
    const built = await buildAction(msg, { requireTarget: true, pair: (s, t) => `@${s} tickles @${t}` });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'tickle', 'tickle', built.text, built.mentions);
  },

  // GIF via nekos.best "baka" — no otakugifs.xyz equivalent exists, so
  // this is nekos.best-only, same as .kill above. On a connection where
  // nekos.best is Cloudflare-blocked, this will reliably fall back to the
  // text-only reply inside sendGif() until nekos.best is reachable again.
  async fuck(client, msg, args) {
    const built = await buildAction(msg, {
      requireTarget: true,
      pair: (s, t) => `😤 @${s} said a bad word at @${t}!`,
    });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'baka', null, built.text, built.mentions);
  },

  // GIF via nekos.best "carry" — same nekos.best-only situation as .fuck
  // and .kill: no otakugifs.xyz equivalent, so this falls back to text
  // whenever nekos.best is unreachable.
  async kidnap(client, msg, args) {
    const built = await buildAction(msg, {
      requireTarget: true,
      pair: (s, t) => `🚨 @${s} kidnapped @${t}! 🚓 Police on the way!`,
    });
    if (!built) return msg.reply(NO_TARGET_MSG);
    await sendGif(msg, 'carry', null, built.text, built.mentions);
  },

  // ─── Optional-target actions ─────────────────────────────────────────
  // BUGFIX: these used to call buildSelf(), which never looked at any
  // @mention or reply at all — that's why ".laugh @Anos" replied
  // "@Brandon is laughing!" instead of directing it at Anos. They now go
  // through the same resolveTarget() rule .hug uses: no target => solo
  // text (identical to before), a target => directed text.
  async dance(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `@${s} is dancing!`,
      pair: (s, t) => `@${s} dances with @${t}!`,
    });
    await sendGif(msg, 'dance', 'dance', text, mentions);
  },

  async sad(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `@${s} is feeling sad...`,
      pair: (s, t) => `@${s} is feeling sad because of @${t}...`,
    });
    await sendGif(msg, 'cry', 'cry', text, mentions);
  },

  async smile(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `@${s} is smiling!`,
      pair: (s, t) => `@${s} smiles at @${t}!`,
    });
    await sendGif(msg, 'smile', 'smile', text, mentions);
  },

  async laugh(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `@${s} is laughing!`,
      pair: (s, t) => `@${s} laughs at @${t}!`,
    });
    await sendGif(msg, 'laugh', 'laugh', text, mentions);
  },

  async jihad(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `☪️ @${s} declared a holy war on the chat! 💣`,
      pair: (s, t) => `☪️ @${s} declared a holy war on @${t}! 💣`,
    });
    msg.reply(text, undefined, { mentions });
  },

  async crusade(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `✝️ @${s} called for a crusade! ⚔️ Deus Vult!`,
      pair: (s, t) => `✝️ @${s} called for a crusade against @${t}! ⚔️ Deus Vult!`,
    });
    msg.reply(text, undefined, { mentions });
  },

  async shrug(client, msg, args) {
    const { text, mentions } = await buildAction(msg, {
      solo: (s) => `🤷 @${s}: ¯\\_(ツ)_/¯`,
      pair: (s, t) => `🤷 @${s} shrugs at @${t}: ¯\\_(ツ)_/¯`,
    });
    msg.reply(text, undefined, { mentions });
  },

  // Left as self-only, intentionally NOT wired into buildAction's
  // optional-target pattern — directing this specific joke's implication
  // at another named person doesn't work the way the others do, so it
  // keeps its original solo-only text unchanged.
  async wank(client, msg, args) {
    const contact = await msg.getContact();
    msg.reply(
      `😏 @${mentionTag(contact)} is... busy. Please do not disturb.`,
      undefined,
      { mentions: [contact.id._serialized] }
    );
  },
};
