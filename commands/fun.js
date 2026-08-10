const { MessageMedia } = require('whatsapp-web.js');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pick, rand, mentionName, safeGetChat, safeGetQuotedMessage } = require('../utils/helpers');
const { BOT_NAME } = require('../utils/config');
const { renderMemeImage, renderAnimatedMemeFrames } = require('../utils/memeRender');

// ─── Local media helpers for .meme (image/sticker in -> image/sticker out) ───
// Same small helpers already used the same way in commands/converter.js —
// kept local here rather than shared, matching this project's existing
// pattern of each command file owning its own tiny media-plumbing helpers.
const TMP = os.tmpdir();

function tmpFile(ext) {
  return path.join(TMP, `ani-chan_meme_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

// Captures ffmpeg's full stderr (not just the tail fluent-ffmpeg puts in
// err.message) and attaches it to the rejected error as err.ffmpegStderr.
// This matters specifically for diagnosing .meme failures: fluent-ffmpeg's
// default error message is only the last line or two of ffmpeg's own
// output — usually just the generic progress summary ("frame=0 ...
// Conversion failed!") — which hides the actual decode error further up
// the log (the line that would say *why* ffmpeg produced 0 frames).
function runFfmpeg(inputPath, outputPath, outputOptions = []) {
  return new Promise((resolve, reject) => {
    const stderrLines = [];
    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('stderr', line => stderrLines.push(line))
      .on('end', resolve)
      .on('error', err => {
        err.ffmpegStderr = stderrLines.join('\n');
        reject(err);
      })
      .run();
  });
}

// Same as runFfmpeg() above, but for inputs that need flags BEFORE -i (like
// `-f concat -safe 0`) rather than just output-side options — fluent-ffmpeg
// needs .inputOptions() for that, which runFfmpeg()'s simple (inputPath,
// outputPath, outputOptions) signature has no way to express. Used only by
// the animated-sticker re-encode step below (buildAnimatedWebp).
function runFfmpegConcat(listPath, outputPath, outputOptions = []) {
  return new Promise((resolve, reject) => {
    const stderrLines = [];
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(outputOptions)
      .output(outputPath)
      .on('stderr', line => stderrLines.push(line))
      .on('end', resolve)
      .on('error', err => {
        err.ffmpegStderr = stderrLines.join('\n');
        reject(err);
      })
      .run();
  });
}

function cleanupFiles(...files) {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

function mimeBase(mime = '') {
  return mime.split(';')[0].toLowerCase();
}

// Minimal RIFF/WEBP top-level chunk walk to detect whether a webp is
// animated. Per the WebP container spec, the ANIM chunk is REQUIRED for any
// animated webp and only appears in animated webp — and it sits directly
// under the RIFF/WEBP container alongside VP8X/ANMF/EXIF/XMP (not nested
// inside another chunk), so a plain top-level scan is sufficient; no need
// to touch pixel data. This is what tells fun.js which render path to use
// (renderMemeImage's single-frame screenshot vs. renderAnimatedMemeFrames's
// full frame-by-frame pipeline) BEFORE spending any time on either one.
function isAnimatedWebp(buffer) {
  if (buffer.length < 12) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return false;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'ANIM') return true;
    offset += 8 + chunkSize + (chunkSize % 2); // RIFF chunks are padded to an even size
  }
  return false;
}

async function getMemeTargetMessage(msg) {
  if (!msg.hasQuotedMsg) return msg;
  try {
    const quoted = await safeGetQuotedMessage(msg);
    return quoted || msg;
  } catch (err) {
    console.error('meme: getMemeTargetMessage failed:', err.message);
    return 'ERROR';
  }
}

// ─── .meme source fetch (download, with retry) ─────────────────────────────
// CONFIRMED root cause of the original crash (from a real failure log, not
// a guess): ffmpeg's own "webp" decoder in this build does not support
// animated WebP's ANIM/ANMF frame chunks — it logs "skipping unsupported
// chunk: ANIM/ANMF" once per frame, then "image data not found" because it
// just discarded every chunk that actually held pixel data, leaving
// nothing to decode. That's a hard limitation of ffmpeg's own (non-libwebp)
// webp decoder, unrelated to network truncation.
//
// FIX: don't ask ffmpeg to decode animated webp at all. Chromium can (see
// utils/memeRender.js) — renderMemeImage() uses it for a single captioned
// frame, renderAnimatedMemeFrames() uses its WebCodecs ImageDecoder to
// caption every frame and keep the output animated. isAnimatedWebp() below
// tells meme() which of those two to use.
//
// The retry loop and buffer-size sanity check below stay — they're a
// separate, still-legitimate concern (Brandon's Airtel/MTN connection can
// genuinely hand back a truncated downloadMedia() result), unrelated to
// the decode issue above.
const MEME_SOURCE_RETRIES = 1; // 1 retry = 2 attempts total

async function fetchMemeSource(targetMsg) {
  let lastErr;

  for (let attempt = 0; attempt <= MEME_SOURCE_RETRIES; attempt++) {
    try {
      const media = await targetMsg.downloadMedia();
      if (!media?.data) throw new Error('downloadMedia() returned no data');

      const buffer = Buffer.from(media.data, 'base64');
      // A real WhatsApp image/sticker is never this small — a buffer this
      // tiny is a strong signal of a truncated download.
      if (buffer.length < 200) {
        throw new Error(`downloaded file looks truncated (${buffer.length} bytes)`);
      }

      const base = mimeBase(media.mimetype);
      const isSticker = base.includes('webp');
      const isImage = base.startsWith('image');

      if (!isImage) {
        const err = new Error('Reply is not an image or sticker');
        err.code = 'NOT_IMAGE';
        throw err; // no point retrying — a different file type won't change on re-download
      }

      const isAnimated = isSticker && isAnimatedWebp(buffer);

      // No ffmpeg pre-processing needed here regardless of static/animated
      // — see the comment above. Chromium handles both.
      return { buffer, mimetype: media.mimetype, isSticker, isAnimated };
    } catch (err) {
      if (err.code === 'NOT_IMAGE') throw err;

      lastErr = err;
      console.error(`meme: source-fetch attempt ${attempt + 1}/${MEME_SOURCE_RETRIES + 1} failed:`, err.message);
      if (attempt < MEME_SOURCE_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastErr;
}

// ─── Animated sticker assembly (frames -> animated webp) ───────────────────
// Takes renderAnimatedMemeFrames()'s per-frame PNGs + durations, writes them
// to disk, and re-encodes them into one animated webp via ffmpeg's concat
// demuxer (which supports arbitrary per-frame durations for an image
// sequence) + ffmpeg's libwebp ENCODER. Encoding works fine — it's only
// ffmpeg's own DECODER that can't read animated webp (see the comment on
// fetchMemeSource above); this only ever asks ffmpeg to write one.
const MAX_ANIMATED_STICKER_BYTES = 450 * 1024; // stay safely under WhatsApp's ~500KB animated-sticker cap

function buildFfconcatList(framePaths, durationsMs) {
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < framePaths.length; i++) {
    lines.push(`file '${framePaths[i].replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${(durationsMs[i] / 1000).toFixed(6)}`);
  }
  // ffmpeg's concat demuxer only applies a "duration" line to the
  // transition INTO the next file, so the last entry's duration is
  // otherwise ignored — the documented workaround is to repeat the last
  // file once more with no duration line after it.
  lines.push(`file '${framePaths[framePaths.length - 1].replace(/'/g, "'\\''")}'`);
  return lines.join('\n');
}

async function buildAnimatedWebp(frames, quality) {
  const frameDir = path.join(TMP, `ani-chan_meme_frames_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(frameDir, { recursive: true });

  const listPath = tmpFile('ffconcat');
  const webpPath = tmpFile('webp');
  const framePaths = [];

  try {
    frames.forEach((frame, i) => {
      const framePath = path.join(frameDir, `frame_${String(i).padStart(4, '0')}.png`);
      const base64 = frame.dataUrl.slice(frame.dataUrl.indexOf(',') + 1);
      fs.writeFileSync(framePath, Buffer.from(base64, 'base64'));
      framePaths.push(framePath);
    });

    fs.writeFileSync(listPath, buildFfconcatList(framePaths, frames.map(f => f.durationMs)));

    await runFfmpegConcat(listPath, webpPath, [
      '-vsync', 'vfr',
      '-vcodec', 'libwebp',
      '-vf', 'format=rgba',
      '-loop', '0',
      '-preset', 'default',
      '-q:v', String(quality),
    ]);

    return fs.readFileSync(webpPath);
  } finally {
    cleanupFiles(listPath, webpPath);
    try {
      for (const p of framePaths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      fs.rmdirSync(frameDir);
    } catch {}
  }
}

// Orchestrates the animated path end to end: decode+composite every frame,
// re-encode to animated webp, and — if the result is too large for
// WhatsApp's animated-sticker size cap — retry once at lower quality before
// giving up. Throwing here (rather than sending a broken/oversized sticker)
// is intentional: meme() below catches this and falls back to the
// guaranteed-working static output instead.
async function sendAnimatedMemeSticker(client, chat, source, topText, bottomText) {
  const { frames, totalFrames, sampledFrames } = await renderAnimatedMemeFrames(
    client,
    source.buffer,
    source.mimetype,
    { topText, bottomText }
  );

  console.log(`meme: animated sticker — composited ${sampledFrames}/${totalFrames} frames`);

  let webpBuffer = await buildAnimatedWebp(frames, 80);

  if (webpBuffer.length > MAX_ANIMATED_STICKER_BYTES) {
    console.warn(`meme: animated webp too large (${webpBuffer.length} bytes) at q=80, retrying at q=45`);
    webpBuffer = await buildAnimatedWebp(frames, 45);
  }

  if (webpBuffer.length > MAX_ANIMATED_STICKER_BYTES) {
    const err = new Error(`animated sticker still too large after quality reduction (${webpBuffer.length} bytes)`);
    err.code = 'ANIMATED_TOO_LARGE';
    throw err;
  }

  const stickerMedia = new MessageMedia('image/webp', webpBuffer.toString('base64'));
  await chat.sendMessage(stickerMedia, {
    sendMediaAsSticker: true,
    stickerName: BOT_NAME,
    stickerAuthor: 'Brandon',
  });
}

const TRUTHS = [
  "What's your most embarrassing moment?",
  "Have you ever lied to get out of trouble?",
  "What's the worst thing you've ever done?",
  "Do you have a crush on anyone in this group?",
  "What's your biggest fear?",
  "Have you ever cheated on a test?",
  "What's the most childish thing you still do?",
  "What's a secret you've never told anyone?",
];

const DARES = [
  "Send your most embarrassing selfie.",
  "Text your crush right now.",
  "Change your profile picture to whatever we choose for 24 hours.",
  "Do 20 push-ups and send a video.",
  "Call a random contact and say 'I love you.'",
  "Post an embarrassing status for 1 hour.",
  "Send a voice note singing your favorite song.",
];

const JOKES = [
  "Why don't scientists trust atoms?\nBecause they make up everything! 😂",
  "What do you call a fake noodle?\nAn impasta! 🍝",
  "Why did the scarecrow win an award?\nBecause he was outstanding in his field! 🌾",
  "I told my wife she was drawing her eyebrows too high.\nShe looked surprised.",
  "Why do programmers prefer dark mode?\nBecause light attracts bugs! 🐛",
  "I asked the librarian if they had books about paranoia.\nShe whispered: 'They're right behind you!'",
];

const WYR = [
  { a: 'Be able to fly', b: 'Be able to be invisible' },
  { a: 'Never use social media again', b: 'Never watch movies again' },
  { a: 'Always be 10 minutes late', b: 'Always be 20 minutes early' },
  { a: 'Live without music', b: 'Live without TV' },
  { a: 'Have $1M now', b: 'Have $3M in 10 years' },
  { a: 'Speak all languages', b: 'Play all instruments' },
];

const POV = [
  "POV: You're the main character in an isekai anime.",
  "POV: The group chat just went silent after you sent that.",
  "POV: Your mom walks in at the worst time.",
  "POV: You wake up and realize it was all a dream.",
  "POV: Final boss music starts playing.",
];

const SOCIAL = [
  "Rate this group from 1-10 in the replies!",
  "Who in this group would survive a zombie apocalypse?",
  "Tag someone who is always MIA.",
  "Who texts back the fastest?",
];

const RELATION_TYPES = [
  'Best Friends', 'Rivals', 'Soulmates', 'Enemies', 'Siblings', 'Master & Student',
  'Hero & Sidekick', 'Teacher & Student', 'Frenemies',
];

const DUALITY_PAIRS = [
  ['Chaotic Evil', 'Lawful Good'],
  ['Night Owl', 'Early Bird'],
  ['Introvert', 'Extrovert'],
  ['Brain', 'Muscle'],
  ['The One Who Plans', 'The One Who Does Whatever'],
];

module.exports = {
  // .gay
  async gay(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const percent = rand(0, 100);
    msg.reply(`🏳️‍🌈 *Gay Meter*\n\n${target} is *${percent}%* gay!\n${'🟪'.repeat(Math.floor(percent / 10))}${'⬛'.repeat(10 - Math.floor(percent / 10))}`);
  },

  // .lesbian
  async lesbian(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const percent = rand(0, 100);
    msg.reply(`🏳️‍🌈 *Lesbian Meter*\n\n${target} is *${percent}%* lesbian!\n${'🌸'.repeat(Math.floor(percent / 10))}${'⬛'.repeat(10 - Math.floor(percent / 10))}`);
  },

  // .simp
  async simp(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const percent = rand(0, 100);
    msg.reply(`🥺 *Simp Meter*\n\n${target} is *${percent}%* a simp!\n${'💗'.repeat(Math.floor(percent / 10))}${'⬛'.repeat(10 - Math.floor(percent / 10))}`);
  },

  // .ship [@user1] [@user2]
  async ship(client, msg, args) {
    const mentioned = await msg.getMentions();
    const contact = await msg.getContact();

    const p1 = mentioned[0] || contact;
    const p2 = mentioned[1] || contact;
    const percent = rand(0, 100);
    const heart = percent >= 70 ? '❤️' : percent >= 40 ? '🧡' : '💔';

    msg.reply(
      `💘 *Shipping*\n\n${p1.pushname} + ${p2.pushname}\n\n${heart} Compatibility: *${percent}%*\n${'❤️'.repeat(Math.floor(percent / 10))}${'🖤'.repeat(10 - Math.floor(percent / 10))}`
    );
  },

  // .skill
  async skill(client, msg, args) {
    const skills = ['Cooking', 'Gaming', 'Lying', 'Charming', 'Coding', 'Fighting', 'Sleeping', 'Drama', 'Roasting'];
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const skill = pick(skills);
    const level = rand(1, 100);
    msg.reply(`🎯 *Skill Check*\n\n${target}'s hidden skill: *${skill}*\nLevel: *${level}/100*`);
  },

  // .duality
  async duality(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const pair = pick(DUALITY_PAIRS);
    if (mentioned.length >= 2) {
      msg.reply(`☯️ *Duality*\n\n${mentioned[0].pushname}: *${pair[0]}*\n${mentioned[1].pushname}: *${pair[1]}*`);
    } else {
      msg.reply(`☯️ *Your Duality*\n\n*${pair[0]}* vs *${pair[1]}*\n\nWhich side are you on? 👀`);
    }
  },

  // .gen
  async gen(client, msg, args) {
    const gens = ['Gen Z', 'Millennial', 'Boomer', 'Alpha', 'Gen X'];
    const contact = await msg.getContact();
    const g = pick(gens);
    msg.reply(`🧬 *Generation Check*\n\n${contact.pushname}, you have the energy of a *${g}*!`);
  },

  // .pov
  async pov(client, msg, args) {
    msg.reply(`📽️ *POV*\n\n${pick(POV)}`);
  },

  // .social
  async social(client, msg, args) {
    msg.reply(`💬 *Social Game*\n\n${pick(SOCIAL)}`);
  },

  // .relation
  async relation(client, msg, args) {
    const mentioned = await msg.getMentions();
    if (mentioned.length < 2) return msg.reply('❌ Tag two people! .relation @user1 @user2');
    const rel = pick(RELATION_TYPES);
    msg.reply(`🔗 *Relationship*\n\n${mentioned[0].pushname} & ${mentioned[1].pushname} are...\n\n*${rel}* 🌟`);
  },

  // .pp
  async pp(client, msg, args) {
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? mentioned[0].pushname : contact.pushname;
    const size = rand(1, 25);
    const bar = '8' + '='.repeat(size) + 'D';
    msg.reply(`📏 *PP Meter*\n\n${target}'s pp:\n${bar}\nSize: *${size} cm* 😂`);
  },

  // .wouldyourather
  async wouldyourather(client, msg, args) {
    const q = pick(WYR);
    msg.reply(`🤔 *Would You Rather?*\n\n🅰️ ${q.a}\n\nor\n\n🅱️ ${q.b}\n\nVote A or B!`);
  },

  // .joke
  async joke(client, msg, args) {
    msg.reply(`😂 *Joke*\n\n${pick(JOKES)}`);
  },

  // .truth
  async truth(client, msg, args) {
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'someone';
    msg.reply(`🔍 *Truth for ${target}*\n\n${pick(TRUTHS)}`);
  },

  // .dare
  async dare(client, msg, args) {
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'someone';
    msg.reply(`🎯 *Dare for ${target}*\n\n${pick(DARES)}`);
  },

  // .td — random truth or dare
  async td(client, msg, args) {
    const isTruth = Math.random() > 0.5;
    const mentioned = await msg.getMentions();
    const target = mentioned.length ? `@${mentioned[0].number}` : 'you';

    if (isTruth) {
      msg.reply(`🎲 *Truth for ${target}*\n\n🔍 ${pick(TRUTHS)}`);
    } else {
      msg.reply(`🎲 *Dare for ${target}*\n\n🎯 ${pick(DARES)}`);
    }
  },

  // .uno — start a silly uno card
  async uno(client, msg, args) {
    const colors = ['🔴', '🔵', '🟢', '🟡'];
    const values = ['1','2','3','4','5','6','7','8','9','Skip','Reverse','+2'];
    const card = `${pick(colors)} ${pick(values)}`;
    const special = Math.random() > 0.8 ? ' 🃏 *+4 Wild!*' : '';
    const contact = await msg.getContact();
    msg.reply(`🎴 *UNO!*\n\n${contact.pushname} plays: *${card}*${special}\n\nNext player's turn!`);
  },

  // .meme <text>  |  .meme <top text> | <bottom text>
  // Reply to a sticker or an image. Bakes bold white/black-outline caption
  // text onto it, classic meme-generator style — a sticker in gets a
  // sticker back, an image in gets an image back. Use "|" to split top and
  // bottom captions; with no "|" the whole text is one caption at the
  // bottom (matches the single-caption format, e.g. the "type shii" style).
  async meme(client, msg, args) {
    const rawText = args.join(' ').trim();
    if (!rawText) {
      return msg.reply('❌ Usage: .meme <text>  (reply to a sticker or image)\nTip: use "|" for top + bottom text — .meme top text | bottom text');
    }

    const targetMsg = await getMemeTargetMessage(msg);
    if (targetMsg === 'ERROR') return msg.reply('⚠️ WhatsApp connection hiccup — please try again in a moment.');
    if (!targetMsg.hasMedia) {
      return msg.reply('❌ Reply to a sticker or image with .meme <text>');
    }

    let topText = '';
    let bottomText = rawText;
    if (rawText.includes('|')) {
      const parts = rawText.split('|');
      topText = parts[0].trim();
      bottomText = parts.slice(1).join('|').trim();
    }

    msg.reply('🎨 Captioning...');

    // Download with retry — see fetchMemeSource()'s comment above.
    let source;
    try {
      source = await fetchMemeSource(targetMsg);
    } catch (err) {
      if (err.code === 'NOT_IMAGE') {
        return msg.reply('❌ .meme only works on images or stickers right now — reply to one of those.');
      }
      console.error('meme: could not download source image after retrying:', err.message);
      return msg.reply(
        '❌ Could not download that sticker/image after retrying — check your connection and try again.'
      );
    }

    const chat = await safeGetChat(msg);
    if (!chat) return;

    // Animated stickers: try the full frame-by-frame pipeline first. If
    // ANYTHING in it fails (decode, compositing, ffmpeg concat encode, or
    // the result being too large to send), fall back to the
    // guaranteed-working static single-frame output below instead of
    // failing the command outright — see renderAnimatedMemeFrames()'s
    // comment in utils/memeRender.js for why this fallback exists.
    if (source.isAnimated) {
      try {
        await sendAnimatedMemeSticker(client, chat, source, topText, bottomText);
        return;
      } catch (err) {
        console.error(
          'meme: animated pipeline failed, falling back to static sticker:',
          err.message,
          err.ffmpegStderr ? `\nffmpeg stderr:\n${err.ffmpegStderr}` : ''
        );
        msg.reply('⚠️ Could not keep this one animated — sending a static version instead...');
      }
    }

    let pngPath = null;
    let webpPath = null;

    try {
      const composedPng = await renderMemeImage(client, source.buffer, source.mimetype, { topText, bottomText });

      if (source.isSticker) {
        pngPath = tmpFile('png');
        webpPath = tmpFile('webp');
        fs.writeFileSync(pngPath, composedPng);
        await runFfmpeg(pngPath, webpPath, [
          '-vcodec', 'libwebp',
          '-vf', 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba',
          '-preset', 'default',
          '-q:v', '80',
        ]);
        const stickerMedia = new MessageMedia('image/webp', fs.readFileSync(webpPath).toString('base64'));
        await chat.sendMessage(stickerMedia, {
          sendMediaAsSticker: true,
          stickerName: BOT_NAME,
          stickerAuthor: 'Brandon',
        });
      } else {
        const outMedia = new MessageMedia('image/png', composedPng.toString('base64'));
        await chat.sendMessage(outMedia);
      }
    } catch (err) {
      console.error(
        'meme command failed:',
        err.message,
        err.ffmpegStderr ? `\nffmpeg stderr:\n${err.ffmpegStderr}` : ''
      );
      msg.reply('❌ Failed to create meme: ' + err.message);
    } finally {
      cleanupFiles(pngPath, webpPath);
    }
  },
};
