/**
 * Baileys Socket Connection Manager
 * Handles the WebSocket connection to WhatsApp
 * 
 * For Termux on Android:
 * - Uses pairing code instead of QR code
 * - Optimized for low memory environments
 * - Automatic reconnection
 */

import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import authManager from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.join(__dirname, '../../../auth_info_baileys');

// Logger configuration - silent for production, debug for development
const logger = pino({
  level: process.env.LOG_LEVEL || 'silent',
});

// Signal key store for E2E
const signalKeyStore = makeCacheableSignalKeyStore(logger);

// Simple in-memory cache for message retry (replaces NodeCache for Termux compatibility)
const msgRetryCounterCache = new Map();

// Clean up old cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of msgRetryCounterCache) {
    if (now - value.timestamp > 600000) { // 10 minutes
      msgRetryCounterCache.delete(key);
    }
  }
}, 60000);

/**
 * Simple cache implementation for Termux
 */
class SimpleCache {
  constructor(stdTTL = 600, checkperiod = 60) {
    this.store = new Map();
    this.stdTTL = stdTTL;
    this.checkperiod = checkperiod;
    
    // Cleanup interval
    this.interval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.store) {
        if (now - value.timestamp > this.stdTTL * 1000) {
          this.store.delete(key);
        }
      }
    }, checkperiod * 1000);
  }
  
  get(key) {
    const value = this.store.get(key);
    return value?.value;
  }
  
  set(key, value, ttl = this.stdTTL) {
    this.store.set(key, { value, timestamp: Date.now(), ttl });
  }
  
  del(key) {
    this.store.delete(key);
  }
  
  flushAll() {
    this.store.clear();
  }
}

// Message retry cache for Termux/low memory
const simpleMsgRetryCache = new SimpleCache(600, 60);

/**
 * Socket Manager
 * Singleton that manages the Baileys WebSocket connection
 */
class SocketManager {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.reconnectTimeout = null;
    this.messageQueue = [];
    this.eventHandlers = {
      connection: [],
      message: [],
      qr: [],
      authenticated: [],
      ready: [],
      disconnected: [],
      error: [],
      group_join: [],
      group_leave: [],
      group_update: [],
      message_reaction: [],
    };
    
    // Bot's own JID (populated after connection)
    this.info = null;
    
    // Track bot's sent messages for reaction detection
    this.sentMessages = new Map();
    
    // Track if event handlers are set up to prevent duplicates
    this.eventHandlersSetup = false;
  }

  /**
   * Get the singleton instance
   */
  static getInstance() {
    if (!this.instance) {
      this.instance = new SocketManager();
    }
    return this.instance;
  }

  /**
   * Get the socket instance
   */
  getSocket() {
    return this.sock;
  }

  /**
   * Get bot's own JID
   */
  getWid() {
    return this.info?.wid?._serialized || this.sock?.user?.id;
  }

  /**
   * Event emitter pattern
   */
  on(event, handler) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].push(handler);
    }
  }

  emit(event, ...args) {
    if (this.eventHandlers[event]) {
      for (const handler of this.eventHandlers[event]) {
        try {
          handler(...args);
        } catch (error) {
          logger.error(`Error in ${event} handler:`, error);
        }
      }
    }
  }

  /**
   * Get Baileys version (async)
   */
  async getBaileysVersion() {
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      return versionInfo;
    } catch (error) {
      logger.warn('Could not fetch latest Baileys version, using fallback');
      // Fallback to a known working version
      return [2, 2414, 12];
    }
  }

  /**
   * Check if authenticated
   */
  isAuthenticated() {
    return this.isConnected && this.sock && authManager.isAuthenticated();
  }

  /**
   * Register a sent message for reaction tracking
   */
  registerSentMessage(key, msg) {
    this.sentMessages.set(key.id, { key, msg, timestamp: Date.now() });
    // Clean up old messages after 1 hour
    setTimeout(() => this.sentMessages.delete(key.id), 3600000);
  }

  /**
   * Check if a message was sent by the bot
   */
  isBotMessage(key) {
    return this.sentMessages.has(key.id);
  }

  /**
   * Get the bot's sent message by key
   */
  getBotSentMessage(key) {
    return this.sentMessages.get(key.id);
  }

  /**
   * Initialize the socket
   */
  async init() {
    if (this.isConnecting) {
      logger.info('Socket initialization already in progress');
      return;
    }

    if (this.isConnected) {
      logger.info('Socket already connected');
      return;
    }

    this.isConnecting = true;
    logger.info('Initializing Baileys socket...');

    try {
      // Get auth state
      const authState = authManager.getState();
      const needsPairing = !authManager.isAuthenticated();

      // Get version - await the promise
      const version = await this.getBaileysVersion();

      // Create socket configuration
      const sockConfig = {
        version,
        auth: authState,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        signalKeyStore,
        msgRetryCounterCache: simpleMsgRetryCache,
        transactionOpts: {
          maxCommitRetries: 10,
          delayBetweenCommitMs: 3000,
        },
        syncFullHistory: false,
        shouldSyncHistoryMessage: (msg) => false,
        generateHighQualityLinkPreview: true,
        // For Termux - prefer pairing code
        ...(needsPairing && {
          getMessage: async (key) => {
            // Handle message retrieval if needed
            return {};
          },
        }),
      };

      // Create socket
      this.sock = makeWASocket(sockConfig);

      // Store bot info
      this.info = {
        wid: this.sock.user,
        pushname: this.sock.user?.name,
      };

      // Setup event handlers - only once!
      if (!this.eventHandlersSetup) {
        this.setupEventHandlers();
        this.eventHandlersSetup = true;
      }

      this.isConnecting = false;
      logger.info('Baileys socket initialized');

    } catch (error) {
      this.isConnecting = false;
      logger.error('Failed to initialize socket:', error);
      throw error;
    }
  }

  /**
   * Setup event handlers - called only once
   */
  setupEventHandlers() {
    if (!this.sock) return;

    // Credentials update - save auth state
    this.sock.ev.on('creds.update', async () => {
      try {
        await authManager.saveCreds();
        logger.info('Credentials updated and saved');
      } catch (error) {
        logger.error('Failed to save credentials:', error);
      }
    });

    // Connection update
    this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));

    // Messages upsert
    this.sock.ev.on('messages.upsert', this.handleMessagesUpsert.bind(this));

    // Message reactions
    this.sock.ev.on('message-receipt.update', this.handleMessageReceipt.bind(this));

    // Groups update
    this.sock.ev.on('groups.update', this.handleGroupsUpdate.bind(this));

    // Group participants update
    this.sock.ev.on('group-participants.update', this.handleGroupParticipantsUpdate.bind(this));
  }

  /**
   * Handle pairing code generation
   */
  async handlePairingCode() {
    if (!authManager.isAuthenticated()) {
      try {
        const phoneNumber = process.env.PHONE_NUMBER;
        if (phoneNumber) {
          const pairingCode = await this.sock.requestPairingCode(phoneNumber);
          logger.info('Pairing code generated:', pairingCode);
          this.emit('pairing_code', pairingCode);
        } else {
          logger.warn('PHONE_NUMBER not set in .env, cannot generate pairing code');
          // Fall back to QR
          this.sock.ev.on('connection.update', (update) => {
            if (update.qr) {
              this.emit('qr', update.qr);
            }
          });
        }
      } catch (error) {
        logger.error('Failed to generate pairing code:', error);
      }
    }
  }

  /**
   * Handle connection update
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    // Handle QR code
    if (qr) {
      logger.info('QR code generated');
      this.emit('qr', qr);
    }

    // New login
    if (isNewLogin) {
      logger.info('New login detected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('authenticated');
      this.handlePairingCode();
    }

    // Connection states
    switch (connection) {
      case 'connecting':
        logger.info('Connecting to WhatsApp...');
        break;

      case 'open':
        logger.info('Connected to WhatsApp');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('ready');
        break;

      case 'close':
        this.isConnected = false;
        const shouldReconnect = lastDisconnect?.error instanceof Boom;
        
        if (shouldReconnect) {
          logger.warn('Connection closed, attempting to reconnect...');
          this.scheduleReconnect(lastDisconnect.error);
        } else {
          logger.info('Connection closed gracefully');
        }
        
        this.emit('disconnected', lastDisconnect);
        break;

      default:
        logger.debug('Connection state:', connection);
    }
  }

  /**
   * Schedule reconnection
   */
  scheduleReconnect(error) {
    // Clear existing timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    const delay = this.reconnectDelay * this.reconnectAttempts;
    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        logger.error('Reconnection failed:', err);
        this.scheduleReconnect(err);
      }
    }, delay);
  }

  /**
   * Connect or reconnect
   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    try {
      await this.init();
    } catch (error) {
      logger.error('Connection failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect
   */
  async disconnect() {
    if (!this.sock) return;

    try {
      await this.sock.ws.close();
      this.isConnected = false;
      logger.info('Disconnected from WhatsApp');
    } catch (error) {
      logger.error('Error disconnecting:', error);
    }
  }

  /**
   * Handle messages upsert
   */
  async handleMessagesUpsert(upsert) {
    try {
      const messages = upsert.messages;
      const type = upsert.type;

      if (!messages || messages.length === 0) return;

      // Process each message
      for (const baileysMsg of messages) {
        try {
          // Skip status messages
          if (baileysMsg.key.fromMe || baileysMsg.pushName === 'status@broadcast') {
            continue;
          }

          // Register bot's own sent messages for reaction tracking
          if (baileysMsg.key.fromMe) {
            this.registerSentMessage(baileysMsg.key, baileysMsg);
          }

          // Normalize the message
          const normalizedMsg = this.normalizeMessage(baileysMsg);
          
          // Emit message event
          this.emit('message', normalizedMsg);

        } catch (error) {
          logger.error('Error processing message:', error);
        }
      }
    } catch (error) {
      logger.error('Error in messages.upsert handler:', error);
    }
  }

  /**
   * Handle message receipt (reactions, reads, etc.)
   */
  async handleMessageReceipt(update) {
    try {
      const { key, receipt } = update;
      
      // Handle reactions
      if (receipt?.type === 'reaction') {
        const reaction = {
          type: 'reaction',
          key,
          receipt,
          // Check if this is a reaction to bot's own message
          isReactionToBot: this.isBotMessage(key),
          botMessage: this.isBotMessage(key) ? this.getBotSentMessage(key) : null,
        };
        this.emit('message_reaction', reaction);
      }
    } catch (error) {
      logger.error('Error in message-receipt.update handler:', error);
    }
  }

  /**
   * Handle groups update
   */
  async handleGroupsUpdate(update) {
    try {
      this.emit('group_update', update);
    } catch (error) {
      logger.error('Error in groups.update handler:', error);
    }
  }

  /**
   * Handle group participants update
   */
  async handleGroupParticipantsUpdate(update) {
    try {
      const { id, participants, action } = update;
      
      if (action === 'add') {
        this.emit('group_join', { id, participants });
      } else if (action === 'remove') {
        this.emit('group_leave', { id, participants });
      }
    } catch (error) {
      logger.error('Error in group-participants.update handler:', error);
    }
  }

  /**
   * Normalize Baileys message to match whatsapp-web.js format
   */
  normalizeMessage(baileysMsg) {
    const { key, pushName, message, participant, timestamp, fromMe } = baileysMsg;
    
    const isGroup = key.remoteJid?.endsWith('@g.us') || false;
    const fromMeFlag = key.fromMe || fromMe || false;
    
    // Determine the actual sender
    let author = null;
    let from = key.remoteJid;
    
    if (isGroup && participant) {
      author = participant;
    } else if (!fromMeFlag) {
      author = key.remoteJid.split('@')[0];
    }

    // Extract message body
    let body = '';
    let type = 'chat';
    let hasMedia = false;
    let isMedia = false;
    let mentionedIds = [];
    let hasQuotedMsg = false;
    let quotedMessage = null;

    if (message) {
      // Text message
      if (message.conversation) {
        body = message.conversation;
        type = 'chat';
      } 
      // Extended text (with mentions)
      else if (message.extendedTextMessage) {
        body = message.extendedTextMessage.text || '';
        type = 'chat';
        
        // Extract mentions
        if (message.extendedTextMessage.contextInfo?.mentionedJid) {
          mentionedIds = message.extendedTextMessage.contextInfo.mentionedJid;
        }
        
        // Check for quoted message
        if (message.extendedTextMessage.contextInfo?.quotedMessage) {
          hasQuotedMsg = true;
          quotedMessage = message.extendedTextMessage.contextInfo.quotedMessage;
        }
      }
      // Image
      else if (message.imageMessage) {
        type = 'image';
        hasMedia = true;
        isMedia = true;
        body = message.imageMessage.caption || '';
        
        if (message.imageMessage.contextInfo?.mentionedJid) {
          mentionedIds = message.imageMessage.contextInfo.mentionedJid;
        }
        
        if (message.imageMessage.contextInfo?.quotedMessage) {
          hasQuotedMsg = true;
          quotedMessage = message.imageMessage.contextInfo.quotedMessage;
        }
      }
      // Video
      else if (message.videoMessage) {
        type = 'video';
        hasMedia = true;
        isMedia = true;
        body = message.videoMessage.caption || '';
        
        if (message.videoMessage.contextInfo?.mentionedJid) {
          mentionedIds = message.videoMessage.contextInfo.mentionedJid;
        }
        
        if (message.videoMessage.contextInfo?.quotedMessage) {
          hasQuotedMsg = true;
          quotedMessage = message.videoMessage.contextInfo.quotedMessage;
        }
      }
      // Sticker
      else if (message.stickerMessage) {
        type = 'sticker';
        hasMedia = true;
        isMedia = true;
        
        if (message.stickerMessage.contextInfo?.quotedMessage) {
          hasQuotedMsg = true;
          quotedMessage = message.stickerMessage.contextInfo.quotedMessage;
        }
      }
      // Audio
      else if (message.audioMessage) {
        type = 'audio';
        hasMedia = true;
        isMedia = true;
      }
      // Voice note (PTT)
      else if (message.pttMessage) {
        type = 'ptt';
        hasMedia = true;
        isMedia = true;
      }
      // Document
      else if (message.documentMessage) {
        type = 'document';
        hasMedia = true;
        isMedia = true;
        body = message.documentMessage.caption || '';
      }
      // Reaction
      else if (message.reactionMessage) {
        type = 'reaction';
        body = message.reactionMessage.text || '';
      }
      // Buttons response
      else if (message.buttonsResponseMessage) {
        type = 'buttons_response';
        body = message.buttonsResponseMessage.selectedButtonId || '';
      }
      // List response
      else if (message.listResponseMessage) {
        type = 'list_response';
        body = message.listResponseMessage.selectedRowId || '';
      }
      // Template button reply
      else if (message.templateButtonReplyMessage) {
        type = 'template_button_reply';
        body = message.templateButtonReplyMessage.selectedId || '';
      }
    }

    // Build normalized message
    const normalizedMsg = {
      id: { _serialized: key.id },
      from: from,
      fromMe: fromMeFlag,
      author: author,
      body: body,
      type: type,
      timestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
      hasMedia: hasMedia,
      isMedia: isMedia,
      pushName: pushName,
      isGroup: isGroup,
      chatId: key.remoteJid,
      mentionedIds: mentionedIds,
      hasQuotedMsg: hasQuotedMsg,
      _quoted: quotedMessage,
      // Store the raw Baileys message for compatibility
      _baileys: baileysMsg,
      // Store socket reference
      _sock: this.sock,
      // Bot's own JID
      _client: this,
    };

    // Add reply function
    normalizedMsg.reply = async (content, chatId, options = {}) => {
      return this.sendMessage(chatId || from, content, options, normalizedMsg);
    };

    // Add downloadMedia function
    normalizedMsg.downloadMedia = async () => {
      return this.downloadMedia(baileysMsg);
    };

    // Add getChat function
    normalizedMsg.getChat = async () => {
      return this.getChat(key.remoteJid);
    };

    // Add getContact function
    normalizedMsg.getContact = async () => {
      return this.getContact(author || from);
    };

    // Add react function
    normalizedMsg.react = async (emoji) => {
      return this.react(key, emoji);
    };

    // Add getQuotedMessage function
    normalizedMsg.getQuotedMessage = async () => {
      if (hasQuotedMsg && quotedMessage) {
        return this.normalizeMessage(quotedMessage);
      }
      return null;
    };

    // Add delete function
    normalizedMsg.delete = async (everyone = false) => {
      return this.deleteMessage(key, everyone);
    };

    // Add forward function
    normalizedMsg.forward = async (jid) => {
      return this.forwardMessage(jid, baileysMsg);
    };

    // Add _data for compatibility with old whatsapp-web.js
    normalizedMsg._data = {
      id: key.id,
      from: from,
      to: key.remoteJid,
      body: body,
      type: type,
      timestamp: timestamp ? timestamp * 1000 : Date.now(),
      fromMe: fromMeFlag,
      isGroup: isGroup,
    };

    return normalizedMsg;
  }

  /**
   * Send a message
   */
  async sendMessage(jid, content, options = {}, quotedMsg = null) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    try {
      // Handle different content types
      if (typeof content === 'string') {
        // Text message
        const msgOptions = {
          text: content,
          ...options,
        };
        
        // Add quoted message if provided
        if (quotedMsg && quotedMsg.id) {
          msgOptions.quoted = {
            id: quotedMsg.id._serialized || quotedMsg.id,
            remoteJid: jid,
          };
        }
        
        if (options.mentions) {
          msgOptions.mentions = options.mentions;
        }
        
        const result = await this.sock.sendMessage(jid, msgOptions);
        // Register the sent message for reaction tracking
        if (result && result.key) {
          this.registerSentMessage(result.key, result);
        }
        return result;
      } else if (content?.mimetype || content?._data || content?.data) {
        // Media message (from MessageMedia-like object)
        const media = { ...content };
        
        // Add quoted message
        if (quotedMsg && quotedMsg.id) {
          media.quoted = {
            id: quotedMsg.id._serialized || quotedMsg.id,
            remoteJid: jid,
          };
        }
        
        // Convert MessageMedia format to Baileys format
        if (content.mimetype && content.data) {
          const buffer = Buffer.from(content.data, 'base64');
          
          if (content.mimetype.startsWith('image/')) {
            media.image = buffer;
            delete media.data;
            delete media.mimetype;
          } else if (content.mimetype.startsWith('video/')) {
            media.video = buffer;
            delete media.data;
            delete media.mimetype;
          } else if (content.mimetype.startsWith('audio/') || content.mimetype === 'audio/ogg') {
            media.audio = buffer;
            media.ptt = content.mimetype.includes('ogg');
            delete media.data;
            delete media.mimetype;
          } else if (content.mimetype === 'application/pdf' || content.mimetype.startsWith('application/')) {
            media.document = buffer;
            delete media.data;
            delete media.mimetype;
          } else if (content.mimetype.startsWith('image/') && content.filename?.endsWith('.webp')) {
            media.sticker = buffer;
            delete media.data;
            delete media.mimetype;
          }
        }
        
        const result = await this.sock.sendMessage(jid, media, options);
        // Register the sent message for reaction tracking
        if (result && result.key) {
          this.registerSentMessage(result.key, result);
        }
        return result;
      } else {
        // Unknown content type - try to send as text
        const result = await this.sock.sendMessage(jid, { text: String(content) }, options);
        if (result && result.key) {
          this.registerSentMessage(result.key, result);
        }
        return result;
      }
    } catch (error) {
      logger.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(key, everyone = false) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    try {
      await this.sock.sendMessage(key.remoteJid, {
        delete: {
          id: key.id,
          remoteJid: key.remoteJid,
          fromMe: true,
          participant: key.participant,
        },
      });
    } catch (error) {
      logger.error('Failed to delete message:', error);
      throw error;
    }
  }

  /**
   * Forward a message
   */
  async forwardMessage(jid, baileysMsg) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    try {
      const { key, message } = baileysMsg;
      const forwardMsg = { ...message, key: { ...key } };
      delete forwardMsg.key.id;
      
      const result = await this.sock.sendMessage(jid, {
        forward: forwardMsg,
      });
      
      // Register the forwarded message
      if (result && result.key) {
        this.registerSentMessage(result.key, result);
      }
      return result;
    } catch (error) {
      logger.error('Failed to forward message:', error);
      throw error;
    }
  }

  /**
   * Download media from a message
   */
  async downloadMedia(baileysMsg) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    const { message, key } = baileysMsg;
    
    if (!message) {
      throw new Error('No message to download media from');
    }

    // Determine media type
    let mediaMessage = null;
    let mediaType = null;

    if (message.imageMessage) {
      mediaMessage = message.imageMessage;
      mediaType = 'image';
    } else if (message.videoMessage) {
      mediaMessage = message.videoMessage;
      mediaType = 'video';
    } else if (message.stickerMessage) {
      mediaMessage = message.stickerMessage;
      mediaType = 'sticker';
    } else if (message.audioMessage) {
      mediaMessage = message.audioMessage;
      mediaType = 'audio';
    } else if (message.pttMessage) {
      mediaMessage = message.pttMessage;
      mediaType = 'ptt';
    } else if (message.documentMessage) {
      mediaMessage = message.documentMessage;
      mediaType = 'document';
    }

    if (!mediaMessage) {
      throw new Error('No media found in message');
    }

    // Download the media
    try {
      const stream = await this.sock.downloadMediaMessage(mediaMessage);
      const chunks = [];
      
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      return {
        data: buffer.toString('base64'),
        mimetype: mediaMessage.mimetype || this.getMimeTypeFromMediaType(mediaType),
        filename: mediaMessage.fileName,
      };
    } catch (error) {
      logger.error('Failed to download media:', error);
      throw error;
    }
  }

  /**
   * Get chat info
   */
  async getChat(jid) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    const isGroup = jid?.endsWith('@g.us') || false;
    
    if (isGroup) {
      try {
        const metadata = await this.sock.groupMetadata(jid);
        return {
          id: { _serialized: jid },
          name: metadata.subject,
          isGroup: true,
          participants: metadata.participants.map(p => ({
            id: { _serialized: p.id },
            isAdmin: p.isAdmin || false,
            isSuperAdmin: p.isSuperAdmin || false,
          })),
        };
      } catch (error) {
        logger.error('Failed to get group metadata:', error);
        return {
          id: { _serialized: jid },
          name: jid.split('@')[0],
          isGroup: true,
          participants: [],
        };
      }
    } else {
      return {
        id: { _serialized: jid },
        isGroup: false,
        name: jid.split('@')[0],
      };
    }
  }

  /**
   * Get contact info
   */
  async getContact(jid) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    try {
      // For now, return basic contact info
      return {
        id: { _serialized: jid },
        name: jid.split('@')[0],
        pushName: jid.split('@')[0],
      };
    } catch (error) {
      logger.error('Failed to get contact:', error);
      throw error;
    }
  }

  /**
   * React to a message
   */
  async react(key, emoji) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    try {
      await this.sock.sendMessage(key.remoteJid, {
        react: {
          text: emoji,
          key: key,
        },
      });
    } catch (error) {
      logger.error('Failed to react:', error);
      throw error;
    }
  }

  /**
   * Get MIME type from media type
   */
  getMimeTypeFromMediaType(mediaType) {
    const mimeTypes = {
      image: 'image/jpeg',
      video: 'video/mp4',
      sticker: 'image/webp',
      audio: 'audio/mpeg',
      ptt: 'audio/ogg',
      document: 'application/octet-stream',
    };
    return mimeTypes[mediaType] || 'application/octet-stream';
  }
}

// Singleton instance
const socketManager = new SocketManager();

export default socketManager;
