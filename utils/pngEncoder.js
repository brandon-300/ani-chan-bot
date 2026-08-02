// Minimal PNG encoder — writes an 8-bit RGB or RGBA raster buffer as a valid
// PNG file, using nothing but Node's built-in `zlib` module. No third-party
// dependency, no native binary, no WASM: this runs anywhere Node runs,
// including Termux on Android, with nothing new to `npm install`.
//
// This is deliberately minimal — just enough of the PNG spec to produce a
// small, correct image (signature + IHDR + one IDAT + IEND, filter type
// "None" on every scanline). It is not a general-purpose PNG library.

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ─── CRC32 (required for PNG chunk framing) ───────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encode a raw pixel buffer as a PNG.
 * @param {Buffer|Uint8Array} pixels - Row-major pixel data, top row first,
 *   `channels` bytes per pixel (3 = RGB, 4 = RGBA), no padding between rows.
 * @param {number} width
 * @param {number} height
 * @param {number} [channels=3] - 3 for RGB, 4 for RGBA
 * @returns {Buffer} A complete PNG file
 */
function encodePNG(pixels, width, height, channels = 3) {
  if (channels !== 3 && channels !== 4) throw new Error('encodePNG: channels must be 3 (RGB) or 4 (RGBA)');
  if (pixels.length !== width * height * channels) {
    throw new Error(`encodePNG: pixel buffer length ${pixels.length} does not match ${width}x${height}x${channels}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type: 6 = RGBA, 2 = RGB
  ihdr[10] = 0; // compression method (only valid value)
  ihdr[11] = 0; // filter method (only valid value)
  ihdr[12] = 0; // interlace method (none)

  // Each scanline is prefixed with a filter-type byte. We always use filter
  // 0 ("None") — simplest to get right, and these images are small enough
  // (an 8x8 board) that the compression loss versus a smarter filter is
  // negligible.
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    pixels.copy
      ? pixels.copy(raw, rowStart + 1, y * stride, y * stride + stride)
      : raw.set(pixels.subarray(y * stride, y * stride + stride), rowStart + 1);
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { encodePNG, crc32 };
