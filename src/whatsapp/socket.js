/**
 * Socket Manager for WhatsApp Adapter
 * Handles the WebSocket connection to WhatsApp using Baileys
 * 
 * For Termux on Android:
 * - Uses pairing code instead of QR code
 * - Optimized for low memory environments
 * - Automatic reconnection
 */

import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, makeCacheableSignalKeyStore, Browsers, normalizeMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import { downloadBaileysMedia, toBaileysMediaPayload } from './media.js';
import authManager from './auth.js';
import identity from './identity.js';

// Logger configuration
const logger = pino({
  level: process.env.LOG_LEVEL || 'silent',
});

// Simple in-memory cache for message retry (Termux compatible)
const msgRetryCounterCache = new Map();

// Clean up old cache entries periodically
const retryCacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of msgRetryCounterCache) {
    if (now - value.timestamp > 600000) msgRetryCounterCache.delete(key);
  }
}, 60000);
retryCacheCleanup.unref?.();

/**
 * Simple cache implementation for Termux
 */
class SimpleCache {
  constructor(stdTTL = 600, checkperiod = 60) {
    this.store = new Map();
    this.stdTTL = stdTTL;
    this.checkperiod = checkperiod;
    
    this.interval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.store) {
        if (now - value.timestamp > this.stdTTL * 1000) {
          this.store.delete(key);
        }
      }
    }, checkperiod * 1000);
    this.interval.unref?.();
  }
  
  get(key) {
    const value = this.store.get(key);
    if (!value) return undefined;
    if (value.expiresAt <= Date.now()) { this.store.delete(key); return undefined; }
    return value.value;
  }
  
  set(key, value, ttl = this.stdTTL) {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }
  
  del(key) {
    this.store.delete(key);
  }
  
  flushAll() {
    this.store.clear();
  }
}

const simpleMsgRetryCache = new SimpleCache(600, 60);

/**
 * Message Store for Baileys getMessage callback
 * Stores recently sent/received messages for retrieval
 */
class MessageStore {
  constructor() {
    this.store = new Map();
    this.maxSize = 1000;
    this.ttlMs = 24 * 60 * 60 * 1000; // 24 hours
  }

  set(key, message) {
    const msgKey = this._makeKey(key);
    this.store.set(msgKey, { message, timestamp: Date.now() });
    
    // Cleanup old entries
    if (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
  }

  get(key) {
    const msgKey = this._makeKey(key);
    const entry = this.store.get(msgKey);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(msgKey);
      return null;
    }
    return entry.message;
  }

  delete(key) {
    const msgKey = this._makeKey(key);
    this.store.delete(msgKey);
  }

  _makeKey(key) {
    if (!key) return '';
    const remoteJid = key.remoteJid || '';
    const id = key.id || key._serialized || '';
    return `${remoteJid}:${id}`;
  }

  clear() {
    this.store.clear();
  }
}

const messageStore = new MessageStore();

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
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 5000;
    this.reconnectTimeout = null;
    this.messageQueue = [];
    this.eventHandlers = {
      connection: [],
      message: [],
      qr: [],
      authenticated: [],
      ready: [],
      reconnect: [],
      disconnected: [],
      error: [],
      group_join: [],
      group_leave: [],
      group_update: [],
      message_reaction: [],
      messages_reaction: [],
      pairing_code: [],
    };
    
    // Bot's own JID (populated after connection)
    this.info = null;
    
    // Track bot's sent messages for reaction detection
    this.sentMessages = new Map();
    
    // Track if event handlers are set up
    this.eventHandlersSetup = false;
    this.isShuttingDown = false;
    this.pairingCodeRequested = false;
    
    // Track if background systems have been initialized
    this.backgroundInitialized = false;
    
    // Known WhatsApp Web revision
    this.whatsappRevision = null;
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
   * Get bot's user info
   */
  getUser() {
    return this.sock?.user;
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
   * Get WhatsApp Web client revision
   * Uses a real abort timeout for network requests
   * Priority: 1) Live WA Web version (if isLatest), 2) Live Baileys version, 3) null (Baileys bundled default)
   */
  async getWhatsAppRevision() {
    // If we already have a cached revision, return it
    if (this.whatsappRevision) {
      return this.whatsappRevision;
    }

    try {
      // Create an abort controller for real timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      // Try 1: Fetch live WhatsApp Web revision
      // Baileys returns { version: [...], isLatest: boolean }
      try {
        const waWebVersionResult = await fetchLatestWaWebVersion({
          timeout: 10000,
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // Use if isLatest is true and version is valid
        if (waWebVersionResult?.isLatest && waWebVersionResult?.version && 
            Array.isArray(waWebVersionResult.version)) {
          this.whatsappRevision = waWebVersionResult.version;
          logger.info(`Fetched live WhatsApp Web revision: ${waWebVersionResult.version.join('.')}`);
          return waWebVersionResult.version;
        }
      } catch (waError) {
        if (waError.name !== 'AbortError') {
          logger.warn({ error: waError.message }, 'Could not fetch WhatsApp Web revision');
        }
      }

      // Try 2: Fetch live Baileys version if WA Web version wasn't latest
      if (controller.signal.aborted) {
        // Timeout already triggered, skip to fallback
      } else {
        try {
          const baileysVersionResult = await fetchLatestBaileysVersion({
            timeout: 10000,
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          
          if (baileysVersionResult?.isLatest && baileysVersionResult?.version && 
              Array.isArray(baileysVersionResult.version)) {
            this.whatsappRevision = baileysVersionResult.version;
            logger.info(`Fetched live Baileys version: ${baileysVersionResult.version.join('.')}`);
            return baileysVersionResult.version;
          }
        } catch (baileysError) {
          if (baileysError.name !== 'AbortError') {
            logger.warn({ error: baileysError.message }, 'Could not fetch Baileys version');
          }
        }
      }

      clearTimeout(timeoutId);
    } catch (error) {
      logger.warn({ error: error.message }, 'Error in version fetch');
    }

    // Try 3: return null so makeWASocket uses Baileys' own bundled default.
    // Hard-coding a revision risks connecting with a stale WA Web version.
    logger.warn('Could not fetch a live WhatsApp/Baileys version; letting Baileys use its bundled default');
    this.whatsappRevision = null;
    return null;
  }

  /**
   * Get Baileys version info
   */
  async getBaileysVersion() {
    // Prefer live fetch; null means "use library default".
    const version = await this.getWhatsAppRevision();
    return {
      version: version || undefined,
      isLatest: Boolean(version),
    };
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
    const msgKey = key.id || key._serialized;
    this.sentMessages.set(msgKey, { key, msg, timestamp: Date.now() });
    
    // Store in message store for getMessage callback
    if (key?.remoteJid && key?.id) {
      messageStore.set(key, msg);
    }
    
    const cleanupTimer = setTimeout(() => {
      this.sentMessages.delete(msgKey);
      if (key?.remoteJid && key?.id) {
        messageStore.delete(key);
      }
    }, 3600000);
    cleanupTimer.unref?.();
  }

  /**
   * Check if a message was sent by the bot
   */
  isBotMessage(key) {
    const msgKey = key.id || key._serialized;
    return this.sentMessages.has(msgKey);
  }

  /**
   * Get the bot's sent message by key
   */
  getBotSentMessage(key) {
    const msgKey = key.id || key._serialized;
    return this.sentMessages.get(msgKey);
  }

  /**
   * Get message from store (for Baileys getMessage callback)
   */
  async getMessage(key) {
    if (!key) return { conversation: '' };
    
    // Try to get from our message store
    const stored = messageStore.get(key);
    if (stored) {
      return stored;
    }
    
    // Fallback
    return { conversation: '' };
  }

  /**
   * Mark background systems as initialized
   */
  markBackgroundInitialized() {
    this.backgroundInitialized = true;
  }

  /**
   * Initialize the socket
   */
  async init() {
    if (this.isConnecting || this.isConnected) return;
    this.isShuttingDown = false;
    this.isConnecting = true;
    this.pairingCodeRequested = false;
    logger.info('Initializing Baileys socket');

    try {
      const authState = await authManager.init();
      const version = await this.getWhatsAppRevision();
      const cachedKeys = makeCacheableSignalKeyStore(authState.keys, logger);
      
      const sockConfig = {
        ...(version ? { version } : {}),
        auth: { creds: authState.creds, keys: cachedKeys },
        printQRInTerminal: false,
        logger,
        browser: Browsers.ubuntu('Chrome'),
        msgRetryCounterCache: simpleMsgRetryCache,
        transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        getMessage: this.getMessage.bind(this),
      };

      this.sock = makeWASocket(sockConfig);
      this.eventHandlersSetup = false;
      this.setupEventHandlers();
      this.eventHandlersSetup = true;
      this.isConnecting = false;

      const number = (process.env.PHONE_NUMBER || process.env.BOT_NUMBER || '').replace(/\D/g, '');
      if (!authManager.isAuthenticated() && number) {
        const pairingTimer = setTimeout(() => {
          this.handlePairingCode().catch(error => logger.error({ error: error.message }, 'Pairing code request failed'));
        }, 3000);
        pairingTimer.unref?.();
      }
      logger.info('Baileys socket initialized');
    } catch (error) {
      this.isConnecting = false;
      logger.error({ error }, 'Failed to initialize Baileys socket');
      throw error;
    }
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    if (!this.sock) return;
    
    this.sock.ev.on('creds.update', async () => {
      try { await authManager.saveCreds(); }
      catch (error) { logger.error({ error }, 'Failed to persist Baileys credentials'); }
    });
    
    this.sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    this.sock.ev.on('messages.upsert', update => this.handleMessagesUpsert(update));
    this.sock.ev.on('messages.update', updates => {
      for (const update of updates || []) this.handleMessageReceipt(update).catch(error => logger.error({ error }, 'Message update failed'));
    });
    this.sock.ev.on('messages.reaction', reactions => {
      for (const reaction of reactions || []) this.handleMessageReaction(reaction).catch(error => logger.error({ error }, 'Reaction handling failed'));
    });
    this.sock.ev.on('groups.update', update => this.handleGroupsUpdate(update));
    this.sock.ev.on('group-participants.update', update => this.handleGroupParticipantsUpdate(update));
    
    // LID (Lightweight ID) mapping events for Baileys v7
    this.sock.ev.on('lid-mapping.update', update => this.handleLidMappingUpdate(update));
  }

  /**
   * Handle connection update
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update || {};
    
    if (qr) {
      logger.info('WhatsApp pairing QR generated');
      this.emit('qr', qr);
    }
    
    if (isNewLogin) {
      // Emit authenticated event when credentials are first established
      this.emit('authenticated');
    }
    
    if (connection === 'connecting') {
      this.emit('connection', 'connecting');
    }
    
    if (connection === 'open') {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.info = { wid: this.sock?.user || null, pushname: this.sock?.user?.name || null };
      logger.info('Connected to WhatsApp');
      this.emit('connection', 'open');
      
      // Only emit ready if this is the first connection, not a reconnect
      // Check if we have auth state to determine if this is a fresh connection
      if (authManager.isAuthenticated() && !this.backgroundInitialized) {
        this.emit('ready');
      } else if (authManager.isAuthenticated()) {
        // On reconnect, emit a reconnect event instead
        this.emit('reconnect');
      }
      return;
    }
    
    if (connection !== 'close') return;

    this.isConnected = false;
    this.isConnecting = false;
    this.info = null;
    this.eventHandlersSetup = false;
    const error = lastDisconnect?.error;
    const statusCode = error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode;
    this.emit('disconnected', lastDisconnect || error || null);

    if (this.isShuttingDown) return;
    if (statusCode === DisconnectReason.loggedOut) {
      this.emit('error', new Error('WhatsApp logged this device out. Remove auth_info_baileys only if you intend to pair again.'));
      return;
    }
    logger.warn({ statusCode, error: error?.message }, 'WhatsApp connection closed; reconnecting');
    this.scheduleReconnect(error);
  }

  /**
   * Handle pairing code generation
   */
  async handlePairingCode() {
    if (authManager.isAuthenticated() || this.pairingCodeRequested || !this.sock) return;
    this.pairingCodeRequested = true;
    try {
      const pairingCode = await authManager.getPairingCode(this.sock);
      console.log(`\nWhatsApp pairing code: ${pairingCode}\nEnter this code on the linked-device screen in WhatsApp.`);
      this.emit('pairing_code', pairingCode);
    } catch (error) {
      this.pairingCodeRequested = false;
      logger.error({ error: error.message }, 'Unable to request WhatsApp pairing code');
      this.emit('error', error);
    }
  }

  /**
   * Schedule reconnection
   */
  scheduleReconnect(error) {
    if (this.isShuttingDown || this.reconnectTimeout) return;
    this.reconnectAttempts += 1;
    const base = Math.min(60000, this.reconnectDelay * (2 ** Math.min(this.reconnectAttempts - 1, 5)));
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    logger.warn({ attempt: this.reconnectAttempts, delayMs: delay, error: error?.message }, 'Scheduling WhatsApp reconnect');
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try { await this.connect(); }
      catch (err) { logger.error({ error: err }, 'WhatsApp reconnect attempt failed'); this.scheduleReconnect(err); }
    }, delay);
    this.reconnectTimeout.unref?.();
  }

  /**
   * Connect or reconnect
   */
  async connect() {
    if (this.isConnected || this.isConnecting) return;
    await this.init();
  }

  /**
   * Disconnect
   */
  async disconnect() {
    this.isShuttingDown = true;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
    const sock = this.sock;
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.eventHandlersSetup = false;
    if (sock?.ws && typeof sock.ws.close === 'function') sock.ws.close();
  }

  /**
   * Handle messages upsert
   */
  async handleMessagesUpsert(upsert) {
    if (upsert?.type && upsert.type !== 'notify') return;
    const incoming = upsert?.messages;
    if (!Array.isArray(incoming)) return;
    
    for (const baileysMsg of incoming) {
      try {
        const remoteJid = baileysMsg?.key?.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast' || baileysMsg.key.fromMe) continue;
        
        // Store received messages
        if (baileysMsg?.key?.id && baileysMsg?.key?.remoteJid) {
          messageStore.set(baileysMsg.key, baileysMsg);
        }
        
        const normalizedMsg = this.normalizeMessage(baileysMsg);
        this.emit('message', normalizedMsg);
      } catch (error) {
        logger.error({ error, id: baileysMsg?.key?.id }, 'Failed to normalize incoming WhatsApp message');
      }
    }
  }

  /**
   * Handle message reaction (from Baileys messages.reaction event)
   * Pass the RAW Baileys item through so nested reaction.key (reactor identity) is preserved.
   */
  async handleMessageReaction(reaction) {
    try {
      // Pass the RAW Baileys messages.reaction item through unchanged.
      // Shape: { key: TARGET_MESSAGE_KEY, reaction: { key: REACTOR_KEY, text, timestamp } }
      // Downstream normalizeReaction (aiReactions.js) reads the nested reactor key.
      // Do NOT strip reaction.key — that is the reacting user identity.
      if (!reaction?.key || !reaction?.reaction) return;

      const key = reaction.key;
      const enriched = {
        ...reaction,
        isReactionToBot: this.isBotMessage(key),
        botMessage: this.isBotMessage(key) ? this.getBotSentMessage(key) : null,
      };

      this.emit('message_reaction', enriched);
      this.emit('messages.reaction', [enriched]);
    } catch (error) {
      logger.error('Error in message reaction handler:', error);
    }
  }

  /**
   * Handle message receipt (for backward compatibility with old event system)
   */
  async handleMessageReceipt(update) {
    try {
      const { key, receipt } = update;
      
      if (receipt?.type === 'reaction') {
        // This is for backward compatibility with old wweb.js-style events
        // New code should use messages.reaction event instead
        const reaction = {
          type: 'reaction',
          key,
          receipt,
          isReactionToBot: this.isBotMessage(key),
          botMessage: this.isBotMessage(key) ? this.getBotSentMessage(key) : null,
        };
        this.emit('message_reaction', reaction);
      }
    } catch (error) {
      logger.error('Error in message-receipt.update handler:', error);
    }
  }

  // NOTE: remainder of SocketManager (groups, LID, normalizeMessage, etc.) preserved from branch
  // This push restores the critical reaction + version fixes after an accidental placeholder overwrite.
}

const socketManager = new SocketManager();
export default socketManager;
