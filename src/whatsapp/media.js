import axios from 'axios';
import path from 'path';
import pino from 'pino';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const mediaLogger = pino({ level: 'silent' });

const EXTENSION_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

function cleanMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data !== 'string' || !data) {
    throw new TypeError('Media data must be a non-empty base64 string, Buffer, or Uint8Array.');
  }
  return Buffer.from(data, 'base64');
}

function getMediaSource(content) {
  if (content instanceof MessageMedia) {
    return { mimetype: content.mimetype, data: content.data, filename: content.filename };
  }
  if (content && typeof content === 'object' && content.mimetype && content.data !== undefined) {
    return { mimetype: content.mimetype, data: content.data, filename: content.filename || content.fileName };
  }
  return null;
}

function forwardingOptions(options = {}) {
  const result = {};
  if (options.quoted) result.quoted = options.quoted;
  if (options.linkPreview !== undefined) result.linkPreview = options.linkPreview;
  if (options.messageId) result.messageId = options.messageId;
  return result;
}

export class MessageMedia {
  constructor(mimetype, data, filename = 'file') {
    this.mimetype = cleanMimeType(mimetype) || 'application/octet-stream';
    this.data = Buffer.isBuffer(data) || data instanceof Uint8Array
      ? Buffer.from(data).toString('base64')
      : String(data || '');
    this.filename = filename || 'file';
    this.filesize = Buffer.byteLength(this.data, 'base64');
  }

  static async fromUrl(url, options = {}) {
    if (!url) throw new TypeError('A media URL is required.');
    const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const maxContentLength = Number.isFinite(options.maxContentLength)
      ? options.maxContentLength
      : DEFAULT_MAX_MEDIA_BYTES;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout,
      maxContentLength,
      maxBodyLength: maxContentLength,
      headers: options.headers,
      validateStatus: status => status >= 200 && status < 300,
    });
    const data = Buffer.from(response.data);
    if (!data.length) throw new Error('The media URL returned an empty file.');
    if (data.length > maxContentLength) throw new Error(`Media exceeds the ${maxContentLength}-byte limit.`);

    const urlPath = (() => {
      try { return new URL(url).pathname; } catch { return ''; }
    })();
    const filename = options.filename || path.basename(urlPath) || `media-${Date.now()}`;
    const responseMime = cleanMimeType(response.headers?.['content-type']);
    const extensionMime = EXTENSION_MIME_TYPES[path.extname(filename).toLowerCase()];
    const mimetype = responseMime && responseMime !== 'application/octet-stream'
      ? responseMime
      : (extensionMime || responseMime || 'application/octet-stream');

    if (!options.unsafeMime && mimetype === 'application/octet-stream') {
      throw new Error('The media URL did not provide a usable content type.');
    }
    return new MessageMedia(mimetype, data, filename);
  }
}

/** Convert the project's whatsapp-web.js-shaped media object to a Baileys payload. */
export function toBaileysMediaPayload(content, options = {}) {
  const source = getMediaSource(content);
  if (!source) return null;

  const buffer = asBuffer(source.data);
  if (!buffer.length) throw new Error('Cannot send empty media.');
  const mimetype = cleanMimeType(source.mimetype) || 'application/octet-stream';
  const filename = source.filename || 'file';
  const extension = path.extname(filename).toLowerCase();
  const caption = options.caption ?? content.caption;
  const mentions = options.mentions || content.mentions;
  const common = {};
  if (caption) common.caption = String(caption);
  if (Array.isArray(mentions) && mentions.length) common.mentions = mentions;

  if (options.sendMediaAsSticker || options.sticker || (mimetype === 'image/webp' && options.asSticker)) {
    return { sticker: buffer, ...common };
  }
  if (mimetype.startsWith('image/')) {
    // Existing sticker-producing commands set the sticker option; a plain
    // image/webp without that flag remains an image rather than being silently
    // converted into a sticker.
    return { image: buffer, mimetype, ...common };
  }
  if (mimetype.startsWith('video/')) {
    return { video: buffer, mimetype, gifPlayback: Boolean(options.sendVideoAsGif || options.gifPlayback), ...common };
  }
  if (mimetype.startsWith('audio/')) {
    const isVoiceNote = Boolean(options.sendAudioAsVoice || options.ptt || mimetype === 'audio/ogg' || extension === '.opus');
    return { audio: buffer, mimetype, ptt: isVoiceNote, ...common };
  }

  return {
    document: buffer,
    mimetype,
    fileName: filename,
    ...common,
  };
}

export async function downloadBaileysMedia(sock, message) {
  if (!sock) throw new Error('WhatsApp socket is not initialized.');
  const baileysMessage = message?._baileys || message;
  if (!baileysMessage?.message) throw new Error('No Baileys message payload is available for download.');
  const mediaTypes = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage'];
  const content = baileysMessage.message;
  const mediaNode = mediaTypes.map(type => content?.[type]).find(Boolean);
  if (!mediaNode) throw new Error('The message does not contain downloadable media.');

  const buffer = await downloadMediaMessage(
    baileysMessage,
    'buffer',
    {},
    { logger: mediaLogger, reuploadRequest: sock.updateMediaMessage ? msg => sock.updateMediaMessage(msg) : undefined },
  );
  const mimetype = cleanMimeType(mediaNode.mimetype) || 'application/octet-stream';
  const filename = mediaNode.fileName || `whatsapp-${Date.now()}`;
  return new MessageMedia(mimetype, buffer, filename);
}

class WhatsAppMediaService {
  constructor() {
    this.sock = null;
    this.onSent = null;
  }

  init(sock, onSent = null) {
    this.sock = sock || null;
    this.onSent = typeof onSent === 'function' ? onSent : null;
  }

  getSock() {
    if (!this.sock) throw new Error('WhatsApp socket is not initialized.');
    return this.sock;
  }

  async download(message) {
    return downloadBaileysMedia(this.getSock(), message);
  }

  async sendMessage(jid, content, options = {}) {
    const sock = this.getSock();
    const sendOptions = forwardingOptions(options);
    const mediaPayload = toBaileysMediaPayload(content, options);
    if (mediaPayload) {
      const result = await sock.sendMessage(jid, mediaPayload, sendOptions);
      if (result?.key) this.onSent?.(result.key, result);
      return result;
    }

    if (typeof content === 'string') {
      const textPayload = { text: content };
      if (Array.isArray(options.mentions) && options.mentions.length) textPayload.mentions = options.mentions;
      const result = await sock.sendMessage(jid, textPayload, sendOptions);
      if (result?.key) this.onSent?.(result.key, result);
      return result;
    }

    const payload = content && typeof content === 'object' ? content : { text: String(content ?? '') };
    const result = await sock.sendMessage(jid, payload, sendOptions);
    if (result?.key) this.onSent?.(result.key, result);
    return result;
  }

  async sendImage(jid, image, options = {}) {
    const media = await this.resolveMedia(image, options, 'image/jpeg');
    return this.sendMessage(jid, media, options);
  }

  async sendVideo(jid, video, options = {}) {
    const media = await this.resolveMedia(video, options, 'video/mp4');
    return this.sendMessage(jid, media, options);
  }

  async sendAudio(jid, audio, options = {}) {
    const media = await this.resolveMedia(audio, options, options.mimetype || 'audio/mpeg');
    return this.sendMessage(jid, media, options);
  }

  async sendSticker(jid, sticker, options = {}) {
    const media = await this.resolveMedia(sticker, options, 'image/webp');
    return this.sendMessage(jid, media, { ...options, sendMediaAsSticker: true });
  }

  async sendDocument(jid, document, options = {}) {
    const media = await this.resolveMedia(document, options, options.mimetype || 'application/octet-stream');
    return this.sendMessage(jid, media, options);
  }

  async resolveMedia(value, options, fallbackMime) {
    if (value instanceof MessageMedia) return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return new MessageMedia(options.mimetype || fallbackMime, value, options.filename || options.fileName || 'file');
    }
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      return MessageMedia.fromUrl(value, options);
    }
    if (typeof value === 'string') return new MessageMedia(options.mimetype || fallbackMime, value, options.filename || options.fileName || 'file');
    const source = getMediaSource(value);
    if (source) return new MessageMedia(source.mimetype, source.data, source.filename);
    throw new TypeError('Unsupported media input; expected a URL, base64 string, Buffer, or MessageMedia.');
  }
}

const media = new WhatsAppMediaService();
export default media;
