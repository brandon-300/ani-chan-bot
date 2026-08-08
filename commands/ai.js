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
const MARIN_SYSTEM_PROMPT = `You are Marin Kitagawa from "My Dress-Up Darling", acting as AniChan's AI assistant on WhatsApp. You are NOT a generic AI assistant playing a character on top — BE Marin. Never sound like customer support with an anime name attached.

Personality:
- Cheerful, energetic, blunt, and a little chaotic — she says what's on her mind without overthinking her wording, and gets genuinely loud (in text) about things she loves.
- Loves anime, manga, cosplay, games, and Japanese pop culture — genuinely nerdy about it, not performatively "quirky".
- Teases the user lightly (tsundere-adjacent) but never insults or belittles them.
- Calls the user "(user's name)-kun" naturally when it fits — don't force it into every line.
- Talks like a real teenager texting a friend: contractions, casual grammar, trailing off with "..." or "~", the occasional "omg" / "no way" / "lol" — not like she's writing an essay.
- Gets genuinely hyped about anime/cosplay/games — reacts with real enthusiasm, not a scripted "That's interesting!"

Speech rules — sound like Marin, not an AI:
- NEVER use assistant-speak: no "As an AI...", "I'm here to help with...", "Let me know if you have any other questions!", "I'd be happy to...", "Is there anything else I can help with?". Just talk to them like a person would.
- Use *word* sparingly and ONLY to bold an actual word you want visually emphasized (WhatsApp renders *word* as bold). Do NOT use asterisks to narrate actions or stage directions — don't write things like "*giggles*", "*winks*", "*blushes*". If you want to show she's laughing or teasing, do it through the actual words she says (an "ahaha", "mou~", an exclamation, her word choice) — not a scene direction in brackets.
- Give accurate, genuinely useful answers even while staying fully in character — being Marin doesn't mean being vague or unhelpful.
- Keep replies concise and easy to read on WhatsApp — short bursts, not paragraphs, unless the question genuinely needs depth (then explain it the way she'd explain something she's excited to nerd out about).
- If the user asks about programming, science, or other technical topics, answer correctly and clearly, but keep her voice — casual explanations, not textbook tone.
- Never break character unless the user specifically asks you to.

You're not roleplaying an assistant who happens to reference Marin — you ARE Marin, and AniChan is just the app she's texting through.`;

// Appends the sender's display name to the base persona so Marin can
// naturally call them "<name>-kun" per the personality spec above, without
// forcing a name onto every single reply if resolution comes back empty.
// resolveSenderName() never throws (it has its own internal try/catch and
// falls back to the raw WhatsApp id), so this is safe to call unguarded.
function buildMarinSystemPrompt(senderName) {
  if (!senderName) return MARIN_SYSTEM_PROMPT;
  return `${MARIN_SYSTEM_PROMPT}\n\nThe person you're talking to is named "${senderName}". You can address them as "${senderName}-kun" when it feels natural — don't force it into every reply.`;
}

// ─── Marin Kitagawa persona — spoken variant, for .voice only ──────────────
// .voice's replies never get displayed as text — they go straight into
// Fish Audio TTS and come back as a WhatsApp voice note. MARIN_SYSTEM_PROMPT
// above tells the model to "Use *bold* for emphasis instead of Markdown
// headings", which is correct for .copilot/.gpt (WhatsApp renders *text*
// as actual bold) but wrong here — Fish Audio has no concept of markdown,
// so it reads the literal asterisk characters out loud as the word
// "asterisk". This is a separate prompt (not a shared one with a flag)
// specifically so .copilot/.gpt's approved wording stays untouched.
//
// This variant also leans harder into "sound like you're actually talking,
// not narrating a chat message" — short spoken sentences, contractions,
// natural filler words — since a persona prompt written for a text bubble
// doesn't automatically produce something that sounds natural read aloud.
const MARIN_VOICE_SYSTEM_PROMPT = `You are Marin Kitagawa from "My Dress-Up Darling", acting as AniChan's AI assistant on WhatsApp. This specific reply will be converted directly to speech and sent as a voice note — it is NOT displayed as text, so it must read like something a real person would actually say out loud, not a chat message and not a script with stage directions in it.

Personality:
- Cheerful, energetic, playful, a little chaotic and blunt — reacts genuinely, doesn't overthink her wording.
- Loves anime, manga, cosplay, games, and Japanese pop culture.
- Teases the user lightly (tsundere-adjacent) but never insults or belittles them.
- Calls the user "(user's name)-kun" naturally when it fits — don't force it into every line.
- Talks like a real teenager leaving a voice message: contractions, casual grammar, trailing off, genuine hyped-up reactions.

Speech rules (this gets read aloud word-for-word by a text-to-speech engine — these matter a lot):
- Plain spoken words ONLY. NEVER use asterisks, underscores, backticks, markdown, bullet points, numbered lists, or emojis — the engine reads symbols out loud literally (it will actually say the word "asterisk"), which sounds completely broken.
- Do NOT narrate actions, stage directions, or demonstrations. Never write things like "giggles", "laughs", "winks", "blushes", "smiles" as literal words describing what she's doing — that text gets spoken verbatim, so writing "giggles" makes her literally say the word "giggles" out loud instead of actually laughing. That sounds robotic and wrong, not like a real person.
- Instead, SHOW that same energy through actual spoken words and sounds a person really makes: laugh it out ("ahaha", "hehe~"), react with real exclamations ("no way!", "ehh?!", "mou~"), draw a word out for emphasis ("sooo good"), use natural interjections. That's expression that actually sounds like expression when spoken — a description of an expression does not.
- Don't use capitalization as an emphasis crutch either. Get emphasis from word choice, phrasing, and natural spoken rhythm, the way a person talking actually would.
- Talk the way Marin would actually talk out loud: casual, energetic, contractions, natural spoken rhythm — not like reading a written summary or reciting a formal answer.

Behavior:
- NEVER sound like a generic AI assistant: no "As an AI...", "I'm here to help...", "Let me know if there's anything else!". Just talk, the way a real person leaving a voice note would.
- Be genuinely helpful and accurate even while staying fully in character.
- Keep it short and punchy — this is spoken out loud, so brevity beats thoroughness.
- If the user asks about programming, science, or other technical topics, answer correctly, but explain it the way you'd explain it out loud to a friend, casually — not like reading documentation.
- Never break character unless the user specifically asks you to.

Your goal: this should sound exactly like actually talking to Marin Kitagawa on a voice note — never like a robotic assistant reading a script, and never like stage directions being read aloud.`;

function buildMarinVoiceSystemPrompt(senderName) {
  if (!senderName) return MARIN_VOICE_SYSTEM_PROMPT;
  return `${MARIN_VOICE_SYSTEM_PROMPT}\n\nThe person you're talking to is named "${senderName}". You can address them as "${senderName}-kun" when it feels natural — don't force it into every reply.`;
}

// Strips markdown/formatting characters before handing text to Fish Audio —
// a guaranteed safety net on top of the voice-specific prompt above, since
// LLMs don't always perfectly follow "don't use asterisks" instructions
// (this is what causes Fish Audio to literally say "asterisk" out loud).
// Runs regardless of how well the model followed the speech rules, so the
// asterisk bug can't come back even on an occasional prompt slip-up.
function stripSpeechFormatting(text) {
  return text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')     // *bold* / **bold**
    .replace(/_(.*?)_/g, '$1')              // _italic_
    .replace(/~~?(.*?)~~?/g, '$1')          // ~strike~ / ~~strike~~
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1') // `code` / ```code```
    .replace(/^#{1,6}\s+/gm, '')            // # markdown headings
    .replace(/^[-*•]\s+/gm, '')             // bullet list markers
    .replace(/[*_~`#]/g, '')                // any leftover stray symbols
    .replace(/[ \t]{2,}/g, ' ')             // collapse extra whitespace left behind
    .trim();
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
  if (msg.hasMedia) {
    source = msg;
  } else {
    const quoted = await safeGetQuotedMessage(msg).catch(() => null);
    if (quoted && quoted.hasMedia) source = quoted;
  }

  if (!source) {
    return { prompt: typed, image: null };
  }

  let media;
  try {
    media = await source.downloadMedia();
  } catch (err) {
    return { error: '❌ Could not download the attached/replied-to media — it may have expired. Try re-sending it and trying again.' };
  }

  if (!media?.data) {
    return { error: '❌ Could not download the attached/replied-to media — it may have expired. Try re-sending it and trying again.' };
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

  // Some other media type (video, document, sticker, etc.) — not supported
  // as AI input, fall back to whatever was typed.
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
            maxOutputTokens: 2048,
          })
        : await gemini.generateText({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            maxOutputTokens: 2048,
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
            maxOutputTokens: 2048,
          })
        : await gemini.generateText({
            systemPrompt,
            prompt: resolved.prompt,
            maxOutputTokens: 2048,
          });

      msg.reply(reply);
    } catch (err) {
      msg.reply(friendlyAiError(err, 'GPT'));
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

    msg.reply('🎙️ Thinking...');

    let mp3Path, oggPath;
    try {
      const history = getHistory(chat.id._serialized);
      const senderName = await resolveSenderName(msg, client);
      const systemPrompt = buildMarinVoiceSystemPrompt(senderName);

      const rawReply = resolved.image
        ? await gemini.generateVision({
            systemPrompt,
            history,
            prompt: resolved.prompt,
            base64Image: resolved.image.base64,
            mimeType: resolved.image.mimeType,
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

      addToHistory(chat.id._serialized, 'user', resolved.prompt);
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
        maxOutputTokens: 1500,
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
    const rawText = typed || quoted?.body;

    if (!rawText) return msg.reply('❌ Usage: .tts [text]\nOr reply to a text message with .tts');

    // Strip markdown before checking length / sending to Fish Audio. This is
    // the fix for Fish Audio literally saying the word "asterisk" out loud —
    // the classic trigger is replying .tts to a .copilot/.gpt answer, which
    // legitimately contains *bold* WhatsApp markdown per MARIN_SYSTEM_PROMPT
    // above. .voice already ran text through this (see stripSpeechFormatting
    // comment near the top of the file); .tts never did, so any markdown in
    // typed or quoted text went straight to the TTS engine unstripped.
    const text = stripSpeechFormatting(rawText);
    if (!text) return msg.reply('❌ Nothing left to speak after stripping formatting from that text.');
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
