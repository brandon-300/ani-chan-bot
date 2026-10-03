
import AiConversation from '../models/AiConversation.js';
import aiMessageLedger from '../utils/aiMessageLedger.js';
import aiStickers from '../utils/aiStickers.js';
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import fishAudio from '../utils/fishAudio.js';
import fs from 'fs';
import gemini from '../utils/gemini.js';
import logger from '../utils/logger.js';
import os from 'os';
import path from 'path';
import speechText from '../utils/speechText.js';
import { BOT_NAME, FISH_EXPRESSION_TAGS, AI_VOICE_MAX_OUTPUT_TOKENS, BOT_OWNER } from '../utils/config.js';
import { MessageMedia } from '../whatsapp/media.js';
import { getActivePersonaSafe, loadPersona } from '../utils/persona.js';
import { safeGetChat, safeGetQuotedMessage, resolveSenderName } from '../utils/helpers.js';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// 	 Small tmp-file / ffmpeg helpers 											
// Same pattern as commands/converter.js (tmpFile/runFfmpeg/cleanup)  kept as
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

// Conversation memory with persona support
// Each user has 3 separate conversations (one per persona)
// Expires after 7 days of inactivity
// Bot owner has unlimited history

const HISTORY_LIMIT = 20; // messages kept per conversation

/**
 * Check if user is bot owner
 */
function isBotOwner(senderId) {
  const owner = BOT_OWNER || process.env.BOT_OWNER;
  if (!owner) return false;
  return senderId === owner || senderId.includes(owner.split('@')[0]);
}

/**
 * Get conversation for a specific persona
 * Each user has 3 separate conversations (one per persona)
 */
async function getHistory(chatId, senderId, personaId = 'default') {
  const isOwner = isBotOwner(senderId);
  
  // For bot owner, no expiration - get conversation without updating expiry
  if (isOwner) {
    const convo = await AiConversation.findOne({ 
      chatId, 
      senderId, 
      personaId: personaId || 'default' 
    }).catch(err => {
      console.error('getHistory: lookup failed:', err.message);
      return null;
    });
    return convo ? convo.messages.map(m => ({ role: m.role, content: m.content })) : [];
  }
  
  // For non-owner users, update lastActivityAt on read to extend expiration
  const conversation = await AiConversation.findOneAndUpdate(
    { chatId, senderId, personaId: personaId || 'default' },
    { $set: { lastActivityAt: new Date() } },
    { upsert: true, new: true }
  ).catch(err => {
    console.error('getHistory: lookup failed:', err.message);
    return null;
  });
  
  return conversation ? conversation.messages.map(m => ({ role: m.role, content: m.content })) : [];
}

/**
 * Add a turn to conversation history with persona support
 * Updates lastActivityAt and extends expiration for non-owner users
 */
async function addTurnToHistory(chatId, senderId, personaId, userContent, assistantContent) {
  const isOwner = isBotOwner(senderId);
  const now = new Date();
  const newExpiresAt = isOwner ? null : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  await AiConversation.findOneAndUpdate(
    { chatId, senderId, personaId: personaId || 'default' },
    {
      $push: {
        messages: {
          $each: [
            { role: 'user', content: userContent, timestamp: now },
            { role: 'assistant', content: assistantContent, timestamp: now },
          ],
          $slice: -HISTORY_LIMIT,
        },
      },
      $set: { 
        lastActivityAt: now,
        ...(newExpiresAt ? { expiresAt: newExpiresAt } : {})
      },
    },
    { upsert: true }
  ).catch(err => console.error('addTurnToHistory: save failed:', err.message));
}

/**
 * Switch persona - starts a new conversation thread for the new persona
 */
async function switchPersona(chatId, senderId, newPersonaId) {
  const isOwner = isBotOwner(senderId);
  const now = new Date();
  const expiresAt = isOwner ? null : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  
  const conversation = await AiConversation.findOneAndUpdate(
    { chatId, senderId, personaId: newPersonaId || 'default' },
    {
      $set: { 
        lastActivityAt: now,
        ...(expiresAt ? { expiresAt } : {})
      }
    },
    { upsert: true, new: true }
  );
  
  return conversation;
}
/**
 * Get the active persona ID for a specific chat/sender combination
 * Checks conversation history first, then falls back to configured AI_PERSONA
 */
async function getPersonaIdForChat(chatId, senderId) {
  // Try to find an active conversation with a specific persona
  const conversation = await AiConversation.findOne(
    { chatId, senderId },
    { personaId: 1 },
    { sort: { lastActivityAt: -1 } }
  );
  
  if (conversation?.personaId) {
    return conversation.personaId;
  }
  
  // Fall back to the globally configured persona
  const persona = getActivePersonaSafe();
  return persona?.id || 'default';
}


// Persona prompts and internal text controls
// Voice prompts deliberately omit the text-only reaction/menu controls.
// The reply-controls block for text replies. It is built in code (not in the
// persona files) because the sticker catalogue changes on every request. It
// teaches the model to answer like a person in a chat: words, a reaction, a
// sticker, or a mix, and never to describe a sticker or picture.
function buildReplyControlsPrompt(catalogue) {
  const hasStickers = Boolean(catalogue?.items?.length);
  const lines = [
    'How to answer like a real person in a WhatsApp chat:',
    '- You can answer with words, with a sticker, with an emoji reaction on their message, or with a mix. Real friends often skip the full sentence: a laugh, a reaction, a sticker, or a few casual words is a normal reply. Do not write a paragraph when a reaction would do, and do not attach a sticker to every message.',
    '- Never describe or name what a sticker or picture shows (no "that frog", "that cartoon", "that picture", "that sticker"). React to the feeling and the situation, the way a friend would.',
    '- Match the moment. A joke, a meme, or a funny "mood" about everyday stress such as exams, work or school gets a laugh, a laughing reaction, or a playful line, not advice and not a counselling tone. Only when the person is clearly really hurting do you comfort them, briefly and naturally, with a few warm words, a gentle sticker, or a sad or hugging emoji. Sympathy is the exception, not the default.',
    '',
    'Control tokens (invisible to the user; put them after your reply and never mention them):',
    '- [[emoji:\ud83d\ude02]] also puts that single emoji as a reaction on THEIR message. Use any one emoji that fits (\ud83d\ude02 \ud83d\ude2d \ud83e\udd7a \u2764\ufe0f \ud83d\udc4d \ud83d\udd25 \ud83d\ude33 \ud83d\ude44 ...). Use it alone when an emoji is the natural reply.',
  ];
  if (hasStickers) {
    lines.push('- [[sticker:N]] also sends sticker number N from the catalogue below. Use it alone (no words) when the sticker is the whole reply. Pick a sticker only if what it shows and feels like really fits what you are answering; otherwise write [[sticker:none]] or leave it out. Only use a number that is listed.');
  } else {
    lines.push('- There is no sticker library available right now, so never write [[sticker:...]].');
  }
  lines.push('- Every reply must contain at least one of: words, [[emoji:...]] or [[sticker:N]].');
  if (hasStickers) lines.push('', 'Sticker catalogue (number "what it shows" [feelings it fits]):', catalogue.text);
  return lines.join('\n');
}

// Older persona files carried their own "Internal reaction control" block
// (label-based stickers). The controls are built in code now, so a leftover
// copy is removed instead of contradicting them.
function stripLegacyReactionBlock(text) {
  return String(text || '').replace(/\nInternal reaction control:\n[\s\S]*?(?=\nPrivate-DM menu action:\n|$)/, '\n');
}

function buildPersonaSystemPrompt(senderName, medium, allowBotActions = false, { catalogue = null, personaId = null } = {}) {
  // If personaId is provided, try to load that specific persona
  // Otherwise fall back to the globally configured active persona
  let persona;
  if (personaId) {
    try {
      persona = loadPersona(personaId);
    } catch (err) {
      // If specific persona fails, fall back to default
      persona = getActivePersonaSafe();
    }
  } else {
    persona = getActivePersonaSafe();
  }
  
  if (!persona) {
    const err = new Error('The active AI persona could not be loaded. Check AI_PERSONA and its config/personas/<id> files.');
    err.code = 'AI_PERSONA_UNAVAILABLE';
    throw err;
  }
  const mediumPrompt = medium === 'voice' ? persona.voicePrompt : persona.text;
  let behavior = mediumPrompt;
  if (medium !== 'voice') {
    behavior = stripLegacyReactionBlock(behavior);
    const marker = '\nPrivate-DM menu action:\n';
    const splitAt = behavior.indexOf(marker);
    if (splitAt >= 0 && !allowBotActions) behavior = behavior.slice(0, splitAt);
  }
  const identity = `You are ${persona.displayName}${persona.series ? ` from "${persona.series}"` : ''}, acting as ${BOT_NAME}'s AI assistant on WhatsApp. Be this character naturally; never sound like generic customer support. ${medium === 'voice' ? 'This reply is spoken aloud: never use emojis, emoticons, symbols, brackets or stage directions, because every symbol is read literally.' : 'You may use emojis the way a real person texting does: a natural few that match the mood, never instead of words.'}`;
  let prompt = `${identity}\n\n${persona.personality}\n\n${behavior}`;
  if (medium !== 'voice') prompt += `\n\n${buildReplyControlsPrompt(catalogue)}`;
  if (senderName) {
    prompt += `\n\nThe person's name is "${senderName}". Address them by that name as written; do not automatically append -kun or another honorific.`;
  }
  return prompt;
}

// Reply controls
// The model is told (buildReplyControlsPrompt) to use [[emoji:X]] and
// [[sticker:N]]. Models don't always follow the exact shape, so this parser is
// forgiving, and strict about what it will act on:
//   - [[emoji:X]] / [[react:X]]: only a single real emoji is accepted
//   - [[sticker:N]]: a positive number; whether N was actually offered is
//     checked at delivery time; [[sticker:none]] is a deliberate "no sticker"
//   - legacy [[reaction:label]], bare [[label]] and [[response_mode:...]] are
//     still understood (and logged) but no longer pick a sticker
//   - [[bot_action:command_menu]] only where allowed
//   - never lets any [[...]] control syntax reach the visible reply or the
//     conversation history, matched or not
const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : null;

// Returns the first emoji in `value` if (and only if) it is a genuine emoji.
function parseEmojiToken(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const first = graphemeSegmenter ? [...graphemeSegmenter.segment(text)][0]?.segment : [...text][0];
  if (!first || first.length > 16) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first)) return null;
  if (speechText.stripEmojis(first).trim() !== '') return null;
  return first;
}

function parseAiControls(rawOutput, { allowBotActions = false } = {}) {
  let reaction = 'none';
  let responseMode = 'text';
  let action = null;
  let sawReaction = false;
  let emoji = null;
  let sawEmojiToken = false;
  let stickerId = null;
  let stickerNone = false;
  const controlToken = /\[\[\s*([a-z_]+)(?:\s*:\s*([^\]\r\n]*))?\s*(?:\]\]|$)/gi;

  let clean = String(rawOutput || '').replace(controlToken, (_token, word, value) => {
    const kindWord = String(word).toLowerCase();
    const rawValue = String(value || '').trim();
    const label = rawValue.toLowerCase();
    if (kindWord === 'emoji' || kindWord === 'react') {
      if (!sawEmojiToken) {
        sawEmojiToken = true;
        emoji = parseEmojiToken(rawValue);
      }
    } else if (kindWord === 'sticker') {
      if (label === 'none') stickerNone = true;
      else if (stickerId === null && /^\d{1,3}$/.test(label) && Number(label) > 0) stickerId = Number(label);
    } else if (kindWord === 'reaction' && !sawReaction && (label === 'none' || aiStickers.ALLOWED_REACTIONS.has(label))) {
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
  return { text: clean, reaction, responseMode, action, emoji, stickerId, stickerNone };
}

// Puts an emoji reaction on the USER'S message (the same thing a person does by
// long-pressing a message). Never throws; the caller gets true/false.
async function reactToUserMessage(msg, emoji) {
  try {
    await msg.react(emoji);
    logger.write('INFO', 'ai.emoji.react', { emoji, messageType: msg.type || 'unknown' });
    return true;
  } catch (err) {
    logger.error('ai.emoji.react.failed', err, { emoji });
    return false;
  }
}

// copilot/voice put a \u23f3 on the user's message while they work. A person does
// not leave an hourglass behind, so it is removed when the reply is done,
// unless the AI replaced it with its own emoji reaction.
async function clearStatusReaction(msg) {
  if (msg._aiEmojiReacted) return;
  try {
    await msg.react('');
    logger.write('INFO', 'ai.status_reaction.cleared', {});
  } catch (err) {
    logger.write('WARN', 'ai.status_reaction.clear_failed', { error: String(err.message || err).slice(0, 160) });
  }
}

// What the AI actually did, written the way the AI itself writes it, so its own
// history teaches the same habit (and any copy of it in a reply is stripped by
// parseAiControls). `delivered` is the result of deliverTextResponse, if any.
function historyAssistantText(controls, delivered) {
  const parts = [];
  if (controls.text && (delivered ? delivered.textSent : true)) parts.push(controls.text);
  if (controls.action === 'command_menu') parts.push('I sent the command menu.');
  if (delivered?.emojiReacted && controls.emoji) parts.push(`[[emoji:${controls.emoji}]]`);
  if (delivered?.stickerSent && delivered.stickerItem) parts.push(`[[sticker_sent:${delivered.stickerItem.label}]]`);
  return parts.join(' ').trim() || '[[no_reply]]';
}

async function deliverTextResponse(client, msg, rawOutput, allowBotActions = false, { stickerReply = false, catalogue = null, personaId = 'default' } = {}) {
  const controls = parseAiControls(rawOutput, { allowBotActions });
  logger.write('INFO', 'ai.model.reply', {
    stickerReply,
    textChars: controls.text.length,
    textPreview: controls.text.slice(0, 160),
    emoji: controls.emoji,
    sticker: controls.stickerId ?? (controls.stickerNone ? 'none' : null),
    legacyReaction: controls.reaction !== 'none' ? controls.reaction : null,
    action: controls.action,
    personaId,
  });

  if (controls.action === 'command_menu') {
    if (controls.text) await replyTracked(msg, controls.text, 'text', personaId);
    if (typeof client.sendQuickMenu === 'function') await client.sendQuickMenu(msg);
    else if (!controls.text) await msg.reply('\u274c I could not open the command menu right now.');
    logger.write('INFO', 'ai.decision', { menu: true, textChars: controls.text.length, personaId });
    return Object.assign(controls, { textSent: Boolean(controls.text), emojiReacted: false, stickerSent: false, stickerItem: null, personaId });
  }

  const dropped = [];

  // 1. Emoji reaction on the user's message (instant, like a person tapping it).
  let emojiReacted = false;
  if (controls.emoji) emojiReacted = await reactToUserMessage(msg, controls.emoji);
  else if (controls.emoji === null && /\[\\s*(?:emoji|react)\s*:/i.test(String(rawOutput || ''))) dropped.push('emoji (not a valid emoji)');
  msg._aiEmojiReacted = emojiReacted;

  // 2. Which sticker (if any) did the model choose, and was it actually offered?
  let stickerItem = null;
  if (controls.stickerId !== null) {
    stickerItem = (catalogue?.items || []).find(item => item.id === controls.stickerId) || null;
    logger.write(stickerItem ? 'INFO' : 'WARN', 'ai.sticker.choice', {
      requested: controls.stickerId,
      status: stickerItem ? 'valid' : 'not_offered',
      offered: catalogue?.items?.length || 0,
      anime: stickerItem?.entry?.animeName || null,
      description: stickerItem?.label || null,
      personaId,
    });
    if (!stickerItem) dropped.push(`sticker ${controls.stickerId} (not in the catalogue)`);
  } else if (catalogue?.items?.length) {
    logger.write('INFO', 'ai.sticker.choice', { requested: null, status: controls.stickerNone ? 'none_chosen' : 'not_requested', offered: catalogue.items.length, personaId });
  }

  // 3. A reply to someone's sticker is ONE reply, like a person's: a sticker or
  //    words, never both. A reaction emoji can still go with either.
  let sendText = Boolean(controls.text);
  const sendSticker = Boolean(stickerItem);
  if (stickerReply && sendText && sendSticker) {
    sendText = false;
    dropped.push('text (a reply to a sticker is one message)');
  }

  let textSent = false;
  let stickerSent = false;
  if (sendText) {
    await replyTracked(msg, controls.text, 'text', personaId);
    textSent = true;
  }
  if (sendSticker) {
    const result = await aiStickers.sendCatalogueSticker(client, msg, catalogue, stickerItem.id);
    stickerSent = result.sent;
  }
  // The sticker could not be sent and the words were set aside for it: say them.
  if (!stickerSent && !textSent && controls.text) {
    await replyTracked(msg, controls.text, 'text', personaId);
    textSent = true;
    dropped.push('(sticker failed, so the text was sent instead)');
  }
  if (!textSent && !stickerSent && !emojiReacted) {
    await msg.reply('\u274c I could not generate a response. Please try again.');
  }

  logger.write('INFO', 'ai.decision', {
    stickerReply,
    text: textSent,
    textChars: textSent ? controls.text.length : 0,
    emoji: emojiReacted ? controls.emoji : null,
    sticker: stickerSent ? { id: stickerItem.id, anime: stickerItem.entry.animeName || stickerItem.entry.animeId || null, description: stickerItem.label } : null,
    dropped,
    personaId,
  });
  return Object.assign(controls, { textSent, emojiReacted, stickerSent, stickerItem, personaId });
}

// Everything spoken by Fish Audio goes through speechText.toSpeechText():
// emojis, [cues], (S1-style cues), stage directions, markdown, URLs and control
// tokens are removed, and chat shorthand becomes spoken words. It runs
// regardless of how well the model followed the voice prompt. Kept under the
// old name so existing callers and tests keep working.
const stripSpeechFormatting = speechText.toSpeechText;

// Sends a reply and records the sent message so a later reaction to it can be
// recognised as a reaction to something the AI said (utils/aiMessageLedger.js).
async function replyTracked(msg, content, kind, personaId = 'default') {
  const sent = await msg.reply(content);
  aiMessageLedger.remember(sent, kind, personaId);
  return sent;
}

// Turns a gemini.js error into the kind of short, actionable WhatsApp reply
// the old OpenAI-based commands used to give, without swallowing the actual
// reason (missing key, bad model name, safety block, etc.)  important since
// Brandon can't always dig through PM2 logs on unstable data.
function friendlyAiError(err, fallbackLabel) {
  if (err.code === 'AI_PERSONA_UNAVAILABLE') return `\u274c ${err.message}`;
  if (err.code === 'NO_GEMINI_KEY') return '\u274c GEMINI_API_KEY is missing from .env.';
  if (err.code === 'EMPTY_RESPONSE' || err.code === 'EMPTY_IMAGE') return `\u274c ${err.message}`;
  if (err.status === 429) {
    // Google returns 429 both for "you're calling too fast, back off a bit"
    // AND for "your project has zero free quota for this model, enable
    // billing"  same HTTP status, very different fix. The message text is
    // the only way to tell them apart; retrying helps with the first, not
    // the second.
    if (/quota/i.test(err.message)) {
      return `\u274c Gemini rejected this: no free quota available (needs billing enabled on your Google AI Studio project). Retrying won't help.\n\n${err.message}`;
    }
    return '\u274c Gemini rate limit hit \u2014 free tier caps requests per minute/day. Try again shortly.';
  }
  console.error(`${fallbackLabel} error:`, err.message);
  return `\u274c ${fallbackLabel} failed: ${err.message}`;
}

// Shared multimodal input resolution for .copilot / .gpt / .voice
// Figures out what the user is actually asking for. Two possible media
// sources, checked in this order:
//   1. The message itself, if IT carries media  covers sending an image
//      directly with a ".copilot ..." caption, AND (new) index.js's
//      auto-reply detection, where the user's own reply to the bot is an
//      image or voice note.
//   2. The quoted message's media, if the current message has none  the
//      classic "reply to an existing image/voice-note with .copilot" usage.
// Resolution:
//  - plain typed args only                       -> { prompt: <args> }
//  - own or quoted image (+ required typed args)  -> { prompt: <args>, image: {...} }
//  - own or quoted voice note (+ optional args)   -> { prompt: <transcript [+ args]> }
//  - neither has usable media                     -> falls back to typed args
//  - an image with NO typed args                  -> { error: '...usage...' }
// Returns { error } OR { prompt, image } (image is null when there isn't one).
// What the model is told when the user sends a sticker. The old wording said
// "interpret this sticker", which produced answers that DESCRIBED the picture
// ("that frog is too real") instead of reacting to it the way a friend would.
const USER_STICKER_PROMPT = [
  'The user just sent the sticker in Image 1 as their reply in our chat.',
  'Read it the way a friend would: the feeling it expresses, any words printed on it, and how it connects to what you two were just talking about.',
  'Then answer the way a real friend actually would: usually laugh along, react with an emoji, or send a fitting sticker; only now and then a few casual words, and only occasionally real sympathy.',
  'Never describe or name what is drawn on it (no frog, cartoon, character, picture, or "that sticker").',
].join(' ');

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
  if (!media) return { error: '\u274c Could not download the attached/replied-to media \u2014 it may have expired. Try re-sending it and trying again.' };
  const mimetype = media.mimetype || '';

  if (mimetype.includes('image') || msg.type === 'sticker' || source.type === 'sticker') {
    if (!typed && msg.type !== 'sticker') {
      return { error: '\u274c Reply to an image AND tell me what to do with it, e.g. *.copilot describe this image*' };
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
      : (typed || USER_STICKER_PROMPT);
    const quotedMessageId = quoted?.id?._serialized || quoted?.id?.id;
    if (botSentStickerReply && quotedMessageId) {
      const sentContext = await aiStickers.getSentStickerContext(quotedMessageId);
      if (sentContext) {
        prompt += `\n\nIMPORTANT IMAGE ORDER: Image 1 is the new sticker sent by the user. Image 2 is the sticker previously sent by you (the bot/persona ${sentContext.personaId}), not by the user. The user did NOT send Image 2. It was your reaction sticker with reaction label ${sentContext.reaction || 'unknown'}. Treat the user's current message as a response to the sticker you sent.`;
      } else {
        prompt += '\n\nIMPORTANT IMAGE ORDER: Image 1 is the new sticker sent by the user. Image 2 is the sticker previously sent by you (the bot), not by the user. The user did NOT send Image 2. Treat the user\'s current message as a response to your reaction sticker.';
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

export default {
  _parseAiControls: parseAiControls,
  _stripSpeechFormatting: stripSpeechFormatting,
  _buildPersonaSystemPrompt: buildPersonaSystemPrompt,
  _deliverTextResponse: deliverTextResponse,
  _buildReplyControlsPrompt: buildReplyControlsPrompt,
  _stripLegacyReactionBlock: stripLegacyReactionBlock,
  _historyAssistantText: historyAssistantText,
  _clearStatusReaction: clearStatusReaction,
  _USER_STICKER_PROMPT: USER_STICKER_PROMPT,

  // .stickerimport [off]  owner-only, private-DM import mode. Sticker media
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

  // .copilot [prompt]  full context-aware AI chat (Gemini). Also works
  // replying to a voice note (transcribed and used as the prompt) or an
  // image (analyzed with Gemini vision  you must also say what to do
  // with it, e.g. ".copilot what anime is this from").
  async copilot(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;

    const resolved = await resolveMultimodalInput(msg, args);
    if (resolved.error) return msg.reply(resolved.error);
    if (!resolved.prompt) {
      return msg.reply('\u274c Usage: .copilot [your message]\nOr reply to a voice note with .copilot, or reply to an image with .copilot [what to do with it]');
    }

    try { await msg.react('\u23f3'); } catch { /* reactions aren't critical to the reply */ }

    try {
      // msg.author is the actual sender inside a group; it's undefined in a
      // DM, where msg.from IS the sender (and already unique per person)
      //  see models/AiConversation.js's comment for why this matters.
      const senderId = msg.author || msg.from;
      const chatId = chat.id._serialized;
      const personaId = await getPersonaIdForChat(chatId, senderId);
      const persona = personaId !== 'default' ? loadPersona(personaId) : getActivePersonaSafe();
      const history = await getHistory(chatId, senderId, personaId);
      const senderName = await resolveSenderName(msg, client);
      const allowBotActions = !chat.isGroup;
      const catalogue = await aiStickers.buildStickerCatalogue(chat.id._serialized, persona);
      const systemPrompt = buildPersonaSystemPrompt(senderName, 'text', allowBotActions, { catalogue, personaId });
      const inputKind = resolved.stickerReply ? 'sticker' : (resolved.images?.length ? 'image' : 'text');
      logger.write('INFO', 'ai.input', {
        command: 'copilot',
        sender: senderName,
        chat: chat.isGroup ? 'group' : 'DM',
        kind: inputKind,
        stickerReply: Boolean(resolved.stickerReply),
        promptChars: resolved.prompt.length,
        promptPreview: inputKind === 'sticker' ? '(user sticker)' : resolved.prompt.slice(0, 120),
        stickersOffered: catalogue.offered,
        personaId,
      });

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

      // The conversation memory records what the AI actually did (words, an
      // emoji reaction, a sticker), so it keeps acting like one person. The
      // memory is saved even if delivery fails part-way.
      const controls = parseAiControls(rawReply, { allowBotActions });
      const historyUser = resolved.stickerReply ? '[sent a sticker]' : resolved.prompt;
      let delivered = null;
      try {
        delivered = await deliverTextResponse(client, msg, rawReply, allowBotActions, { stickerReply: resolved.stickerReply, catalogue, personaId });
        return delivered;
      } finally {
        await addTurnToHistory(chat.id._serialized, senderId, personaId, historyUser, historyAssistantText(controls, delivered));
      }
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Copilot'));
    } finally {
      await clearStatusReaction(msg);
    }
  },

  // .gpt [prompt]  single-turn AI reply (Gemini, no history). Same quoted
  // voice-note/image handling as .copilot, minus conversation memory.
  async gpt(client, msg, args) {
    const resolved = await resolveMultimodalInput(msg, args);
    if (resolved.error) return msg.reply(resolved.error);
    if (!resolved.prompt) {
      return msg.reply('\u274c Usage: .gpt [your question]\nOr reply to a voice note with .gpt, or reply to an image with .gpt [what to do with it]');
    }

    await msg.reply('\ud83d\udcad Processing...');
    try {
      const senderName = await resolveSenderName(msg, client);
      const chat = await safeGetChat(msg);
      const allowBotActions = !!chat && !chat.isGroup;
      const persona = getActivePersonaSafe();
      const personaId = persona?.id || 'default';
      const catalogue = await aiStickers.buildStickerCatalogue(msg.from || msg.to, persona);
      const systemPrompt = buildPersonaSystemPrompt(senderName, 'text', allowBotActions, { catalogue, personaId });
      logger.write('INFO', 'ai.input', {
        command: 'gpt',
        sender: senderName,
        chat: chat?.isGroup ? 'group' : 'DM',
        kind: resolved.stickerReply ? 'sticker' : (resolved.images?.length ? 'image' : 'text'),
        promptChars: resolved.prompt.length,
        promptPreview: resolved.prompt.slice(0, 120),
        personaId,
      });

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

      return await deliverTextResponse(client, msg, reply, allowBotActions, { stickerReply: resolved.stickerReply, catalogue, personaId });
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'GPT'));
    }
  },

  // .voice [prompt]  like .copilot, but always answers with a spoken
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
      return msg.reply('\u274c Usage: .voice [your message]\nOr reply to a voice note with .voice, or reply to an image with .voice [what to do with it]');
    }

    try { await msg.react('\u23f3'); } catch { /* reactions aren't critical to the reply */ }

    let mp3Path, oggPath;
    try {
      // See .copilot's identical comment above.
      const senderId = msg.author || msg.from;
      const chatId = chat.id._serialized;
      const personaId = await getPersonaIdForChat(chatId, senderId);
      const persona = personaId !== 'default' ? loadPersona(personaId) : getActivePersonaSafe();
      const history = await getHistory(chatId, senderId, personaId);
      const senderName = await resolveSenderName(msg, client);
      const systemPrompt = buildPersonaSystemPrompt(senderName, 'voice', false, { personaId });

      const rawReply = resolved.images?.length
        ? await gemini.generateVision({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            images: resolved.images,
            maxOutputTokens: AI_VOICE_MAX_OUTPUT_TOKENS,
          })
        : await gemini.generateText({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            maxOutputTokens: AI_VOICE_MAX_OUTPUT_TOKENS,
          });

      // Safety net  see stripSpeechFormatting()'s comment above. Applied
      // before both TTS and history so a stray "*" the model slips in
      // never gets spoken AND never lingers in context for the next turn.
      const reply = stripSpeechFormatting(rawReply);

      if (!reply) throw new Error('The voice reply was empty after removing non-spoken text. Please try again.');

      // History keeps the plain spoken words; the optional expression cue is
      // added only to the text sent to Fish Audio (config FISH_EXPRESSION_TAGS).
      // Filter out emojis and Fish Audio expression tags for voice
      const voiceText = aiMessageLedger.filterEmojisForTTS(reply);
      
      await addTurnToHistory(chat.id._serialized, senderId, personaId, resolved.prompt, reply);

      // Use improved voice synthesis with anime character settings
      const mp3Buffer = await fishAudio.synthesizeSpeech(
        FISH_EXPRESSION_TAGS ? speechText.applyExpressionCue(voiceText) : voiceText,
        personaId
      );

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
      await replyTracked(msg, voiceMedia, 'voice', personaId, { sendAudioAsVoice: true });
    } catch (err) {
      // Fish Audio-specific failures need their own messages (same as
      // .tts); anything else (Gemini transcription/text errors) goes
      // through the shared friendlyAiError() handling.
      if (err.code === 'NO_FISH_KEY' || err.code === 'NO_FISH_VOICE') {
        return msg.reply(`\u274c ${err.message}`);
      } else if (err.status === 402) {
        return msg.reply('\u274c Fish Audio TTS failed: out of credits/quota on your Fish Audio account.');
      } else if (err.status === 401) {
        return msg.reply('\u274c Fish Audio TTS failed: invalid FISH_API_KEY.');
      } else {
        return msg.reply(friendlyAiError(err, 'Voice'));
      }
    } finally {
      cleanup(mp3Path, oggPath);
      await clearStatusReaction(msg);
    }
  },

  // .imagine [prompt]  AI image generation (Gemini 2.5 Flash Image / "Nano Banana")
  async imagine(client, msg, args) {
    const prompt = args.join(' ');
    if (!prompt) return msg.reply('\u274c Usage: .imagine [image description]');

    await msg.reply('\ud83c\udfa8 Generating image...');
    try {
      const { base64, mimeType } = await gemini.generateImage(prompt);
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      const media = new MessageMedia(mimeType, base64, `imagine.${ext}`);

      await replyTracked(msg, media, 'image');
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Image generation'));
    }
  },

  // .upscale  upscale a replied-to image using RapidAPI (unchanged  not an
  // OpenAI/Gemini call, no need to touch this one)
  async upscale(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('\u274c Reply to an image with .upscale');

    await msg.reply('\u2b06\ufe0f Upscaling image...');
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
        return msg.reply('\u274c Upscale failed. Make sure you replied to an image and your RapidAPI key is valid.');
      }

      const upscaledMedia = new MessageMedia('image/jpeg', res.data.result_base64);
      await msg.reply(upscaledMedia, undefined, { caption: '\u2705 Image upscaled 2x!' });
    } catch (err) {
      console.error('Upscale error:', err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 300) || err.message);
      return msg.reply('\u274c Upscale failed. Make sure you replied to an image and your RapidAPI key is valid.');
    }
  },

  // .translate [lang] [text]  translate text (Gemini)
  async translate(client, msg, args) {
    const lang = args[0];
    const text = args.slice(1).join(' ');

    // Check if replying to a message
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const toTranslate = text || quoted?.body;

    if (!lang || !toTranslate) {
      return msg.reply('\u274c Usage: .translate [language] [text]\nOr reply to a message with .translate [language]');
    }

    await msg.reply('\ud83c\udf0d Translating...');
    try {
      const translated = await gemini.generateText({
        systemPrompt: `Translate the following text to ${lang}. Return ONLY the translated text, nothing else.`,
        prompt: toTranslate,
        maxOutputTokens: 1500,
      });
      return msg.reply(`\ud83c\udf0d *Translation (${lang})*\n\n${translated}`);
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Translation'));
    }
  },

  // .transcribe  transcribe a voice note (Gemini multimodal, replaces Whisper)
  async transcribe(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('\u274c Reply to a voice note with .transcribe');

    await msg.reply('\ud83c\udf99\ufe0f Transcribing...');
    try {
      const media = await targetMsg.downloadMedia();
      if (!media.mimetype.includes('audio') && !media.mimetype.includes('ogg')) {
        return msg.reply('\u274c Please reply to a voice note or audio file.');
      }

      const text = await gemini.transcribeAudio({
        base64Audio: media.data,
        mimeType: media.mimetype,
      });

      return msg.reply(`\ud83c\udf99\ufe0f *Transcription*\n\n${text}`);
    } catch (err) {
      return msg.reply(friendlyAiError(err, 'Transcription'));
    }
  },

  // .tts [text]  text-to-speech via Fish Audio, sent back as a WhatsApp
  // voice note. Reply to a message with .tts (no args) to speak that
  // message's text instead of typing it again.
  async tts(client, msg, args) {
    const typed = args.join(' ');
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const rawText = typed || quoted?.body;

    if (!rawText) return msg.reply('\u274c Usage: .tts [text]\nOr reply to a text message with .tts');

    // Strip markdown and emoji before checking length or sending to Fish Audio.
    // This also cleans older AI replies when the user quotes them with .tts.
    const text = stripSpeechFormatting(rawText);
    if (!text) return msg.reply('\u274c Nothing left to speak after stripping formatting from that text.');
    if (text.length > 800) return msg.reply('\u274c Keep it under 800 characters for now \u2014 long TTS jobs are slow on Fish Audio\'s free tier.');

    // Filter out emojis and Fish Audio expression tags for TTS
    const voiceText = aiMessageLedger.filterEmojisForTTS(text);
    
    let mp3Path, oggPath;
    try {
      const mp3Buffer = await fishAudio.synthesizeSpeech(
        FISH_EXPRESSION_TAGS ? speechText.applyExpressionCue(voiceText) : voiceText
      );

      mp3Path = tmpFile('mp3');
      oggPath = tmpFile('ogg');
      fs.writeFileSync(mp3Path, mp3Buffer);

      // Convert to ogg/opus  same ffmpeg settings commands/converter.js
      // uses for .tovn  so it plays as a proper WhatsApp voice note
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

      await replyTracked(msg, voiceMedia, 'voice');
    } catch (err) {
      if (err.code === 'NO_FISH_KEY' || err.code === 'NO_FISH_VOICE') {
        return msg.reply(`\u274c ${err.message}`);
      } else if (err.status === 402) {
        return msg.reply('\u274c Fish Audio TTS failed: out of credits/quota on your Fish Audio account.');
      } else if (err.status === 401) {
        return msg.reply('\u274c Fish Audio TTS failed: invalid FISH_API_KEY.');
      } else {
        console.error('TTS error:', err.message);
        return msg.reply(`\u274c TTS failed: ${err.message}`);
      }
    } finally {
      cleanup(mp3Path, oggPath);
    }
  },

  // .persona [name]  switch AI persona
  async persona(client, msg, args) {
    const personaName = args.join(' ').trim();
    if (!personaName) {
      const persona = getActivePersonaSafe();
      const personas = await aiStickers.getAvailablePersonas();
      const personaList = personas.map(p => `\u2022 *${p.displayName}* - ${p.description || 'No description'}`).join('\n');
      return msg.reply(`*Current Persona: ${persona?.displayName || 'None'}*\n\n*Available Personas:*\n${personaList}`);
    }

    try {
      const senderId = msg.author || msg.from;
      const chat = await safeGetChat(msg);
      const chatId = chat.id._serialized;
      
      // Find the persona
      const personas = await aiStickers.getAvailablePersonas();
      const targetPersona = personas.find(p => 
        p.displayName.toLowerCase().includes(personaName.toLowerCase()) ||
        p.id.toLowerCase().includes(personaName.toLowerCase())
      );
      
      if (!targetPersona) {
        const personaList = personas.map(p => `\u2022 *${p.displayName}*`).join('\n');
        return msg.reply(`\u274c Persona not found. Available personas:\n${personaList}`);
      }
      
      // Switch persona - this starts a new conversation thread
      await switchPersona(chatId, senderId, targetPersona.id);
      
      // Note: Persona switching is session-based via conversation history
      // The active persona for new chats is determined by AI_PERSONA env var
      
      return msg.reply(`\u2705 Switched to persona: *${targetPersona.displayName}*\n${targetPersona.series ? `from "${targetPersona.series}"` : ''}\n\n*${targetPersona.description || 'No description'}*`);
    } catch (err) {
      console.error('Persona switch error:', err.message);
      return msg.reply(`\u274c Failed to switch persona: ${err.message}`);
    }
  },
};
