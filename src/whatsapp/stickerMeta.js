/**
 * Pack name / author for WhatsApp stickers.
 *
 * WhatsApp reads a sticker's pack name and author from an EXIF block inside the
 * .webp file itself. whatsapp-web.js wrote that block for us when a command passed
 * sendMediaAsSticker + stickerName/stickerAuthor. Baileys sends the file exactly as
 * it is, so without this step every sticker arrives with an EMPTY pack and author.
 *
 * embedStickerExif() writes the block straight into an existing .webp (static or
 * animated) without re-encoding it, so quality and animation are untouched.
 * node-webpmux is pure JavaScript (no native binary), so it works in Termux.
 */
import crypto from 'crypto';

let webpmuxPromise = null;

// Loaded on first use: if the package is ever missing, the bot still starts and
// stickers fall back to the older conversion path instead of crashing.
function loadWebpmux() {
  if (!webpmuxPromise) {
    webpmuxPromise = import('node-webpmux')
      .then(mod => mod.default?.Image || mod.Image)
      .catch(() => null);
  }
  return webpmuxPromise;
}

export function isWebp(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP';
}

// The same pack name + author always gets the same id, so WhatsApp groups
// stickers made with the same name together instead of showing many one-sticker packs.
function packId(pack, author) {
  return crypto.createHash('sha1').update(`${pack}\u0000${author}`).digest('hex');
}

export function buildExif({ pack, author, emojis }) {
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': packId(pack, author),
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: Array.isArray(emojis) && emojis.length ? emojis : ['\u{1F602}'],
  }), 'utf8');
  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  header.writeUInt32LE(json.length, 14);
  return Buffer.concat([header, json]);
}

/**
 * Returns the webp with pack/author written into it, or null when the input is not
 * a webp (the caller then converts it first) or node-webpmux is unavailable.
 * Throws if the webp is corrupt; the caller sends the original in that case.
 */
export async function embedStickerExif(buffer, { pack, author, emojis } = {}) {
  if (!isWebp(buffer)) return null;
  const Image = await loadWebpmux();
  if (!Image) return null;
  const image = new Image();
  await image.load(buffer);
  image.exif = buildExif({ pack: String(pack || ''), author: String(author || ''), emojis });
  return await image.save(null);
}

export async function readStickerExif(buffer) {
  const Image = await loadWebpmux();
  if (!Image || !isWebp(buffer)) return null;
  const image = new Image();
  await image.load(buffer);
  if (!image.exif) return null;
  const text = image.exif.toString('utf8');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

export default { isWebp, buildExif, embedStickerExif, readStickerExif };
