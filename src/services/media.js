/**
 * Media Service
 * Complete media handling for Baileys
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
      '.opus': 'audio/opus',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
    };
    return mimeTypes[extension] || 'application/octet-stream';
  }
}

/**
 * Media Service
 * Provides complete media operations for the bot
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
   * Get socket (lazy initialization)
   */
  getSock() {
    if (!this.sock) {
      this.sock = socketManager.getSocket();
    }
    return this.sock;
  }

  /**
   * Send text message
   * @param {string} jid - Target JID
   * @param {string} text - Text content
   * @param {object} options - Message options
   */
  async sendText(jid, text, options = {}) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');
      
      const msgOptions = {
        text,
        ...options,
      };
      
      // Handle quoted message
      if (options.quotedMessageId) {
        msgOptions.quoted = {
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }
      
      // Handle mentions
      if (options.mentions) {
        msgOptions.mentions = options.mentions;
      }
      
      await sock.sendMessage(jid, msgOptions);
    } catch (error) {
      console.error('Failed to send text:', error);
      throw error;
    }
  }

  /**
   * Send image
   * @param {string} jid - Target JID
   * @param {Buffer|string} image - Image buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendImage(jid, image, options = {}) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      let imageBuffer;
      let mimetype = 'image/jpeg';
      let filename = 'image.jpg';

      if (typeof image === 'string') {
        if (image.startsWith('http')) {
          // URL
          const response = await fetch(image);
          imageBuffer = await response.buffer();
          mimetype = response.headers.get('content-type') || 'image/jpeg';
        } else if (image.startsWith('data:')) {
          // Data URI
          const match = image.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) {
            mimetype = match[1];
            imageBuffer = Buffer.from(match[2], 'base64');
          } else {
            imageBuffer = Buffer.from(image, 'base64');
          }
        } else {
          // Base64
          imageBuffer = Buffer.from(image, 'base64');
        }
      } else if (Buffer.isBuffer(image)) {
        imageBuffer = image;
      } else if (image.data) {
        // MessageMedia-like object
        imageBuffer = Buffer.from(image.data, 'base64');
        mimetype = image.mimetype || 'image/jpeg';
        filename = image.filename || 'image.jpg';
      }

      const media = {
        image: imageBuffer,
        caption: options.caption,
        mimetype,
        ...options,
      };

      // Handle quoted message
      if (options.quotedMessageId) {
        media.quoted = {
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }

      await sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send image:', error);
      throw error;
    }
  }

  /**
   * Send video
   * @param {string} jid - Target JID
   * @param {Buffer|string} video - Video buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendVideo(jid, video, options = {}) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      let videoBuffer;
      let mimetype = 'video/mp4';
      let filename = 'video.mp4';

      if (typeof video === 'string') {
        if (video.startsWith('http')) {
          const response = await fetch(video);
          videoBuffer = await response.buffer();
          mimetype = response.headers.get('content-type') || 'video/mp4';
        } else if (video.startsWith('data:')) {
          const match = video.match(/^data:(video\/[^;]+);base64,(.+)$/);
          if (match) {
            mimetype = match[1];
            videoBuffer = Buffer.from(match[2], 'base64');
          } else {
            videoBuffer = Buffer.from(video, 'base64');
          }
        } else {
          videoBuffer = Buffer.from(video, 'base64');
        }
      } else if (Buffer.isBuffer(video)) {
        videoBuffer = video;
      } else if (video.data) {
        videoBuffer = Buffer.from(video.data, 'base64');
        mimetype = video.mimetype || 'video/mp4';
        filename = video.filename || 'video.mp4';
      }

      const media = {
        video: videoBuffer,
        caption: options.caption,
        mimetype,
        ...options,
      };

      if (options.quotedMessageId) {
        media.quoted = {
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }

      await sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send video:', error);
      throw error;
    }
  }

  /**
   * Send sticker
   * @param {string} jid - Target JID
   * @param {Buffer|string} sticker - Sticker buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendSticker(jid, sticker, options = {}) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      let stickerBuffer;
      let mimetype = 'image/webp';
      let filename = 'sticker.webp';

      if (typeof sticker === 'string') {
        if (sticker.startsWith('http')) {
          const response = await fetch(sticker);
          stickerBuffer = await response.buffer();
          mimetype = response.headers.get('content-type') || 'image/webp';
        } else if (sticker.startsWith('data:')) {
          const match = sticker.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) {
            mimetype = match[1];
            stickerBuffer = Buffer.from(match[2], 'base64');
          } else {
            stickerBuffer = Buffer.from(sticker, 'base64');
          }
        } else {
          stickerBuffer = Buffer.from(sticker, 'base64');
        }
      } else if (Buffer.isBuffer(sticker)) {
        stickerBuffer = sticker;
      } else if (sticker.data) {
        stickerBuffer = Buffer.from(sticker.data, 'base64');
        mimetype = sticker.mimetype || 'image/webp';
        filename = sticker.filename || 'sticker.webp';
      }

      const media = {
        sticker: stickerBuffer,
        mimetype,
        ...options,
      };

      if (options.quotedMessageId) {
        media.quoted = {
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }

      await sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send sticker:', error);
      throw error;
    }
  }

  /**
   * Send audio/voice note
   * @param {string} jid - Target JID
   * @param {Buffer|string} audio - Audio buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendAudio(jid, audio, options = {}) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      let audioBuffer;
      let mimetype = 'audio/ogg';
      let filename = 'audio.ogg';

      if (typeof audio === 'string') {
        if (audio.startsWith('http')) {
          const response = await fetch(audio);
          audioBuffer = await response.buffer();
          mimetype = response.headers.get('content-type') || 'audio/ogg';
        } else if (audio.startsWith('data:')) {
          const match = audio.match(/^data:(audio\/[^;]+);base64,(.+)$/);
          if (match) {
            mimetype = match[1];
            audioBuffer = Buffer.from(match[2], 'base64');
          } else {
            audioBuffer = Buffer.from(audio, 'base64');
          }
        } else {
          audioBuffer = Buffer.from(audio, 'base64');
        }
      } else if (Buffer.isBuffer(audio)) {
        audioBuffer = audio;
      } else if (audio.data) {
        audioBuffer = Buffer.from(audio.data, 'base64');
        mimetype = audio.mimetype || 'audio/ogg';
        filename = audio.filename || 'audio.ogg';
      }

      const media = {
        audio: audioBuffer,
        mimetype,
        ptt: true, // Voice note
        ...options,
      };

      if (options.quotedMessageId) {
        media.quoted = {
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }

      await sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send audio:', error);
      throw error;
    }
  }

  /**
   * Send document
   * @param {string} jid - Target JID
   * @param {Buffer|string} document - Document buffer or base64 string or URL
   * @param {object} options - Message options
   */
  async sendDocument(jid, document, options = {}) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      let documentBuffer;
      let mimetype = 'application/octet-stream';
      let filename = options.filename || 'document';

      if (typeof document === 'string') {
        if (document.startsWith('http')) {
          const response = await fetch(document);
          documentBuffer = await response.buffer();
          mimetype = response.headers.get('content-type') || 'application/octet-stream';
          filename = filename || path.basename(new URL(document).pathname);
        } else if (document.startsWith('data:')) {
          const match = document.match(/^data:(application\/[^;]+);base64,(.+)$/);
          if (match) {
            mimetype = match[1];
            documentBuffer = Buffer.from(match[2], 'base64');
          } else {
            documentBuffer = Buffer.from(document, 'base64');
          }
        } else {
          documentBuffer = Buffer.from(document, 'base64');
        }
      } else if (Buffer.isBuffer(document)) {
        documentBuffer = document;
      } else if (document.data) {
        documentBuffer = Buffer.from(document.data, 'base64');
        mimetype = document.mimetype || 'application/octet-stream';
        filename = document.filename || filename;
      }

      const media = {
        document: documentBuffer,
        mimetype,
        fileName: filename,
        caption: options.caption,
        ...options,
      };

      if (options.quotedMessageId) {
        media.quoted = {
          id: options.quotedMessageId,
          remoteJid: jid,
        };
      }

      await sock.sendMessage(jid, media);
    } catch (error) {
      console.error('Failed to send document:', error);
      throw error;
    }
  }

  /**
   * Send message with automatic content type detection
   * @param {string} jid - Target JID
   * @param {*} content - Message content
   * @param {object} options - Message options
   */
  async sendMessage(jid, content, options = {}, quotedMsg = null) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      // Handle different content types
      if (typeof content === 'string') {
        return this.sendText(jid, content, options);
      } else if (content?.mimetype || content?._data || content?.data) {
        // Media message - auto-detect type
        const mimetype = content.mimetype || content._data?.mimetype;
        
        if (mimetype?.startsWith('image/')) {
          return this.sendImage(jid, content, options);
        } else if (mimetype?.startsWith('video/')) {
          return this.sendVideo(jid, content, options);
        } else if (mimetype?.startsWith('audio/') || mimetype === 'audio/ogg') {
          return this.sendAudio(jid, content, options);
        } else if (mimetype?.startsWith('application/')) {
          return this.sendDocument(jid, content, options);
        } else if (mimetype === 'image/webp' || (mimetype?.startsWith('image/') && (content.filename?.endsWith('.webp') || content._data?.filename?.endsWith('.webp')))) {
          return this.sendSticker(jid, content, options);
        }
      }

      // Fallback to text
      return this.sendText(jid, String(content), options);
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Download media from a message
   * @param {object} baileysMsg - Baileys message
   */
  async downloadMedia(baileysMsg) {
    try {
      const sock = this.getSock();
      if (!sock) throw new Error('Socket not initialized');

      return download(baileysMsg, sock);
    } catch (error) {
      console.error('Failed to download media:', error);
      throw error;
    }
  }
}

// Singleton instance
const mediaService = new MediaService();

// Export MessageMedia class for compatibility
export default mediaService;
