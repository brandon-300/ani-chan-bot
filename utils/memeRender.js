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

module.exports = { renderMemeImage };
