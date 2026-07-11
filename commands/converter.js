const { MessageMedia } = require('whatsapp-web.js');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = os.tmpdir();

function tmpFile(ext) {
  return path.join(TMP, `ani-chan_${Date.now()}.${ext}`);
}

module.exports = {
  // .sticker — convert image/gif/video to sticker
  async sticker(client, msg, args) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Send or reply to an image/gif/video with .sticker');

    msg.reply('🎨 Creating sticker...');
    try {
      const media = await targetMsg.downloadMedia();
      const isVideo = media.mimetype.includes('video') || media.mimetype.includes('gif');

      if (isVideo) {
        // Video/GIF → animated webp sticker
        const inputPath = tmpFile('mp4');
        const outputPath = tmpFile('webp');

        fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .outputOptions([
              '-vcodec libwebp',
              '-vf scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0.0,split[a][b];[a]palettegen=reserve_transparent=on:transparency_color=ffffff[p];[b][p]paletteuse',
              '-loop 0',
              '-ss 0',
              '-t 00:00:05',
              '-preset default',
              '-an',
              '-vsync 0',
            ])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        const stickerData = fs.readFileSync(outputPath).toString('base64');
        const stickerMedia = new MessageMedia('image/webp', stickerData);
        const chat = await msg.getChat();
        await chat.sendMessage(stickerMedia, { sendMediaAsSticker: true });

        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      } else {
        // Image → webp sticker
        const imgBuffer = Buffer.from(media.data, 'base64');
        const webpBuffer = await sharp(imgBuffer)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 80 })
          .toBuffer();

        const stickerMedia = new MessageMedia('image/webp', webpBuffer.toString('base64'));
        const chat = await msg.getChat();
        await chat.sendMessage(stickerMedia, { sendMediaAsSticker: true });
      }
    } catch (err) {
      msg.reply('❌ Sticker creation failed: ' + err.message);
    }
  },

  // .take — save sticker metadata (pack name, author)
  async take(client, msg, args) {
    const packName = args[0] || 'Ani-Chan Bot';
    const authorName = args[1] || 'Riz';

    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a sticker with .take [pack] [author]');

    try {
      const media = await targetMsg.downloadMedia();
      if (!media.mimetype.includes('webp')) return msg.reply('❌ Please reply to a sticker.');

      const chat = await msg.getChat();
      await chat.sendMessage(media, {
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
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a sticker with .toimg');

    try {
      const media = await targetMsg.downloadMedia();
      const buffer = Buffer.from(media.data, 'base64');

      const pngBuffer = await sharp(buffer).png().toBuffer();
      const imgMedia = new MessageMedia('image/png', pngBuffer.toString('base64'));

      const chat = await msg.getChat();
      await chat.sendMessage(imgMedia, { caption: '✅ Converted to image!' });
    } catch (err) {
      msg.reply('❌ Conversion failed.');
    }
  },

  // .tovid — convert gif to video
  async tovid(client, msg, args) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to a gif/image with .tovid');

    msg.reply('🎬 Converting to video...');
    try {
      const media = await targetMsg.downloadMedia();
      const inputPath = tmpFile('gif');
      const outputPath = tmpFile('mp4');

      fs.writeFileSync(inputPath, Buffer.from(media.data, 'base64'));

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions(['-movflags faststart', '-pix_fmt yuv420p', '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      const videoData = fs.readFileSync(outputPath).toString('base64');
      const videoMedia = new MessageMedia('video/mp4', videoData);
      const chat = await msg.getChat();
      await chat.sendMessage(videoMedia, { caption: '✅ Converted to video!' });

      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch (err) {
      msg.reply('❌ Conversion failed: ' + err.message);
    }
  },

  // .rotate [degrees] — rotate an image
  async rotate(client, msg, args) {
    const degrees = parseInt(args[0]) || 90;
    const quoted = await msg.getQuotedMessage().catch(() => null);
    const targetMsg = quoted || msg;

    if (!targetMsg.hasMedia) return msg.reply('❌ Reply to an image with .rotate [degrees]');
    if (![90, 180, 270].includes(degrees)) return msg.reply('❌ Degrees must be 90, 180, or 270.');

    try {
      const media = await targetMsg.downloadMedia();
      const buffer = Buffer.from(media.data, 'base64');

      const rotated = await sharp(buffer).rotate(degrees).toBuffer();
      const rotatedMedia = new MessageMedia('image/jpeg', rotated.toString('base64'));

      const chat = await msg.getChat();
      await chat.sendMessage(rotatedMedia, { caption: `🔄 Rotated ${degrees}°` });
    } catch (err) {
      msg.reply('❌ Rotation failed.');
    }
  },
};
