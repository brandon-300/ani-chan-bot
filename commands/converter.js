const { MessageMedia } = require('whatsapp-web.js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeGetQuotedMessage } = require('../utils/helpers');
const { BOT_NAME } = require('../utils/config');

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

function mimeBase(mime = '') {
  return mime.split(';')[0].toLowerCase();
}

function mimeToExt(mime = '') {
  const m = mimeBase(mime);
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpg',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'application/pdf': 'pdf',
  };
  return map[m] || 'bin';
}

async function getTargetMessage(msg) {
  // hasQuotedMsg is a synchronous flag — no network round trip needed to know
  // whether a reply exists at all.
  if (!msg.hasQuotedMsg) return msg;

  try {
    const quoted = await safeGetQuotedMessage(msg);
    return quoted || msg;
  } catch (err) {
    console.error('getTargetMessage: quoted message fetch failed:', err.message);
    return 'ERROR';
  }
}

async function uploadTo0x0(buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);

  const res = await fetch('https://0x0.st', {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: HTTP ${res.status}`);
  }

  const text = (await res.text()).trim();
  if (!text) throw new Error('Upload failed: empty response');
  return text;
}

module.exports = {
  // .sticker — convert image/gif/video to sticker
  async sticker(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");

    if (!targetMsg.hasMedia) {
      return msg.reply('❌ Send or reply to an image/gif/video with .sticker');
    }

    msg.reply('🎨 Creating sticker...');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputExt = mimeToExt(media.mimetype);
    const inputPath = tmpFile(inputExt);
    const outputPath = tmpFile('webp');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));
      const isVideo = mimeBase(media.mimetype).startsWith('video') || mimeBase(media.mimetype).includes('gif');

      if (isVideo) {
        await runFfmpeg(inputPath, outputPath, [
          '-vcodec', 'libwebp',
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
          '-loop', '0',
          '-ss', '0',
          '-t', '00:00:05',
          '-preset', 'default',
          '-an',
          '-vsync', '0',
          '-q:v', '80',
        ]);
      } else {
        await runFfmpeg(inputPath, outputPath, [
          '-vcodec', 'libwebp',
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
          '-loop', '0',
          '-preset', 'default',
          '-an',
          '-vsync', '0',
          '-q:v', '80',
        ]);
      }

      const stickerData = fs.readFileSync(outputPath).toString('base64');
      const stickerMedia = new MessageMedia('image/webp', stickerData);
      // msg.reply() (not chat.sendMessage()) so the sticker appears as a
      // quoted reply under the triggering .sticker command — same fix
      // already applied to the game board sends (chess/ttt/c4/battle).
      await msg.reply(stickerMedia, undefined, {
        sendMediaAsSticker: true,
        stickerName: BOT_NAME,
        stickerAuthor: 'Brandon',
      });
    } catch (err) {
      msg.reply('❌ Sticker creation failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .take — save sticker metadata (pack name, author)
  async take(client, msg, args) {
    const packName = args[0] || BOT_NAME;
    const authorName = args[1] || 'Brandon';

    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a sticker with .take [pack] [author]');

    try {
      const media = await targetMsg.downloadMedia();
      if (!mimeBase(media.mimetype).includes('webp')) {
        return msg.reply('❌ Please reply to a sticker.');
      }

      await msg.reply(media, undefined, {
        sendMediaAsSticker: true,
        stickerName: packName,
        stickerAuthor: authorName,
      });

      msg.reply(`✅ Sticker saved!\nPack: ${packName}\nAuthor: ${authorName}`);
    } catch (err) {
      msg.reply('❌ Failed to take sticker.');
    }
  },

  // .toimg — convert sticker/webp to image
  async toimg(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a sticker with .toimg');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('png');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      await runFfmpeg(inputPath, outputPath, [
        '-frames:v', '1',
      ]);

      const pngBuffer = fs.readFileSync(outputPath);
      const imgMedia = new MessageMedia('image/png', pngBuffer.toString('base64'));

      await msg.reply(imgMedia, undefined, { caption: '✅ Converted to image!' });
    } catch (err) {
      msg.reply('❌ Conversion failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .tovid — convert gif/image/video to video
  async tovid(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a gif/image/video with .tovid');

    msg.reply('🎬 Converting to video...');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('mp4');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      const isImage = mimeBase(media.mimetype).startsWith('image') && !mimeBase(media.mimetype).includes('gif');
      const outputOptions = isImage
        ? [
            '-loop', '1',
            '-t', '5',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
            '-movflags', 'faststart',
          ]
        : [
            '-movflags', 'faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          ];

      await runFfmpeg(inputPath, outputPath, outputOptions);

      const videoData = fs.readFileSync(outputPath).toString('base64');
      const videoMedia = new MessageMedia('video/mp4', videoData);
      await msg.reply(videoMedia, undefined, { caption: '✅ Converted to video!' });
    } catch (err) {
      msg.reply('❌ Conversion failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .rotate [degrees] — rotate an image
  async rotate(client, msg, args) {
    const degrees = parseInt(args[0], 10) || 90;
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image with .rotate [degrees]');
    if (![90, 180, 270].includes(degrees)) return msg.reply('❌ Degrees must be 90, 180, or 270.');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('png');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      let vf = '';
      if (degrees === 90) vf = 'transpose=1';
      if (degrees === 180) vf = 'hflip,vflip';
      if (degrees === 270) vf = 'transpose=2';

      await runFfmpeg(inputPath, outputPath, [
        '-vf', vf,
        '-frames:v', '1',
      ]);

      const rotated = fs.readFileSync(outputPath);
      const rotatedMedia = new MessageMedia('image/png', rotated.toString('base64'));

      await msg.reply(rotatedMedia, undefined, { caption: `🔄 Rotated ${degrees}°` });
    } catch (err) {
      msg.reply('❌ Rotation failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .tomp3 — extract audio from video/voice note
  async tomp3(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a video/audio with .tomp3');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('mp3');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      await runFfmpeg(inputPath, outputPath, [
        '-vn',
        '-c:a', 'libmp3lame',
        '-q:a', '2',
      ]);

      const audioData = fs.readFileSync(outputPath).toString('base64');
      const audioMedia = new MessageMedia('audio/mpeg', audioData);
      await msg.reply(audioMedia, undefined, { sendAudioAsVoice: false });
    } catch (err) {
      msg.reply('❌ MP3 conversion failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .tovn — convert audio to voice note
  async tovn(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an audio/video with .tovn');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('ogg');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      await runFfmpeg(inputPath, outputPath, [
        '-vn',
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-vbr', 'on',
        '-f', 'ogg',
      ]);

      const voiceData = fs.readFileSync(outputPath).toString('base64');
      const voiceMedia = new MessageMedia('audio/ogg', voiceData);
      await msg.reply(voiceMedia, undefined, { sendAudioAsVoice: true });
    } catch (err) {
      msg.reply('❌ Voice note conversion failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .flip — horizontal flip
  async flip(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image/video with .flip');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('png');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      await runFfmpeg(inputPath, outputPath, [
        '-vf', 'hflip',
        '-frames:v', '1',
      ]);

      const out = fs.readFileSync(outputPath);
      const outMedia = new MessageMedia('image/png', out.toString('base64'));
      await msg.reply(outMedia, undefined, { caption: '✅ Flipped image!' });
    } catch (err) {
      msg.reply('❌ Flip failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .resize width [height] — resize an image to exact pixel dimensions
  // (NOT a percentage — see MIN_DIMENSION guard below)
  async resize(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image/video with .resize width [height] (in pixels)');

    const MIN_DIMENSION = 100;

    const width = parseInt(args[0], 10);
    const height = args[1] ? parseInt(args[1], 10) : -1;

    if (!width || width <= 0) {
      return msg.reply('❌ Usage: .resize width [height] — both are *pixel* values, not a percentage.\nExample: .resize 800 600');
    }

    // .resize has always taken literal pixel dimensions, not percentages.
    // Someone typing e.g. "40 50" expecting a 40%/50% scale would otherwise
    // silently get a ~28x50px image with no explanation — reject clearly
    // instead of producing a near-unusable result.
    if (width < MIN_DIMENSION || (height > 0 && height < MIN_DIMENSION)) {
      return msg.reply(
        `❌ ${width}${height > 0 ? `x${height}` : ''} is too small — .resize takes *pixel* dimensions, not a percentage.\n` +
        `💡 Try something like .resize 800 600, or just .resize 800 to scale by width only (height auto-scales to match).`
      );
    }

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    const inputPath = tmpFile(mimeToExt(media.mimetype));
    const outputPath = tmpFile('png');

    try {
      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      // With both width and height given: scale UP to cover the target box
      // (force_original_aspect_ratio=increase), then center-crop down to
      // exactly width x height. This guarantees the output really is the
      // requested size, with no stretching/distortion — the previous
      // "decrease" mode only fit the image inside the box and could return
      // a smaller, differently-shaped result when the aspect ratios didn't
      // match (e.g. .resize 640 360 on a portrait photo).
      // With width only (no height arg): classic aspect-preserving scale,
      // height auto-follows — there's no target box to crop to.
      const vf = height > 0
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:-1`;

      await runFfmpeg(inputPath, outputPath, [
        '-vf', vf,
        '-frames:v', '1',
      ]);

      const out = fs.readFileSync(outputPath);
      const outMedia = new MessageMedia('image/png', out.toString('base64'));
      await msg.reply(outMedia, undefined, { caption: `✅ Resized to ${width}${height > 0 ? `x${height}` : ''}` });
    } catch (err) {
      msg.reply('❌ Resize failed: ' + err.message);
    } finally {
      cleanup(inputPath, outputPath);
    }
  },

  // .tourl — upload media and return a direct link
  async tourl(client, msg, args) {
    const targetMsg = await getTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply("⚠️ WhatsApp connection hiccup — please try again in a moment.");
    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to any media with .tourl');

    const media = await targetMsg.downloadMedia().catch(() => null);
    if (!media) return msg.reply('❌ Failed to download media.');

    try {
      const buffer = Buffer.from(media.data, 'base64');
      const filename = `ani-chan_${Date.now()}.${mimeToExt(media.mimetype)}`;
      const url = await uploadTo0x0(buffer, filename);

      await msg.reply(`✅ Uploaded:\n${url}`);
    } catch (err) {
      msg.reply('❌ Upload failed: ' + err.message);
    }
  },
};
