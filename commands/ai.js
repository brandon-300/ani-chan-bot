const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

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

// ─── Copilot (GPT-4 via OpenAI) ──────────────────────────────────────────────
module.exports = {
  // .copilot [prompt] — full context-aware AI chat
  async copilot(client, msg, args) {
    const prompt = args.join(' ');
    if (!prompt) return msg.reply('❌ Usage: .copilot [your message]');

    const chat = await msg.getChat();
    msg.reply('🤖 Thinking...');

    try {
      const history = getHistory(chat.id._serialized);
      addToHistory(chat.id._serialized, 'user', prompt);

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are Ani-Chan Bot, a helpful, witty, and friendly WhatsApp bot assistant. Keep responses concise and WhatsApp-friendly (no markdown headers, use *bold* for emphasis).`,
          },
          ...history,
        ],
        max_tokens: 800,
      });

      const reply = response.choices[0].message.content;
      addToHistory(chat.id._serialized, 'assistant', reply);
      msg.reply(reply);
    } catch (err) {
      msg.reply('❌ Copilot failed. Check your OpenAI API key.');
    }
  },

  // .gpt [prompt] — single-turn GPT (no history)
  async gpt(client, msg, args) {
    const prompt = args.join(' ');
    if (!prompt) return msg.reply('❌ Usage: .gpt [your question]');

    msg.reply('💭 Processing...');
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. Keep responses short and WhatsApp-friendly.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 600,
      });

      msg.reply(response.choices[0].message.content);
    } catch (err) {
      msg.reply('❌ GPT failed. Check your OpenAI API key.');
    }
  },

  // .imagine [prompt] — AI image generation with DALL-E 3
  async imagine(client, msg, args) {
    const prompt = args.join(' ');
    if (!prompt) return msg.reply('❌ Usage: .imagine [image description]');

    msg.reply('🎨 Generating image...');
    try {
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
      });

      const imageUrl = response.data[0].url;
      const media = await MessageMedia.fromUrl(imageUrl);
      const chat = await msg.getChat();
      await chat.sendMessage(media, { caption: `🎨 *Imagine:* ${prompt}` });
    } catch (err) {
      if (err.code === 'content_policy_violation') {
        msg.reply('❌ Prompt violates content policy. Try a different description.');
      } else {
        msg.reply('❌ Image generation failed. Check your OpenAI API key.');
      }
    }
  },

  // .upscale — upscale a replied-to image using RapidAPI
  async upscale(client, msg, args) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image with .upscale');

    msg.reply('⬆️ Upscaling image...');
    try {
      const media = await targetMsg.downloadMedia();
      const imageBuffer = Buffer.from(media.data, 'base64');

      // Using AI Image Upscaler on RapidAPI
      const FormData = require('form-data');
      const form = new FormData();
      form.append('image', imageBuffer, { filename: 'image.jpg', contentType: media.mimetype });
      form.append('scale', '2');

      const res = await axios.post(
        'https://ai-image-upscaler.p.rapidapi.com/upscale',
        form,
        {
          headers: {
            ...form.getHeaders(),
            'X-RapidAPI-Key': RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'ai-image-upscaler.p.rapidapi.com',
          },
          responseType: 'arraybuffer',
        }
      );

      const upscaledMedia = new MessageMedia('image/jpeg', Buffer.from(res.data).toString('base64'));
      const chat = await msg.getChat();
      await chat.sendMessage(upscaledMedia, { caption: '✅ Image upscaled 2x!' });
    } catch (err) {
      msg.reply('❌ Upscale failed. Make sure you replied to an image and your RapidAPI key is valid.');
    }
  },

  // .translate [lang] [text] — translate text
  async translate(client, msg, args) {
    const lang = args[0];
    const text = args.slice(1).join(' ');

    // Check if replying to a message
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const toTranslate = text || quoted?.body;

    if (!lang || !toTranslate) {
      return msg.reply('❌ Usage: .translate [language] [text]\nOr reply to a message with .translate [language]');
    }

    msg.reply('🌍 Translating...');
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Translate the following text to ${lang}. Return ONLY the translated text, nothing else.`,
          },
          { role: 'user', content: toTranslate },
        ],
        max_tokens: 500,
      });

      const translated = response.choices[0].message.content;
      msg.reply(`🌍 *Translation (${lang})*\n\n${translated}`);
    } catch (err) {
      msg.reply('❌ Translation failed.');
    }
  },

  // .transcribe — transcribe a voice note using Whisper
  async transcribe(client, msg, args) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a voice note with .transcribe');

    msg.reply('🎙️ Transcribing...');
    try {
      const media = await targetMsg.downloadMedia();
      if (!media.mimetype.includes('audio') && !media.mimetype.includes('ogg')) {
        return msg.reply('❌ Please reply to a voice note or audio file.');
      }

      const audioBuffer = Buffer.from(media.data, 'base64');

      // Use OpenAI Whisper
      const { Readable } = require('stream');
      const FormData = require('form-data');
      const form = new FormData();

      const stream = Readable.from(audioBuffer);
      stream.path = 'audio.ogg';
      form.append('file', stream, { filename: 'audio.ogg', contentType: media.mimetype });
      form.append('model', 'whisper-1');

      const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      });

      msg.reply(`🎙️ *Transcription*\n\n${res.data.text}`);
    } catch (err) {
      msg.reply('❌ Transcription failed. Make sure you replied to a voice note.');
    }
  },
};
