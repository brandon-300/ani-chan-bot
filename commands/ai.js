const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, safeGetQuotedMessage, resolveSenderName } = require('../utils/helpers');
const { BOT_NAME } = require('../utils/config');
const { getActivePersonaSafe } = require('../utils/persona');
const aiStickers = require('../utils/aiStickers');
const gemini = require('../utils/gemini');
const fishAudio = require('../utils/fishAudio');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// ─── Small tmp-file / ffmpeg helpers ────────────────────────────────────────
// Same pattern as commands/converter.js (tmpFile/runFfmpeg/cleanup) — kept as
// a local, tiny copy here rather than importing from converter.js, since
// converter.js doesn't currently export them and this is the only other
// file in the project that needs ffmpeg-based conversion.
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

// ─── Conversation memory (per chat AND per sender, clears after 30 min idle) ──
// Persisted in Mongo (models/AiConversation.js) with a native TTL index
// doing the 30-minute idle cleanup — see that file's comment for why this
// replaced the old in-memory Map (it didn't survive PM2 restarts, and its
// per-call setTimeout cleanup had a real bug: an earlier timer could wipe
// out a chat's newer history mid-conversation).
const AiConversation = require('../models/AiConversation');

const HISTORY_LIMIT = 20; // messages kept per conversation
const HISTORY_TTL_MS = 30 * 60 * 1000; // idle window before Mongo auto-expires it

// Returns this (chat, sender) pair's recent conversation as a plain
// { role, content }[] array for gemini.js — empty for a fresh conversation,
// or one Mongo's TTL index already expired. Reading never touches
// expiresAt itself — only addTurnToHistory extends the idle window, so a
// history can't be kept alive just by being read.
//
// senderId matters here: in a DM, chatId alone is already unique per
// person, but in a GROUP chatId is the same for every member — without
// senderId, everyone in a group would read and write the SAME
// conversation, which is exactly the "only one conversation, shared by
// whoever uses the AI commands" behavior this replaces. Pass msg.author in
// a group (the actual sender) and msg.from in a DM (there is no
// msg.author there) — see the call sites below.
async function getHistory(chatId, senderId) {
  const convo = await AiConversation.findOne({ chatId, senderId }).catch(err => {
    console.error('getHistory: lookup failed:', err.message);
    return null;
  });
  return convo ? convo.messages.map(m => ({ role: m.role, content: m.content })) : [];
}

// Appends BOTH sides of one exchange — the user's message and the
// assistant's reply — in a single $push, so they land in Mongo as one
// atomic write instead of the two independent, unawaited writes this used
// to be. That distinction matters two ways: a process crash between the
// old pair of writes could leave a user message permanently stored with no
// reply ever recorded next to it, and two overlapping requests for the
// SAME conversation could have their four separate writes land in the
// wrong order relative to each other. One $push means both messages of a
// given exchange succeed together or neither does, and nothing else can
// land in between them.
async function addTurnToHistory(chatId, senderId, userContent, assistantContent) {
  await AiConversation.findOneAndUpdate(
    { chatId, senderId },
    {
      $push: {
        messages: {
          $each: [
            { role: 'user', content: userContent },
            { role: 'assistant', content: assistantContent },
          ],
          $slice: -HISTORY_LIMIT,
        },
      },
      $set: { expiresAt: new Date(Date.now() + HISTORY_TTL_MS) },
    },
    { upsert: true }
  ).catch(err => console.error('addTurnToHistory: save failed:', err.message));
}

// ─── Persona prompts and internal text controls ─────────────────────────────
// Persona identity and medium-specific behavior live in config/personas/<id>.
// Voice prompts deliberately omit the text-only reaction/menu controls.
function buildPersonaSystemPrompt(senderName, medium, allowBotActions = false) {
  const persona = getActivePersonaSafe();
  if (!persona) {
    const err = new Error('The active AI persona could not be loaded. Check AI_PERSONA and its config/personas/<id> files.');
    err.code = 'AI_PERSONA_UNAVAILABLE';
    throw err;
  }
  const mediumPrompt = medium === 'voice' ? persona.voicePrompt : persona.text;
  let behavior = mediumPrompt;
  if (medium !== 'voice') {
    const marker = '\nPrivate-DM menu action:\n';
    const splitAt = behavior.indexOf(marker);
    if (splitAt >= 0 && !allowBotActions) behavior = behavior.slice(0, splitAt);
  }
  const identity = `You are ${persona.displayName}${persona.series ? ` from "${persona.series}"` : ''}, acting as ${BOT_NAME}'s AI assistant on WhatsApp. Be this character naturally; never sound like generic customer support. Never use emojis or emoticons in any reply because text may be converted to speech.`;
  let prompt = `${identity}\n\n${persona.personality}\n\n${behavior}`;
  if (senderName) {
    prompt += `\n\nThe person's name is "${senderName}". Address them by that name as written; do not automatically append -kun or another honorific.`;
  }
  return prompt;
}

// Emoji are omitted from both visible persona replies and speech inputs because
// Fish Audio may pronounce emoji names literally. Cover pictographs, flags,
// keycaps, modifiers, variation selectors, and joiners.
const EMOJI_SEQUENCE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;

function stripEmojis(text) {
  return String(text || '')
    .replace(EMOJI_SEQUENCE, '')
    .replace(/[ \t]+([,.;!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

// Gemini is instructed (config/personas/*/text.txt) to emit [[reaction:label]]
// and [[bot_action:command_menu]], but models don't always follow the exact
// shape — e.g. a bare [[excited]] instead of [[reaction:excited]], or a token
// left unterminated at the very end of a truncated response. This parser:
//   - accepts both [[reaction:label]] and bare [[label]] when label is a
//     known reaction (aiStickers.ALLOWED_REACTIONS)
//   - accepts [[bot_action:command_menu]] only where allowed
//   - takes the FIRST valid reaction found anywhere in the text, not just a
//     trailing one
//   - rejects unknown labels (falls back to 'neutral') but still removes them
//   - never lets any [[...]] control syntax reach the visible reply or
//     conversation history, matched or not
function parseAiControls(rawOutput, { allowBotActions = false } = {}) {
  let reaction = 'none';
  let responseMode = 'text';
  let action = null;
  let sawReaction = false;
  const controlToken = /\[\[\s*([a-z_]+)(?:\s*:\s*([^\]\r\n]*))?\s*(?:\]\]|$)/gi;

  let clean = String(rawOutput || '').replace(controlToken, (_token, word, value) => {
    const kindWord = String(word).toLowerCase();
    const label = String(value || '').trim().toLowerCase();
    if (kindWord === 'reaction' && !sawReaction && (label === 'none' || aiStickers.ALLOWED_REACTIONS.has(label))) {
      sawReaction = true;
      reaction = label;
    } else if (kindWord === 'response_mode' && (label === 'text' || label === 'sticker')) {
      responseMode = label;
    } else if (kindWord === 'bot_action' && allowBotActions && action === null && label === 'command_menu') {
      action = 'command_menu';
    } else if (kindWord !== 'reaction' && kindWord !== 'response_mode' && kindWord !== 'bot_action' && !sawReaction && aiStickers.ALLOWED_REACTIONS.has(kindWord)) {
      sawReaction = true;
      reaction = kindWord;
    }
    return '';
  });

  clean = clean.replace(/\[\[[^\]\r\n]*\]\]/g, '').replace(/\[\[[^\r\n]*$/gm, '').trim();
  clean = stripEmojis(clean).trim();
  return { text: clean, reaction, responseMode, action };
}

async function deliverTextResponse(client, msg, rawOutput, allowBotActions = false, { stickerReply = false } = {}) {
  const controls = parseAiControls(rawOutput, { allowBotActions });
  if (controls.action === 'command_menu') {
    if (controls.text) await msg.reply(controls.text);
    if (typeof client.sendQuickMenu === 'function') await client.sendQuickMenu(msg);
    else if (!controls.text) await msg.reply('❌ I could not open the command menu right now.');
    return controls;
  }

  if (stickerReply && controls.responseMode === 'sticker' && controls.reaction !== 'none') {
    const sent = await aiStickers.sendReactionSticker(client, msg, controls.reaction);
    if (!sent) {
      await msg.reply(controls.text || 'I do not have a sticker that fits that reaction.');
    }
    return controls;
  }

  if (controls.text) await msg.reply(controls.text);
  if (controls.text && controls.reaction !== 'none') await aiStickers.sendReactionSticker(client, msg, controls.reaction);
  else if (!controls.text) await msg.reply('❌ I could not generate a text response. Please try again.');
  return controls;
}

// Strips markdown/formatting and emoji before handing text to Fish Audio —
// a guaranteed safety net on top of the voice-specific prompt above, since
// LLMs don't always perfectly follow speech-output instructions.
// Runs regardless of how well the model followed the speech rules, so the
// asterisk bug can't come back even on an occasional prompt slip-up.
function stripSpeechFormatting(text) {
  return text
    // Defense in depth against [[reaction:...]] / [[bot_action:...]] / bare
    // [[label]] control tokens ever reaching Fish Audio and being spoken out
    // loud (e.g. as literally "bracket bracket excited"). In the normal
    // .voice/.copilot flow these are already removed by parseAiControls
    // before this function ever sees the text; this also protects .tts,
    // which can be pointed at arbitrary message text (a reply to any AI
    // reply, including one from before this fix shipped).
    .replace(/\[\[[^\]\r\n]*\]\]/g, '')
    .replace(/\[\[[^\r\n]*$/gm, '')
    .replace(/\*\*?(.*?)\*\*?/g, '$1')     // *bold* / **bold**
    .replace(/_(.*?)_/g, '$1')              // _italic_
    .replace(/~~?(.*?)~~?/g, '$1')          // ~strike~ / ~~strike~~
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1') // `code` / ```code```
    .replace(/^#{1,6}\s+/gm, '')            // # markdown headings
    .replace(/^[-*•]\s+/gm, '')             // bullet list markers
    .replace(/[*_~`#]/g, '')                // any leftover stray symbols
    .replace(EMOJI_SEQUENCE, '')             // pictographs / flags / keycaps
    .replace(/[ \t]+([,.;!?])/g, '$1')       // remove spaces before punctuation
    .replace(/[ \t]{2,}/g, ' ')             // collapse extra whitespace left behind
    .trim();
}

// Turns a gemini.js error into the kind of short, actionable WhatsApp reply
// the old OpenAI-based commands used to give, without swallowing the actual
// reason (missing key, bad model name, safety block, etc.) — important since
// Brandon can't always dig through PM2 logs on unstable data.
function friendlyAiError(err, fallbackLabel) {
  if (err.code === 'AI_PERSONA_UNAVAILABLE') return `❌ ${err.message}`;
  if (err.code === 'NO_GEMINI_KEY') return '❌ GEMINI_API_KEY is missing from .env.';
  if (err.code === 'EMPTY_RESPONSE' || err.code === 'EMPTY_IMAGE') return `❌ ${err.message}`;
  if (err.status === 429) {
    // Google returns 429 both for "you're calling too fast, back off a bit"
    // AND for "your project has zero free quota for this model, enable
    // billing" — same HTTP status, very different fix. The message text is
    // the only way to tell them apart; retrying helps with the first, not
    // the second.
    if (/quota/i.test(err.message)) {
      return `❌ Gemini rejected this: no free quota available (needs billing enabled on your Google AI Studio project). Retrying won't help.\n\n${err.message}`;
    }
    return '❌ Gemini rate limit hit — free tier caps requests per minute/day. Try again shortly.';
  }
  console.error(`${fallbackLabel} error:`, err.message);
  return `❌ ${fallbackLabel} failed: ${err.message}`;
}

// ─── Shared multimodal input resolution for .copilot / .gpt / .voice ───────
// Figures out what the user is actually asking for. Two possible media
// sources, checked in this order:
//   1. The message itself, if IT carries media — covers sending an image
//      directly with a ".copilot ..." caption, AND (new) index.js's
//      auto-reply detection, where the user's own reply to the bot is an
//      image or voice note.
//   2. The quoted message's media, if the current message has none — the
//      classic "reply to an existing image/voice-note with .copilot" usage.
// Resolution:
//  - plain typed args only                       -> { prompt: <args> }
//  - own or quoted image (+ required typed args)  -> { prompt: <args>, image: {...} }
//  - own or quoted voice note (+ optional args)   -> { prompt: <transcript [+ args]> }
//  - neither has usable media                     -> falls back to typed args
//  - an image with NO typed args                  -> { error: '...usage...' }
// Returns { error } OR { prompt, image } (image is null when there isn't one).
async function resolveMultimodalInput(msg, args) {
  const typed = args.join(' ').trim();
  let source = null;
  let quoted = null;
  if (msg.hasMedia) {
    source = msg;
    quoted = await safeGetQuotedMessage(msg).catch(() => null);
  } else {
    quoted = await safeGetQuotedMessage(msg).catch(() => null);
    if (quoted && quoted.hasMedia) source = quoted;
  }

  if (!source) return { prompt: typed, image: null, images: [], stickerReply: false };

  const download = async target => {
    try {
      const media = await target.downloadMedia();
      return media?.data ? media : null;
    } catch { return null; }
  };
  const media = await download(source);
  if (!media) return { error: '❌ Could not download the attached/replied-to media — it may have expired. Try re-sending it and trying again.' };
  const mimetype = media.mimetype || '';

  if (mimetype.includes('image') || msg.type === 'sticker' || source.type === 'sticker') {
    if (!typed && msg.type !== 'sticker') {
      return { error: '❌ Reply to an image AND tell me what to do with it, e.g. *.copilot describe this image*' };
    }
    const images = [{ base64: media.data, mimeType: mimetype || 'image/webp' }];
    const botSentStickerReply = Boolean(quoted?.fromMe && quoted?.type === 'sticker');
    const stickerReply = msg.type === 'sticker' && !!quoted?.fromMe;
    if (stickerReply && quoted?.type === 'sticker' && quoted.hasMedia) {
      const quotedMedia = await download(quoted);
      if (quotedMedia?.data) images.push({ base64: quotedMedia.data, mimeType: quotedMedia.mimetype || 'image/webp' });
    }
    // A text reply to a sticker sent by the bot is conversation about the
    // bot's sticker, not a user-sent sticker. Only a new sticker from the
    // user gets the interpret-this-sticker instruction.
    let prompt = botSentStickerReply
      ? (typed || 'Respond naturally to the user about the reaction sticker you sent.')
      : (typed || 'Interpret this sticker as part of our conversation and respond naturally. Decide whether a text or sticker response fits better.');
    const quotedMessageId = quoted?.id?._serialized || quoted?.id?.id;
    if (botSentStickerReply && quotedMessageId) {
      const sentContext = await aiStickers.getSentStickerContext(quotedMessageId);
      if (sentContext) {
        prompt += `\n\nIMPORTANT: The quoted sticker was sent by you (the bot/persona ${sentContext.personaId}), not by the user. The user did NOT send that sticker. It was your reaction sticker with reaction label ${sentContext.reaction || 'unknown'}. Treat the user's current message as a response to the sticker you sent.`;
      } else {
        prompt += '\n\nIMPORTANT: WhatsApp shows that the quoted sticker was sent by you (the bot), not by the user. The user did NOT send that sticker. Treat the user\'s current message as a response to your reaction sticker.';
      }
    }
    return { prompt, image: images[0], images, stickerReply };
  }

  if (mimetype.includes('audio') || mimetype.includes('ogg')) {
    let transcript;
    try { transcript = await gemini.transcribeAudio({ base64Audio: media.data, mimeType: mimetype }); }
    catch (err) { return { error: friendlyAiError(err, 'Transcription') }; }
    return { prompt: typed ? `${transcript}\n\n(${typed})` : transcript, image: null, images: [], stickerReply: false };
  }
  return { prompt: typed, image: null, images: [], stickerReply: false };
}

module.exports = {
  _parseAiControls: parseAiControls,
  _stripSpeechFormatting: stripSpeechFormatting,
  _buildPersonaSystemPrompt: buildPersonaSystemPrompt,

  // .stickerimport [off] — owner-only, private-DM import mode. Sticker media
  // is intercepted by index.js only after the service independently checks
  // owner identity, direct-chat status, and the active in-memory session.
  async stickerimport(client, msg, args) {
    const action = (args[0] || 'on').toLowerCase();
    if (args.length > 1 || !['on', 'off'].includes(action)) {
      return msg.reply('Usage: .stickerimport [on|off]');
    }
    return action === 'off'
      ? aiStickers.stopImportMode(msg)
      : aiStickers.startImportMode(client, msg);
  },

  // .copilot [prompt] — full context-aware AI chat (Gemini). Also works
  // replying to a voice note (transcribed and used as the prompt) or an
  // image (analyzed with Gemini vision — you must also say what to do
  // with it, e.g. ".copilot what anime is this from").
  async copilot(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;

    const resolved = await resolveMultimodalInput(msg, args);
    if (resolved.error) return msg.reply(resolved.error);
    if (!resolved.prompt) {
      return msg.reply('❌ Usage: .copilot [your message]\nOr reply to a voice note with .copilot, or reply to an image with .copilot [what to do with it]');
    }

    try { await msg.react('⏳'); } catch { /* reactions aren't critical to the reply */ }

    try {
      // msg.author is the actual sender inside a group; it's undefined in a
      // DM, where msg.from IS the sender (and already unique per person)
      // — see models/AiConversation.js's comment for why this matters.
      const senderId = msg.author || msg.from;
      const history = await getHistory(chat.id._serialized, senderId);
      const senderName = await resolveSenderName(msg, client);
      const allowBotActions = !chat.isGroup;
      const systemPrompt = buildPersonaSystemPrompt(senderName, 'text', allowBotActions);

      const rawReply = resolved.images?.length
        ? await gemini.generateVision({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            images: resolved.images,
            maxOutputTokens: 2048,
          })
        : await gemini.generateText({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            maxOutputTokens: 2048,
          });

      const controls = parseAiControls(rawReply, { allowBotActions });
      const historyReply = controls.text || (controls.action === 'command_menu' ? 'I sent the command menu.' : '');
      await addTurnToHistory(chat.id._serialized, senderId, resolved.prompt, historyReply);
      return await deliverTextResponse(client, msg, rawReply, allowBotActions, { stickerReply: resolved.stickerReply });
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Copilot'));
    }
  },

  // .gpt [prompt] — single-turn AI reply (Gemini, no history). Same quoted
  // voice-note/image handling as .copilot, minus conversation memory.
  async gpt(client, msg, args) {
    const resolved = await resolveMultimodalInput(msg, args);
    if (resolved.error) return msg.reply(resolved.error);
    if (!resolved.prompt) {
      return msg.reply('❌ Usage: .gpt [your question]\nOr reply to a voice note with .gpt, or reply to an image with .gpt [what to do with it]');
    }

    await msg.reply('💭 Processing...');
    try {
      const senderName = await resolveSenderName(msg, client);
      const chat = await safeGetChat(msg);
      const allowBotActions = !!chat && !chat.isGroup;
      const systemPrompt = buildPersonaSystemPrompt(senderName, 'text', allowBotActions);

      const reply = resolved.images?.length
        ? await gemini.generateVision({
            systemPrompt,
            prompt: resolved.prompt,
            images: resolved.images,
            maxOutputTokens: 2048,
          })
        : await gemini.generateText({
            systemPrompt,
            prompt: resolved.prompt,
            maxOutputTokens: 2048,
          });

      return await deliverTextResponse(client, msg, reply, allowBotActions);
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'GPT'));
    }
  },

  // .voice [prompt] — like .copilot, but always answers with a spoken
  // voice note instead of text. Works the same three ways .copilot/.gpt
  // do, via the same resolveMultimodalInput() resolver:
  //   - plain typed text:      .voice what's the strongest anime villain
  //   - reply to a voice note: .voice  (transcript becomes the prompt;
  //                             typed args after the command are tacked on
  //                             as an extra instruction, same as .copilot)
  //   - reply to an image:     .voice what anime is this from  (typed
  //                             instruction required, same as .copilot/.gpt)
  // Answers in character using the same per-chat history as .copilot, then
  // speaks the answer back as a WhatsApp voice note (Fish Audio TTS).
  async voice(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;

    const resolved = await resolveMultimodalInput(msg, args);
    if (resolved.error) return msg.reply(resolved.error);
    if (!resolved.prompt) {
      return msg.reply('❌ Usage: .voice [your message]\nOr reply to a voice note with .voice, or reply to an image with .voice [what to do with it]');
    }

    try { await msg.react('⏳'); } catch { /* reactions aren't critical to the reply */ }

    let mp3Path, oggPath;
    try {
      // See .copilot's identical comment above.
      const senderId = msg.author || msg.from;
      const history = await getHistory(chat.id._serialized, senderId);
      const senderName = await resolveSenderName(msg, client);
      const systemPrompt = buildPersonaSystemPrompt(senderName, 'voice', false);

      const rawReply = resolved.images?.length
        ? await gemini.generateVision({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            images: resolved.images,
            maxOutputTokens: 1200,
          })
        : await gemini.generateText({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            maxOutputTokens: 1200,
          });

      // Safety net — see stripSpeechFormatting()'s comment above. Applied
      // before both TTS and history so a stray "*" the model slips in
      // never gets spoken AND never lingers in context for the next turn.
      const reply = stripSpeechFormatting(rawReply);

      await addTurnToHistory(chat.id._serialized, senderId, resolved.prompt, reply);

      const mp3Buffer = await fishAudio.synthesizeSpeech(reply);

      mp3Path = tmpFile('mp3');
      oggPath = tmpFile('ogg');
      fs.writeFileSync(mp3Path, mp3Buffer);

      // Same ffmpeg settings .tts uses for its mp3 -> ogg/opus conversion,
      // so it plays as a proper WhatsApp voice note.
      await runFfmpeg(mp3Path, oggPath, [
        '-vn',
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-f', 'ogg',
      ]);

      const voiceData = fs.readFileSync(oggPath).toString('base64');
      const voiceMedia = new MessageMedia('audio/ogg', voiceData);
      await msg.reply(voiceMedia, undefined, { sendAudioAsVoice: true });
    } catch (err) {
      // Fish Audio-specific failures need their own messages (same as
      // .tts); anything else (Gemini transcription/text errors) goes
      // through the shared friendlyAiError() handling.
      if (err.code === 'NO_FISH_KEY' || err.code === 'NO_FISH_VOICE') {
        return msg.reply(`❌ ${err.message}`);
      } else if (err.status === 402) {
        return msg.reply('❌ Fish Audio TTS failed: out of credits/quota on your Fish Audio account.');
      } else if (err.status === 401) {
        return msg.reply('❌ Fish Audio TTS failed: invalid FISH_API_KEY.');
      } else {
        return msg.reply(friendlyAiError(err, 'Voice'));
      }
    } finally {
      cleanup(mp3Path, oggPath);
    }
  },

  // .imagine [prompt] — AI image generation (Gemini 2.5 Flash Image / "Nano Banana")
  async imagine(client, msg, args) {
    const prompt = args.join(' ');
    if (!prompt) return msg.reply('❌ Usage: .imagine [image description]');

    await msg.reply('🎨 Generating image...');
    try {
      const { base64, mimeType } = await gemini.generateImage(prompt);
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      const media = new MessageMedia(mimeType, base64, `imagine.${ext}`);

      await msg.reply(media, undefined, { caption: `🎨 *Imagine:* ${prompt}` });
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Image generation'));
    }
  },

  // .upscale — upscale a replied-to image using RapidAPI (unchanged — not an
  // OpenAI/Gemini call, no need to touch this one)
  async upscale(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image with .upscale');

    await msg.reply('⬆️ Upscaling image...');
    try {
      const media = await targetMsg.downloadMedia();
      // media.data is already base64-encoded

      const params = new URLSearchParams();
      params.append('image_base64', media.data);
      params.append('scale_factor', '2');

      const res = await axios.post(
        'https://ai-image-upscaler1.p.rapidapi.com/v1',
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'ai-image-upscaler1.p.rapidapi.com',
          },
        }
      );

      if (res.data.code !== 0 || !res.data.result_base64) {
        console.error('Upscale non-ok response:', JSON.stringify(res.data)?.slice(0, 300));
        return msg.reply('❌ Upscale failed. Make sure you replied to an image and your RapidAPI key is valid.');
      }

      const upscaledMedia = new MessageMedia('image/jpeg', res.data.result_base64);
      await msg.reply(upscaledMedia, undefined, { caption: '✅ Image upscaled 2x!' });
    } catch (err) {
      console.error('Upscale error:', err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 300) || err.message);
      return msg.reply('❌ Upscale failed. Make sure you replied to an image and your RapidAPI key is valid.');
    }
  },

  // .translate [lang] [text] — translate text (Gemini)
  async translate(client, msg, args) {
    const lang = args[0];
    const text = args.slice(1).join(' ');

    // Check if replying to a message
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const toTranslate = text || quoted?.body;

    if (!lang || !toTranslate) {
      return msg.reply('❌ Usage: .translate [language] [text]\nOr reply to a message with .translate [language]');
    }

    await msg.reply('🌍 Translating...');
    try {
      const translated = await gemini.generateText({
        systemPrompt: `Translate the following text to ${lang}. Return ONLY the translated text, nothing else.`,
        prompt: toTranslate,
        maxOutputTokens: 1500,
      });
      return msg.reply(`🌍 *Translation (${lang})*\n\n${translated}`);
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Translation'));
    }
  },

  // .transcribe — transcribe a voice note (Gemini multimodal, replaces Whisper)
  async transcribe(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a voice note with .transcribe');

    await msg.reply('🎙️ Transcribing...');
    try {
      const media = await targetMsg.downloadMedia();
      if (!media.mimetype.includes('audio') && !media.mimetype.includes('ogg')) {
        return msg.reply('❌ Please reply to a voice note or audio file.');
      }

      const text = await gemini.transcribeAudio({
        base64Audio: media.data,
        mimeType: media.mimetype,
      });

      return msg.reply(`🎙️ *Transcription*\n\n${text}`);
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Transcription'));
    }
  },

  // .tts [text] — text-to-speech via Fish Audio, sent back as a WhatsApp
  // voice note. Reply to a message with .tts (no args) to speak that
  // message's text instead of typing it again.
  async tts(client, msg, args) {
    const typed = args.join(' ');
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const rawText = typed || quoted?.body;

    if (!rawText) return msg.reply('❌ Usage: .tts [text]\nOr reply to a text message with .tts');

    // Strip markdown and emoji before checking length or sending to Fish Audio.
    // This also cleans older AI replies when the user quotes them with .tts.
    const text = stripSpeechFormatting(rawText);
    if (!text) return msg.reply('❌ Nothing left to speak after stripping formatting from that text.');
    if (text.length > 800) return msg.reply('❌ Keep it under 800 characters for now — long TTS jobs are slow on Fish Audio\'s free tier.');

    let mp3Path, oggPath;
    try {
      const mp3Buffer = await fishAudio.synthesizeSpeech(text);

      mp3Path = tmpFile('mp3');
      oggPath = tmpFile('ogg');
      fs.writeFileSync(mp3Path, mp3Buffer);

      // Convert to ogg/opus — same ffmpeg settings commands/converter.js
      // uses for .tovn — so it plays as a proper WhatsApp voice note
      // instead of showing up as a generic audio file attachment.
      await runFfmpeg(mp3Path, oggPath, [
        '-vn',
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-f', 'ogg',
      ]);

      const voiceData = fs.readFileSync(oggPath).toString('base64');
      const voiceMedia = new MessageMedia('audio/ogg', voiceData);

      await msg.reply(voiceMedia, undefined, { sendAudioAsVoice: true });
    } catch (err) {
      if (err.code === 'NO_FISH_KEY' || err.code === 'NO_FISH_VOICE') {
        return msg.reply(`❌ ${err.message}`);
      } else if (err.status === 402) {
        return msg.reply('❌ Fish Audio TTS failed: out of credits/quota on your Fish Audio account.');
      } else if (err.status === 401) {
        return msg.reply('❌ Fish Audio TTS failed: invalid FISH_API_KEY.');
      } else {
        console.error('TTS error:', err.message);
        return msg.reply(`❌ TTS failed: ${err.message}`);
      }
    } finally {
      cleanup(mp3Path, oggPath);
    }
  },
};
