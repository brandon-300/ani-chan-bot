/**
 * Baileys Socket Connection Manager
 * Handles the WebSocket connection to WhatsApp
 */

import { makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';
import authManager from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.join(__dirname, '../../../auth_info_baileys');

// Logger configuration
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
    },
  },
});

// Signal key store for E2E
const signalKeyStore = makeCacheableSignalKeyStore(logger);

/**
 * Socket Manager
 * Manages the Baileys WebSocket connection
 */
class SocketManager {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000; // 5 seconds
    this.messageQueue = [];
    this.eventHandlers = {
      connection: [],
      message: [],
      group: [],
    };
  }

  /**
   * Initialize the socket
   */
  async init() {
    if (this.isConnecting) {
      logger.info('Socket initialization already in progress');
      return;
    }

    this.isConnecting = true;
    logger.info('Initializing Baileys socket...');

    try {
      // Check if we need to generate a pairing code
      const needsPairing = !authManager.isAuthenticated();

      // Create socket configuration
      const sockConfig = {
        version: this.getBaileysVersion(),
        auth: authManager.getState(),
        printQRInTerminal: false, // We'll handle QR/pairing code manually
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        signalKeyStore,
        // For Termux/low memory environments
        msgRetryCounterCache: new NodeCache({ stdTTL: 600, checkperiod: 60 }),
        transactionOpts: {
          maxCommitRetries: 10,
          delayBetweenCommitMs: 3000,
        },
        // Important for Termux
        syncFullHistory: false,
        shouldSyncHistoryMessage: (msg) => false,
        // Pairing code callback
        generateHighQualityLinkPreview: true,
        ...(needsPairing && {
          // This will trigger pairing code generation
        }),
      };

      // Create socket
      this.sock = makeWASocket(sockConfig);

      // Setup event handlers
      this.setupEventHandlers();

      // Setup auth update handler
      this.sock.ev.on('creds.update', this.handleCredsUpdate.bind(this));

      // Setup connection update handler
      this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));

      // Setup messages upsert handler
      this.sock.ev.on('messages.upsert', this.handleMessagesUpsert.bind(this));

      // Setup message reaction handler
      this.sock.ev.on('message-receipt.update', this.handleMessageReceipt.bind(this));

      // Setup groups update handler
      this.sock.ev.on('groups.update', this.handleGroupsUpdate.bind(this));

      // Setup group participants update handler
      this.sock.ev.on('group-participants.update', this.handleGroupParticipantsUpdate.bind(this));

      this.isConnecting = false;
      logger.info('Baileys socket initialized');

    } catch (error) {
      this.isConnecting = false;
      logger.error('Failed to initialize socket:', error);
      throw error;
    }
  }

  /**
   * Get Baileys version
   */
  getBaileysVersion() {
    // Use the latest version or fallback
    try {
      const versionInfo = fetchLatestBaileysVersion();
      return versionInfo;
    } catch (error) {
      logger.warn('Could not fetch latest Baileys version, using fallback');
      return [2, 2414, 12]; // Fallback version
    }
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Connection update
    this.sock.ev.on('connection.update', (update) => {
      this.emit('connection', update);
    });

    // Messages
    this.sock.ev.on('messages.upsert', (upsert) => {
      this.emit('message', upsert);
    });

    // Groups
    this.sock.ev.on('groups.update', (update) => {
      this.emit('group', update);
    });
  }

  /**
   * Handle credentials update
   */
  async handleCredsUpdate() {
    try {
      await authManager.getSaveCreds()();
      logger.info('Credentials updated and saved');
    } catch (error) {
      logger.error('Failed to save credentials:', error);
    }
  }

  /**
   * Handle connection update
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      // QR code generated - we prefer pairing code for Termux
      logger.info('QR code generated, but pairing code is recommended for Termux');
      this.emit('qr', qr);
    }

    if (isNewLogin) {
      logger.info('New login detected');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('authenticated');
    }

    if (connection === 'connecting') {
      logger.info('Connecting to WhatsApp...');
    }

    if (connection === 'open') {
      logger.info('Connected to WhatsApp');
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('ready');
    }

    if (connection === 'close') {
      this.isConnected = false;
      const shouldReconnect = lastDisconnect.error instanceof Boom;
      
      if (shouldReconnect) {
        logger.warn('Connection closed, attempting to reconnect...');
        this.scheduleReconnect(lastDisconnect.error);
      } else {
        logger.info('Connection closed gracefully');
      }
      
      this.emit('disconnected', lastDisconnect);
    }
  }

  /**
   * Handle messages upsert
   */
  async handleMessagesUpsert(upsert) {
    try {
      const messages = upsert.messages;
      const type = upsert.type;

      if (!messages) return;

      // Process each message
      for (const msg of messages) {
        try {
          // Skip status messages and other non-user messages
          if (msg.key.fromMe || msg.pushName === 'status@broadcast') {
            continue;
          }

          // Normalize the message
          const normalizedMsg = this.normalizeMessage(msg);
          
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
      if (receipt.type === 'reaction') {
        const reaction = {
          type: 'reaction',
          key,
          receipt,
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
    const { key, pushName, message, participant, timestamp } = baileysMsg;
    
    const isGroup = key.remoteJid.endsWith('@g.us');
    const fromMe = key.fromMe;
    
    // Determine the actual sender
    let author = null;
    let from = key.remoteJid;
    
    if (isGroup && participant) {
      author = participant;
    } else if (!fromMe) {
      author = key.remoteJid.split('@')[0];
    }

    // Extract message body
    let body = '';
    let type = 'chat';
    let hasMedia = false;
    let isMedia = false;

    if (message) {
      if (message.conversation) {
        body = message.conversation;
        type = 'chat';
      } else if (message.extendedTextMessage) {
        body = message.extendedTextMessage.text;
        type = 'chat';
      } else if (message.imageMessage) {
        type = 'image';
        hasMedia = true;
        isMedia = true;
      } else if (message.videoMessage) {
        type = 'video';
        hasMedia = true;
        isMedia = true;
      } else if (message.stickerMessage) {
        type = 'sticker';
        hasMedia = true;
        isMedia = true;
      } else if (message.audioMessage) {
        type = 'audio';
        hasMedia = true;
        isMedia = true;
      } else if (message.pttMessage) {
        type = 'ptt';
        hasMedia = true;
        isMedia = true;
      } else if (message.reactionMessage) {
        type = 'reaction';
        body = message.reactionMessage.text;
      }
    }

    // Build normalized message
    const normalizedMsg = {
      id: { _serialized: key.id },
      from: from,
      fromMe: fromMe,
      author: author,
      body: body,
      type: type,
      timestamp: timestamp ? new Date(timestamp * 1000) : new Date(),
      hasMedia: hasMedia,
      isMedia: isMedia,
      pushName: pushName,
      isGroup: isGroup,
      chatId: key.remoteJid,
      // Add raw Baileys message for compatibility
      _baileys: baileysMsg,
      // Add reply function
      reply: async (content, chatId, options = {}) => {
        return this.sendMessage(chatId || from, content, options);
      },
      // Add downloadMedia function
      downloadMedia: async () => {
        return this.downloadMedia(baileysMsg);
      },
      // Add getChat function
      getChat: async () => {
        return this.getChat(key.remoteJid);
      },
      // Add getContact function
      getContact: async () => {
        return this.getContact(author || from);
      },
    };

    // Add quoted message support
    if (message && message.quotedMessage) {
      normalizedMsg.hasQuotedMsg = true;
      normalizedMsg._quoted = message.quotedMessage;
    }

    return normalizedMsg;
  }

  /**
   * Emit event to handlers
   */
  emit(event, data) {
    if (this.eventHandlers[event]) {
      for (const handler of this.eventHandlers[event]) {
        try {
          handler(data);
        } catch (error) {
          logger.error(`Error in ${event} handler:`, error);
        }
      }
    }
  }

  /**
   * On event
   */
  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
  }

  /**
   * Remove event handler
   */
  off(event, handler) {
    if (this.eventHandlers[event]) {
      const index = this.eventHandlers[event].indexOf(handler);
      if (index > -1) {
        this.eventHandlers[event].splice(index, 1);
      }
    }
  }

  /**
   * Send message
   */
  async sendMessage(jid, content, options = {}) {
    try {
      if (!this.sock) {
        throw new Error('Socket not initialized');
      }

      // Handle different content types
      if (typeof content === 'string') {
        // Text message
        await this.sock.sendMessage(jid, { text: content }, options);
      } else if (content.mimetype || content._data) {
        // Media message (from MessageMedia-like object)
        const media = {
          ...content,
        };
        await this.sock.sendMessage(jid, media, options);
      } else {
        // Unknown content type
        await this.sock.sendMessage(jid, { text: String(content) }, options);
      }
    } catch (error) {
      logger.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Download media from message
   */
  async downloadMedia(baileysMsg) {
    try {
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
      }

      if (!mediaMessage) {
        throw new Error('No media found in message');
      }

      // Download the media
      const stream = await this.sock.downloadMediaMessage(mediaMessage);
      const chunks = [];
      
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      return {
        data: buffer.toString('base64'),
        mimetype: mediaMessage.mimetype,
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
    try {
      if (!this.sock) {
        throw new Error('Socket not initialized');
      }

      // For now, return basic chat info
      // Baileys doesn't have a direct getChat method
      return {
        id: { _serialized: jid },
        isGroup: jid.endsWith('@g.us'),
        name: jid.split('@')[0],
      };
    } catch (error) {
      logger.error('Failed to get chat:', error);
      throw error;
    }
  }

  /**
   * Get contact info
   */
  async getContact(jid) {
    try {
      if (!this.sock) {
        throw new Error('Socket not initialized');
      }

      // For now, return basic contact info
      return {
        id: { _serialized: jid },
        name: jid.split('@')[0],
      };
    } catch (error) {
      logger.error('Failed to get contact:', error);
      throw error;
    }
  }

  /**
   * Request pairing code
   */
  async requestPairingCode(phoneNumber) {
    try {
      if (!this.sock) {
        throw new Error('Socket not initialized');
      }

      const code = await this.sock.requestPairingCode(phoneNumber);
      authManager.setPairingCode(code);
      authManager.setPairingNumber(phoneNumber);
      
      logger.info(`Pairing code requested for ${phoneNumber}: ${code}`);
      
      return code;
    } catch (error) {
      logger.error('Failed to request pairing code:', error);
      throw error;
    }
  }

  /**
   * Disconnect socket
   */
  async disconnect() {
    try {
      if (this.sock) {
        await this.sock.ws.close();
        this.isConnected = false;
        logger.info('Socket disconnected');
      }
    } catch (error) {
      logger.error('Error disconnecting socket:', error);
    }
  }

  /**
   * Schedule reconnect
   */
  scheduleReconnect(error) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.init();
      } catch (error) {
        logger.error('Reconnection failed:', error);
        this.scheduleReconnect(error);
      }
    }, delay);
  }

  /**
   * Get socket instance
   */
  getSocket() {
    return this.sock;
  }

  /**
   * Check if connected
   */
  isSocketConnected() {
    return this.isConnected;
  }
}

const socketManager = new SocketManager();

export default socketManager;
