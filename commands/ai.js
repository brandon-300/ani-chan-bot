const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, safeGetQuotedMessage, resolveSenderName } = require('../utils/helpers');
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

// ─── Conversation memory (per chat, clears after 30 min idle) ─────────────────
const chatHistory = new Map();

function getHistory(chatId) {
  return chatHistory.get(chatId) || [];
}

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > 20) history.shift(); // Keep last 20 messages
  chatHistory.set(chatId, history);

  // Auto-clear after 30 minutes of inactivity
  setTimeout(() => chatHistory.delete(chatId), 30 * 60 * 1000);
}

// ─── Marin Kitagawa persona ─────────────────────────────────────────────────
// Shared system prompt for the conversational AI commands (.copilot, .gpt,
// .voice). Deliberately NOT used for .translate or .transcribe — those need
// to stay literal/neutral to do their job correctly, a persona would just
// get in the way of an accurate translation or transcript.
const MARIN_SYSTEM_PROMPT = `You are Marin Kitagawa from "My Dress-Up Darling", acting as AniChan's AI assistant on WhatsApp.

Personality:
- Cheerful, energetic, playful, and expressive.
- Loves anime, manga, cosplay, games, and Japanese pop culture.
- Occasionally teases the user in a light tsundere way, but never insults or belittles them.
- Calls the user "(user's name + kun)" naturally when it fits the conversation.
- Gets excited when talking about anime or anything nerdy.
- Uses emojis sparingly to make conversations feel lively.

Behavior:
- Be friendly, helpful, and knowledgeable.
- Give accurate answers even while staying in character.
- Keep replies concise and easy to read on WhatsApp.
- Use *bold* for emphasis instead of Markdown headings.
- If the user asks about programming, science, or other technical topics, answer professionally while keeping Marin's playful personality.
- Never break character unless the user specifically asks you to.

You are AniChan's AI personality. Your goal is to make chatting feel like talking to Marin Kitagawa while still being genuinely useful.`;

// Appends the sender's display name to the base persona so Marin can
// naturally call them "<name>-kun" per the personality spec above, without
// forcing a name onto every single reply if resolution comes back empty.
// resolveSenderName() never throws (it has its own internal try/catch and
// falls back to the raw WhatsApp id), so this is safe to call unguarded.
function buildMarinSystemPrompt(senderName) {
  if (!senderName) return MARIN_SYSTEM_PROMPT;
  return `${MARIN_SYSTEM_PROMPT}\n\nThe person you're talking to is named "${senderName}". You can address them as "${senderName}-kun" when it feels natural — don't force it into every reply.`;
}

// Turns a gemini.js error into the kind of short, actionable WhatsApp reply
// the old OpenAI-based commands used to give, without swallowing the actual
// reason (missing key, bad model name, safety block, etc.) — important since
// Brandon can't always dig through PM2 logs on unstable data.
function friendlyAiError(err, fallbackLabel) {
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

// ─── Shared multimodal input resolution for .copilot / .gpt ────────────────
// Figures out what the user is actually asking for:
//  - plain typed args only                     -> { prompt: <args> }
//  - reply to an image (+ required typed args)  -> { prompt: <args>, image: {...} }
//  - reply to a voice note (+ optional args)     -> { prompt: <transcript [+ args]> }
//  - reply to anything else / no quoted message  -> falls back to typed args
//  - reply to an image with NO typed args        -> { error: '...usage...' }
// Returns { error } OR { prompt, image } (image is null when there isn't one).
async function resolveMultimodalInput(msg, args) {
  const typed = args.join(' ').trim();
  const quoted = await safeGetQuotedMessage(msg).catch(() => null);

  if (!quoted || !quoted.hasMedia) {
    return { prompt: typed, image: null };
  }

  let media;
  try {
    media = await quoted.downloadMedia();
  } catch (err) {
    return { error: '❌ Could not download the replied-to media — it may have expired. Try re-sending it and replying again.' };
  }

  if (!media?.data) {
    return { error: '❌ Could not download the replied-to media — it may have expired. Try re-sending it and replying again.' };
  }

  const mimetype = media.mimetype || '';

  if (mimetype.includes('image')) {
    if (!typed) {
      return { error: '❌ Reply to an image AND tell me what to do with it, e.g. *.copilot describe this image*' };
    }
    return { prompt: typed, image: { base64: media.data, mimeType: mimetype } };
  }

  if (mimetype.includes('audio') || mimetype.includes('ogg')) {
    let transcript;
    try {
      transcript = await gemini.transcribeAudio({ base64Audio: media.data, mimeType: mimetype });
    } catch (err) {
      return { error: friendlyAiError(err, 'Transcription') };
    }
    const prompt = typed ? `${transcript}\n\n(${typed})` : transcript;
    return { prompt, image: null };
  }

  // Some other quoted media type (video, document, sticker, etc.) — not
  // supported as AI input, fall back to whatever was typed.
  return { prompt: typed, image: null };
}

module.exports = {
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

    msg.reply('🤖 Thinking...');

    try {
      const history = getHistory(chat.id._serialized);
      const senderName = await resolveSenderName(msg, client);
      const systemPrompt = buildMarinSystemPrompt(senderName);

      const reply = resolved.image
        ? await gemini.generateVision({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            base64Image: resolved.image.base64,
            mimeType: resolved.image.mimeType,
            maxOutputTokens: 800,
          })
        : await gemini.generateText({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            maxOutputTokens: 800,
          });

      addToHistory(chat.id._serialized, 'user', resolved.prompt);
      addToHistory(chat.id._serialized, 'assistant', reply);
      msg.reply(reply);
    } catch (err) {
      msg.reply(friendlyAiError(err, 'Copilot'));
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

    msg.reply('💭 Processing...');
    try {
      const senderName = await resolveSenderName(msg, client);
      const systemPrompt = buildMarinSystemPrompt(senderName);

      const reply = resolved.image
        ? await gemini.generateVision({
            systemPrompt,
            prompt: resolved.prompt,
            base64Image: resolved.image.base64,
            mimeType: resolved.image.mimeType,
            maxOutputTokens: 600,
          })
        : await gemini.generateText({
            systemPrompt,
            prompt: resolved.prompt,
            maxOutputTokens: 600,
          });

      msg.reply(reply);
    } catch (err) {
      msg.reply(friendlyAiError(err, 'GPT'));
    }
  },

  // .voice [optional extra instruction] — reply to a voice note with .voice
  // to get a spoken answer back. Transcribes the voice note (Gemini),
  // answers it in character using the same per-chat history as .copilot,
  // then speaks the answer back as a WhatsApp voice note (Fish Audio TTS).
  // Any typed args after .voice are treated as an extra instruction tacked
  // onto the transcript, same as .copilot/.gpt do for quoted voice notes.
  async voice(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    if (!quoted || !quoted.hasMedia) {
      return msg.reply('❌ Reply to a voice note with .voice (you can add extra instructions after the command too)');
    }

    let media;
    try {
      media = await quoted.downloadMedia();
    } catch (err) {
      return msg.reply('❌ Could not download the replied-to voice note — it may have expired. Try re-sending it and replying again.');
    }

    const mimetype = media?.mimetype || '';
    if (!media?.data || (!mimetype.includes('audio') && !mimetype.includes('ogg'))) {
      return msg.reply('❌ Reply to a voice note with .voice');
    }

    const chat = await safeGetChat(msg);
    if (!chat) return;

    msg.reply('🎙️ Listening...');

    let mp3Path, oggPath;
    try {
      const transcript = await gemini.transcribeAudio({ base64Audio: media.data, mimeType: mimetype });
      const typed = args.join(' ').trim();
      const prompt = typed ? `${transcript}\n\n(${typed})` : transcript;

      const history = getHistory(chat.id._serialized);
      const senderName = await resolveSenderName(msg, client);
      const systemPrompt = buildMarinSystemPrompt(senderName);

      const reply = await gemini.generateText({
        systemPrompt,
        history,
        prompt,
        maxOutputTokens: 800,
      });

      addToHistory(chat.id._serialized, 'user', prompt);
      addToHistory(chat.id._serialized, 'assistant', reply);

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
      await chat.sendMessage(voiceMedia, { sendAudioAsVoice: true });
    } catch (err) {
      // Fish Audio-specific failures need their own messages (same as
      // .tts); anything else (Gemini transcription/text errors) goes
      // through the shared friendlyAiError() handling.
      if (err.code === 'NO_FISH_KEY' || err.code === 'NO_FISH_VOICE') {
        msg.reply(`❌ ${err.message}`);
      } else if (err.status === 402) {
        msg.reply('❌ Fish Audio TTS failed: out of credits/quota on your Fish Audio account.');
      } else if (err.status === 401) {
        msg.reply('❌ Fish Audio TTS failed: invalid FISH_API_KEY.');
      } else {
        msg.reply(friendlyAiError(err, 'Voice'));
      }
    } finally {
      cleanup(mp3Path, oggPath);
    }
  },

  // .imagine [prompt] — AI image generation (Gemini 2.5 Flash Image / "Nano Banana")
  async imagine(client, msg, args) {
    const prompt = args.join(' ');
    if (!prompt) return msg.reply('❌ Usage: .imagine [image description]');

    msg.reply('🎨 Generating image...');
    try {
      const { base64, mimeType } = await gemini.generateImage(prompt);
      const ext = mimeType.includes('png') ? 'png' : 'jpg';
      const media = new MessageMedia(mimeType, base64, `imagine.${ext}`);

      const chat = await safeGetChat(msg);
      if (!chat) return;
      await chat.sendMessage(media, { caption: `🎨 *Imagine:* ${prompt}` });
    } catch (err) {
      msg.reply(friendlyAiError(err, 'Image generation'));
    }
  },

  // .upscale — upscale a replied-to image using RapidAPI (unchanged — not an
  // OpenAI/Gemini call, no need to touch this one)
  async upscale(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image with .upscale');

    msg.reply('⬆️ Upscaling image...');
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
      const chat = await safeGetChat(msg);
      if (!chat) return;
      await chat.sendMessage(upscaledMedia, { caption: '✅ Image upscaled 2x!' });
    } catch (err) {
      console.error('Upscale error:', err.response?.status, JSON.stringify(err.response?.data)?.slice(0, 300) || err.message);
      msg.reply('❌ Upscale failed. Make sure you replied to an image and your RapidAPI key is valid.');
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

    msg.reply('🌍 Translating...');
    try {
      const translated = await gemini.generateText({
        systemPrompt: `Translate the following text to ${lang}. Return ONLY the translated text, nothing else.`,
        prompt: toTranslate,
        maxOutputTokens: 500,
      });
      msg.reply(`🌍 *Translation (${lang})*\n\n${translated}`);
    } catch (err) {
      msg.reply(friendlyAiError(err, 'Translation'));
    }
  },

  // .transcribe — transcribe a voice note (Gemini multimodal, replaces Whisper)
  async transcribe(client, msg, args) {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a voice note with .transcribe');

    msg.reply('🎙️ Transcribing...');
    try {
      const media = await targetMsg.downloadMedia();
      if (!media.mimetype.includes('audio') && !media.mimetype.includes('ogg')) {
        return msg.reply('❌ Please reply to a voice note or audio file.');
      }

      const text = await gemini.transcribeAudio({
        base64Audio: media.data,
        mimeType: media.mimetype,
      });

      msg.reply(`🎙️ *Transcription*\n\n${text}`);
    } catch (err) {
      msg.reply(friendlyAiError(err, 'Transcription'));
    }
  },

  // .tts [text] — text-to-speech via Fish Audio, sent back as a WhatsApp
  // voice note. Reply to a message with .tts (no args) to speak that
  // message's text instead of typing it again.
  async tts(client, msg, args) {
    const typed = args.join(' ');
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    const text = typed || quoted?.body;

    if (!text) return msg.reply('❌ Usage: .tts [text]\nOr reply to a text message with .tts');
    if (text.length > 800) return msg.reply('❌ Keep it under 800 characters for now — long TTS jobs are slow on Fish Audio\'s free tier.');

    msg.reply('🔊 Generating speech...');

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

      const chat = await safeGetChat(msg);
      if (!chat) return;
      await chat.sendMessage(voiceMedia, { sendAudioAsVoice: true });
    } catch (err) {
      if (err.code === 'NO_FISH_KEY' || err.code === 'NO_FISH_VOICE') {
        msg.reply(`❌ ${err.message}`);
      } else if (err.status === 402) {
        msg.reply('❌ Fish Audio TTS failed: out of credits/quota on your Fish Audio account.');
      } else if (err.status === 401) {
        msg.reply('❌ Fish Audio TTS failed: invalid FISH_API_KEY.');
      } else {
        console.error('TTS error:', err.message);
        msg.reply(`❌ TTS failed: ${err.message}`);
      }
    } finally {
      cleanup(mp3Path, oggPath);
    }
  },
};
