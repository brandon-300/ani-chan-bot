// Renders user-supplied caption text onto a replied image or sticker.
//
// Why Puppeteer instead of a new image library: this project deliberately
// has no canvas/sharp/jimp dependency — sharp already failed to install as
// a native binary on this exact Termux/Android setup (see the note at the
// top of commands/games/chessBoardImage.js). Good-looking caption text
// (real font metrics, word-wrap, a clean stroke outline) needs an actual
// text layout engine, and there's already one running on the phone that
// costs nothing extra to reuse: the same Chromium instance whatsapp-web.js
// keeps open for the WhatsApp Web session itself, exposed as
// client.pupBrowser. Opening a second, throwaway page in that
// already-running browser to render some HTML/CSS and screenshot it needs
// zero new npm installs and zero extra browser launches — just a new tab,
// closed again as soon as this is done with it.
//
// This module only does the rendering (image + text -> PNG buffer). Sticker
// vs. plain-image output handling (webp conversion, sendMediaAsSticker,
// etc.) stays in commands/fun.js, the same way the webp<->png ffmpeg
// conversions already live in commands/converter.js rather than here.

const MAX_DIMENSION = 640; // cap the long edge — keeps the screenshot fast/light on a phone-class CPU

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {import('whatsapp-web.js').Client} client
 * @param {Buffer} imageBuffer - raw source image bytes (any format Chromium's <img> can decode: png/jpg/webp/gif)
 * @param {string} mimetype - e.g. 'image/webp'
 * @param {{ topText?: string, bottomText?: string }} captions
 * @returns {Promise<Buffer>} PNG buffer of the composed image, same aspect ratio as the source
 */
async function renderMemeImage(client, imageBuffer, mimetype, captions = {}) {
  if (!client.pupBrowser) {
    throw new Error('WhatsApp browser session is not ready yet — try again in a moment.');
  }

  const topText = (captions.topText || '').trim();
  const bottomText = (captions.bottomText || '').trim();
  if (!topText && !bottomText) {
    throw new Error('renderMemeImage: no caption text provided.');
  }

  const dataUri = `data:${mimetype};base64,${imageBuffer.toString('base64')}`;
  const page = await client.pupBrowser.newPage();

  try {
    // Phase 1: load just the image (generous viewport) to measure its
    // natural pixel size — we don't know it up front since it came from
    // WhatsApp media, not a file we can stat.
    await page.setViewport({ width: MAX_DIMENSION, height: MAX_DIMENSION, deviceScaleFactor: 1 });
    await page.setContent(
      `<!DOCTYPE html><html><body style="margin:0"><img id="src" src="${dataUri}"></body></html>`,
      { waitUntil: 'load' }
    );
    const natural = await page.evaluate(() => {
      const img = document.getElementById('src');
      return { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
    });

    if (!natural.w || !natural.h) {
      throw new Error('Could not read the image dimensions — the source media may be corrupt.');
    }

    const scale = Math.min(1, MAX_DIMENSION / Math.max(natural.w, natural.h));
    const width = Math.max(1, Math.round(natural.w * scale));
    const height = Math.max(1, Math.round(natural.h * scale));

    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Phase 2: the real content — image plus caption overlay(s), sized to
    // the now-known viewport.
    const html = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  .wrap { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; }
  .wrap img { width: ${width}px; height: ${height}px; display: block; object-fit: cover; }
  .cap {
    position: absolute;
    left: 4%;
    right: 4%;
    text-align: center;
    font-family: Arial, Helvetica, sans-serif;
    font-weight: 900;
    color: #fff;
    -webkit-text-stroke: 1px #000;
    paint-order: stroke fill;
    text-shadow: 0 0 6px rgba(0,0,0,.35);
    line-height: 1.05;
    word-wrap: break-word;
  }
  .cap.top { top: 3%; }
  .cap.bottom { bottom: 3%; }
</style>
</head>
<body>
  <div class="wrap">
    <img src="${dataUri}">
    ${topText ? `<div class="cap top" id="capTop">${escapeHtml(topText)}</div>` : ''}
    ${bottomText ? `<div class="cap bottom" id="capBottom">${escapeHtml(bottomText)}</div>` : ''}
  </div>
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'load' });

    // Auto-shrink each caption to fit inside the image, all in one in-page
    // pass (cheap DOM measurements, no extra Node<->browser round trips).
    await page.evaluate((w, h) => {
      function fitCaption(el) {
        if (!el) return;
        let size = Math.round(w * 0.14);
        const minSize = Math.max(8, Math.round(w * 0.02));
        el.style.fontSize = size + 'px';
        el.style.webkitTextStroke = Math.max(1, Math.round(size / 14)) + 'px #000';
        let guard = 0;
        while (
          (el.scrollWidth > el.clientWidth || el.scrollHeight > h * 0.5) &&
          size > minSize &&
          guard < 60
        ) {
          size = Math.max(minSize, Math.floor(size * 0.92));
          el.style.fontSize = size + 'px';
          el.style.webkitTextStroke = Math.max(1, Math.round(size / 14)) + 'px #000';
          guard++;
        }
      }
      fitCaption(document.getElementById('capTop'));
      fitCaption(document.getElementById('capBottom'));
    }, width, height);

    return await page.screenshot({ type: 'png', omitBackground: true });
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Animated sticker captioning ────────────────────────────────────────────
// Used when the source is an ANIMATED webp and the user wants the output to
// stay animated (rather than renderMemeImage()'s single-frame screenshot).
// ffmpeg's own webp decoder can't read animated WebP frame data at all (see
// commands/fun.js's fetchMemeSource comment for the confirmed log evidence)
// — but Chromium's WebCodecs ImageDecoder API can, since browsers need full
// animated-webp support for ordinary <img> tags on the web. This decodes
// every frame in ONE page session (not one Puppeteer round-trip per frame),
// draws the same caption styling renderMemeImage() uses onto each one, and
// hands back { frames: [{ dataUrl, durationMs }], totalFrames, sampledFrames }
// for commands/fun.js to write out and re-encode into an animated webp via
// ffmpeg's concat demuxer (ffmpeg's libwebp ENCODER works fine — it's only
// ffmpeg's own decoder that can't read animated webp, unrelated systems).
//
// UNTESTED against the real device: this is new, more involved code (the
// WebCodecs ImageDecoder API + an SVG-foreignObject trick to rasterize the
// DOM caption once and stamp it onto every decoded frame) that I can't run
// against Termux/Puppeteer/WhatsApp from here. commands/fun.js wraps this in
// a try/catch and falls back to the guaranteed-working static output
// (renderMemeImage) if anything here throws, so a bug in this function
// degrades to "static sticker" rather than breaking .meme outright — but
// please test with one small animated sticker first and share the pm2 logs
// either way so this can be corrected quickly if something's off.
const STICKER_SIZE = 512; // matches the fixed size the existing static-sticker output already encodes to
const MAX_ANIMATED_FRAMES = 40; // bounds worst-case runtime on a phone-class CPU; sampled evenly if the source has more
const MIN_FRAME_DURATION_MS = 20; // guards against a missing/zero per-frame duration producing an absurdly fast flicker

/**
 * @param {import('whatsapp-web.js').Client} client
 * @param {Buffer} imageBuffer - raw animated webp bytes
 * @param {string} mimetype - e.g. 'image/webp'
 * @param {{ topText?: string, bottomText?: string }} captions
 * @returns {Promise<{ frames: Array<{dataUrl: string, durationMs: number}>, totalFrames: number, sampledFrames: number }>}
 */
async function renderAnimatedMemeFrames(client, imageBuffer, mimetype, captions = {}) {
  if (!client.pupBrowser) {
    throw new Error('WhatsApp browser session is not ready yet — try again in a moment.');
  }

  const topText = (captions.topText || '').trim();
  const bottomText = (captions.bottomText || '').trim();
  if (!topText && !bottomText) {
    throw new Error('renderAnimatedMemeFrames: no caption text provided.');
  }

  const page = await client.pupBrowser.newPage();

  try {
    const base64Source = imageBuffer.toString('base64');

    const result = await page.evaluate(
      async (base64Source, mimetype, topText, bottomText, size, maxFrames, minFrameDurationMs) => {
        function b64ToBytes(b64) {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes;
        }

        if (typeof ImageDecoder === 'undefined') {
          throw new Error('ImageDecoder API is not available in this Chromium build');
        }

        // 1) Build the caption layer ONCE — same text/position/auto-fit
        // logic as renderMemeImage()'s CSS-based captions — then rasterize
        // it to its own transparent canvas via an SVG foreignObject. That
        // lets every animation frame reuse it with a single drawImage()
        // instead of re-running DOM text layout 40 times.
        const wrap = document.createElement('div');
        wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
        wrap.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent;`;

        function makeCap(text, isTop) {
          const el = document.createElement('div');
          el.textContent = text;
          el.style.cssText = [
            'position:absolute', 'left:4%', 'right:4%', 'text-align:center',
            'font-family:Arial,Helvetica,sans-serif', 'font-weight:900',
            'color:#fff', '-webkit-text-stroke:1px #000', 'paint-order:stroke fill',
            'text-shadow:0 0 6px rgba(0,0,0,.35)', 'line-height:1.05', 'word-wrap:break-word',
            isTop ? 'top:3%' : 'bottom:3%',
          ].join(';');
          return el;
        }

        let capTop = null;
        let capBottom = null;
        if (topText) { capTop = makeCap(topText, true); wrap.appendChild(capTop); }
        if (bottomText) { capBottom = makeCap(bottomText, false); wrap.appendChild(capBottom); }
        document.body.appendChild(wrap);

        function fitCaption(el) {
          if (!el) return;
          let fontSize = Math.round(size * 0.14);
          const minSize = Math.max(8, Math.round(size * 0.02));
          el.style.fontSize = fontSize + 'px';
          el.style.webkitTextStroke = Math.max(1, Math.round(fontSize / 14)) + 'px #000';
          let guard = 0;
          while (
            (el.scrollWidth > el.clientWidth || el.scrollHeight > size * 0.5) &&
            fontSize > minSize &&
            guard < 60
          ) {
            fontSize = Math.max(minSize, Math.floor(fontSize * 0.92));
            el.style.fontSize = fontSize + 'px';
            el.style.webkitTextStroke = Math.max(1, Math.round(fontSize / 14)) + 'px #000';
            guard++;
          }
        }
        fitCaption(capTop);
        fitCaption(capBottom);

        const capCanvas = document.createElement('canvas');
        capCanvas.width = size;
        capCanvas.height = size;
        const capCtx = capCanvas.getContext('2d');

        const xml = new XMLSerializer().serializeToString(wrap);
        const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
        const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgMarkup);

        const capImg = new Image();
        await new Promise((resolve, reject) => {
          capImg.onload = resolve;
          capImg.onerror = () => reject(new Error('Failed to rasterize caption layer (SVG foreignObject)'));
          capImg.src = svgUrl;
        });
        capCtx.drawImage(capImg, 0, 0, size, size);
        wrap.remove();

        // 2) Decode every frame of the source animation.
        const bytes = b64ToBytes(base64Source);
        const decoder = new ImageDecoder({ data: bytes, type: mimetype });
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack || decoder.tracks[0];
        const totalFrames = track.frameCount || 1;

        // Bound worst-case runtime: sample evenly if there are more frames
        // than we're willing to composite, rather than hanging or just
        // chopping the animation short.
        const frameIndices = [];
        if (totalFrames <= maxFrames) {
          for (let i = 0; i < totalFrames; i++) frameIndices.push(i);
        } else {
          const step = totalFrames / maxFrames;
          for (let i = 0; i < maxFrames; i++) frameIndices.push(Math.floor(i * step));
        }

        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const outFrames = [];
        for (let k = 0; k < frameIndices.length; k++) {
          const idx = frameIndices[k];
          const { image } = await decoder.decode({ frameIndex: idx });
          try {
            const nw = image.displayWidth || image.codedWidth;
            const nh = image.displayHeight || image.codedHeight;

            // object-fit: cover, worked out by hand since this is <canvas>
            // rather than CSS this time.
            const coverScale = Math.max(size / nw, size / nh);
            const sw = size / coverScale;
            const sh = size / coverScale;
            const sx = (nw - sw) / 2;
            const sy = (nh - sh) / 2;

            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(image, sx, sy, sw, sh, 0, 0, size, size);
            ctx.drawImage(capCanvas, 0, 0);

            // If frames were sampled down, fold each skipped frame's time
            // into the one that stands in for it, so total duration is
            // preserved rather than the animation just playing faster.
            const nextIdx = k + 1 < frameIndices.length ? frameIndices[k + 1] : totalFrames;
            const span = Math.max(1, nextIdx - idx);
            const durationUs = (image.duration || 0) * span;

            outFrames.push({
              dataUrl: canvas.toDataURL('image/png'),
              durationMs: Math.max(minFrameDurationMs, Math.round(durationUs / 1000) || minFrameDurationMs),
            });
          } finally {
            image.close();
          }
        }

        decoder.close();
        return { frames: outFrames, totalFrames, sampledFrames: frameIndices.length };
      },
      base64Source,
      mimetype,
      topText,
      bottomText,
      STICKER_SIZE,
      MAX_ANIMATED_FRAMES,
      MIN_FRAME_DURATION_MS
    );

    if (!result?.frames?.length) {
      throw new Error('Could not decode any frames from this animated sticker.');
    }

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { renderMemeImage, renderAnimatedMemeFrames };
