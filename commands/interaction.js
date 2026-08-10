const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, mentionTag } = require('../utils/helpers');

// ─── nekos.best API — free anime GIFs ─────────────────────────────────────────
// Every endpoint used in this file (hug, kiss, slap, wave, pat, dance, cry,
// smile, laugh, lick, punch, shoot, tickle) is one of nekos.best's actual
// anime-reaction categories — the GIFs themselves were never the bug here.
//
// A 15s timeout is set explicitly (axios has no timeout by default) so a
// stalled request on unstable mobile data fails fast and loud instead of
// hanging the whole command indefinitely.
//
// BUGFIX (Aug 2026): this used to be a bare `catch { return null; }` with
// zero logging — so ANY failure (network blip, timeout, nekos.best being
// briefly down, a bad response shape) silently fell through to the
// text-only fallback in sendGif() below with no trace of why in pm2 logs.
// That's almost certainly what happened on .hug returning text-only: some
// real error was thrown and swallowed without a trace. Now logged so the
// *next* occurrence shows the actual cause instead of just "no GIF".
async function getGif(endpoint) {
  try {
    const res = await axios.get(`https://nekos.best/api/v2/${endpoint}`, { timeout: 15000 });
    const url = res.data?.results?.[0]?.url;
    if (!url) {
      console.error(`getGif(${endpoint}): unexpected response shape:`, JSON.stringify(res.data)?.slice(0, 300));
      return null;
    }
    return url;
  } catch (err) {
    const detail = err.code || err.response?.status || err.message;
    console.error(`getGif(${endpoint}) failed: ${detail}`);
    return null;
  }
}

// Sends the reaction GIF with the given caption, passing WhatsApp's
// `mentions` array through so any @tags in the caption actually render as
// tappable mentions. WhatsApp only does this when the exact digits in the
// TEXT also appear in this array (see mentionTag() in utils/helpers.js,
// and the same pattern already used throughout admin.js/cards.js/
// guilds.js) — text alone, no matter how it's formatted, just shows as a
// literal "@1234567890" instead of a real tag.
//
// BUGFIX (Aug 2026): this function used to take just (msg, endpoint, text)
// with no mentions parameter at all, so no interaction command's @tag ever
// actually worked, on either the sender or target side. Falls back to a
// plain text reply (still with the same mentions) if the GIF fetch/send
// fails for any reason, so a flaky nekos.best request never makes the
// command look like it silently did nothing — and now logs exactly which
// step failed (fromUrl vs sendMessage) instead of silently swallowing it.
async function sendGif(msg, endpoint, text, mentions = []) {
  const url = await getGif(endpoint);
  if (url) {
    try {
      const media = await MessageMedia.fromUrl(url);
      const chat = await safeGetChat(msg);
      if (!chat) return;
      await chat.sendMessage(media, { caption: text, mentions });
      return;
    } catch (err) {
      console.error(`sendGif(${endpoint}) failed to send media from ${url}:`, err.message);
    }
  }
  // Fallback: text only, same mentions so the tag still works.
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
    await sendGif(msg, 'hug', text, mentions);
  },

  async kiss(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'kisses');
    await sendGif(msg, 'kiss', text, mentions);
  },

  async slap(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'slaps');
    await sendGif(msg, 'slap', text, mentions);
  },

  async wave(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'waves at');
    await sendGif(msg, 'wave', text, mentions);
  },

  async pat(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'pats');
    await sendGif(msg, 'pat', text, mentions);
  },

  async dance(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is dancing!');
    await sendGif(msg, 'dance', text, mentions);
  },

  async sad(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is feeling sad...');
    await sendGif(msg, 'cry', text, mentions);
  },

  async smile(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is smiling!');
    await sendGif(msg, 'smile', text, mentions);
  },

  async laugh(client, msg, args) {
    const { text, mentions } = await buildSelf(msg, 'is laughing!');
    await sendGif(msg, 'laugh', text, mentions);
  },

  async lick(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'licks');
    await sendGif(msg, 'lick', text, mentions);
  },

  async punch(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'punches');
    await sendGif(msg, 'punch', text, mentions);
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
    await sendGif(msg, 'shoot', text, mentions);
  },

  async bonk(client, msg, args) {
    const { text, mentions } = await buildInteraction(msg, 'bonks');
    await sendGif(msg, 'slap', text, mentions);
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
    await sendGif(msg, 'tickle', text, mentions);
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
