/**
 * Media Service
 * Handles media operations for Baileys
 * Replaces MessageMedia functionality from whatsapp-web.js
 */

import { fileURLToPath } from 'url';
import path from 'path';
import socketManager from '../client/socket.js';
import { downloadMedia as download } from '../middleware/normalizeMessage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * MessageMedia-like class for compatibility
 * Creates a media object that can be used with sendMessage
 */
export class MessageMedia {
  constructor(mimetype, data, filename = null) {
    this.mimetype = mimetype;
    this.data = data;
    this.filename = filename;
    this._data = data; // For compatibility
  }

  /**
   * Create MessageMedia from URL
   * @param {string} url - Media URL
   * @param {object} options - Options
   */
  static async fromUrl(url, options = {}) {
    try {
      const response = await fetch(url);
      const buffer = await response.buffer();
      const mimetype = response.headers.get('content-type') || options.mimetype || 'application/octet-stream';
      
      return new MessageMedia(mimetype, buffer.toString('base64'), options.filename);
    } catch (error) {
      console.error('Failed to create MessageMedia from URL:', error);
      throw error;
    }
  }

  /**
   * Create MessageMedia from file path
   * @param {string} filePath - File path
   * @param {object} options - Options
   */
  static async fromFilePath(filePath, options = {}) {
    try {
      const fs = await import('fs');
      const buffer = fs.readFileSync(filePath);
      const mimetype = options.mimetype || this.getMimeTypeFromExtension(filePath);
      
      return new MessageMedia(mimetype, buffer.toString('base64'), path.basename(filePath));
    } catch (error) {
      console.error('Failed to create MessageMedia from file:', error);
      throw error;
    }
  }

  /**
   * Get MIME type from file extension
   * @param {string} filename - Filename
   */
  static getMimeTypeFromExtension(filename) {
    const extension = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
    };
    return mimeTypes[extension] || 'application/octet-stream';
  }
}

/**
 * Media Service
 * Provides media operations for the bot
 */
export class MediaService {
  constructor() {
    this.sock = null;
  }

  /**
   * Initialize with socket
   * @param {object} sock - Baileys socket
   */
  init(sock) {
    this.sock = sock;
  }

  /**
   * Send text message
   * @param {string} jid - Target JID
   * @param {string} text - Text content
   * @param {object} options - Message options
   */
  async sendText(jid, text, options = {}) {
    try {
      if (!this.sock) {
        this.sock = socketManager.getSocket();
      }
      
      await this.sock.sendMessage(jid, { text }, options);
    } catch (error) {
      console.error('Failed to send text:', error);
      throw error;
    }
  }

  /**
   * Send image
   * @param {string} jid - Target JID
   * @param {Buffer|string} image - Image buffer or base64 string
   * @param {object} options - Message options
   */
  async sendImage(jid, image, options = {}) {
    try {
      if (!this.sock) {
        this.sock = socketManager.getSocket();
      }

      let imageBuffer;
      if (typeof image === 'string') {
        if (image.startsWith('http')) {
          // URL
          const response = await fetch(image);
          imageBuffer = await response.buffer();
        } else {
          // Base64
          imageBuffer = Buffer.from(image, 'base64');
        }
      } else if (Buffer.isBuffer(image)) {
        imageBuffer = image;
      } else if (image.data) {
        // MessageMedia-like object
        imageBuffer = Buffer.from(image.data, 'base64');
      }

      const media = {
        image: imageBuffer,
        caption: options.caption,
        mimetype: 'image/jpeg',
        ...options,
      };

      await this.sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send image:', error);
      throw error;
    }
  }

  /**
   * Send video
   * @param {string} jid - Target JID
   * @param {Buffer|string} video - Video buffer or base64 string
   * @param {object} options - Message options
   */
  async sendVideo(jid, video, options = {}) {
    try {
      if (!this.sock) {
        this.sock = socketManager.getSocket();
      }

      let videoBuffer;
      if (typeof video === 'string') {
        if (video.startsWith('http')) {
          const response = await fetch(video);
          videoBuffer = await response.buffer();
        } else {
          videoBuffer = Buffer.from(video, 'base64');
        }
      } else if (Buffer.isBuffer(video)) {
        videoBuffer = video;
      } else if (video.data) {
        videoBuffer = Buffer.from(video.data, 'base64');
      }

      const media = {
        video: videoBuffer,
        caption: options.caption,
        mimetype: 'video/mp4',
        ...options,
      };

      await this.sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send video:', error);
      throw error;
    }
  }

  /**
   * Send sticker
   * @param {string} jid - Target JID
   * @param {Buffer|string} sticker - Sticker buffer or base64 string
   * @param {object} options - Message options
   */
  async sendSticker(jid, sticker, options = {}) {
    try {
      if (!this.sock) {
        this.sock = socketManager.getSocket();
      }

      let stickerBuffer;
      if (typeof sticker === 'string') {
        if (sticker.startsWith('http')) {
          const response = await fetch(sticker);
          stickerBuffer = await response.buffer();
        } else {
          stickerBuffer = Buffer.from(sticker, 'base64');
        }
      } else if (Buffer.isBuffer(sticker)) {
        stickerBuffer = sticker;
      } else if (sticker.data) {
        stickerBuffer = Buffer.from(sticker.data, 'base64');
      }

      const media = {
        sticker: stickerBuffer,
        mimetype: 'image/webp',
        ...options,
      };

      await this.sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send sticker:', error);
      throw error;
    }
  }

  /**
   * Send audio/voice note
   * @param {string} jid - Target JID
   * @param {Buffer|string} audio - Audio buffer or base64 string
   * @param {object} options - Message options
   */
  async sendAudio(jid, audio, options = {}) {
    try {
      if (!this.sock) {
        this.sock = socketManager.getSocket();
      }

      let audioBuffer;
      if (typeof audio === 'string') {
        if (audio.startsWith('http')) {
          const response = await fetch(audio);
          audioBuffer = await response.buffer();
        } else {
          audioBuffer = Buffer.from(audio, 'base64');
        }
      } else if (Buffer.isBuffer(audio)) {
        audioBuffer = audio;
      } else if (audio.data) {
        audioBuffer = Buffer.from(audio.data, 'base64');
      }

      const media = {
        audio: audioBuffer,
        mimetype: 'audio/ogg',
        ptt: true, // Voice note
        ...options,
      };

      await this.sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send audio:', error);
      throw error;
    }
  }

  /**
   * Send document
   * @param {string} jid - Target JID
   * @param {Buffer|string} document - Document buffer or base64 string
   * @param {object} options - Message options
   */
  async sendDocument(jid, document, options = {}) {
    try {
      if (!this.sock) {
        this.sock = socketManager.getSocket();
      }

      let documentBuffer;
      if (typeof document === 'string') {
        if (document.startsWith('http')) {
          const response = await fetch(document);
          documentBuffer = await response.buffer();
        } else {
          documentBuffer = Buffer.from(document, 'base64');
        }
      } else if (Buffer.isBuffer(document)) {
        documentBuffer = document;
      } else if (document.data) {
        documentBuffer = Buffer.from(document.data, 'base64');
      }

      const media = {
        document: documentBuffer,
        mimetype: 'application/octet-stream',
        fileName: options.filename || 'document',
        ...options,
      };

      await this.sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send document:', error);
      throw error;
    }
  }

  /**
   * Download media from message
   * @param {object} msg - Normalized message
   */
  async downloadMedia(msg) {
    try {
      if (!msg._baileys) {
        throw new Error('Message is not a Baileys message');
      }
      
      return await download(msg._baileys);
    } catch (error) {
      console.error('Failed to download media:', error);
      throw error;
    }
  }

  /**
   * Get message type
   * @param {object} msg - Normalized message
   */
  getMessageType(msg) {
    if (!msg._baileys || !msg._baileys.message) {
      return 'text';
    }

    const { message } = msg._baileys;
    
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.stickerMessage) return 'sticker';
    if (message.audioMessage) return 'audio';
    if (message.pttMessage) return 'ptt';
    if (message.documentMessage) return 'document';
    
    return 'text';
  }

  /**
   * Check if message has media
   * @param {object} msg - Normalized message
   */
  hasMedia(msg) {
    const type = this.getMessageType(msg);
    return ['image', 'video', 'sticker', 'audio', 'ptt', 'document'].includes(type);
  }
}

// Create singleton instance
const mediaService = new MediaService();

export default mediaService;
