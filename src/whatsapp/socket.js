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
   * Correctly uses fetchLatestWaWebVersion() for WhatsApp Web revision
   */
  async getWhatsAppRevision() {
    // If we already have a cached revision, return it
    if (this.whatsappRevision) {
      return this.whatsappRevision;
    }

    // Known-good cached revision for Baileys 7.0.0-rc14
    const cachedRevision = [2, 3000, 1015901307];

    try {
      // Create an abort controller for real timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      // Try to fetch live WhatsApp Web revision
      // Use fetchLatestWaWebVersion() which reads from WhatsApp Web service worker
      const waWebVersion = await fetchLatestWaWebVersion({
        timeout: 10000,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (waWebVersion && Array.isArray(waWebVersion)) {
        this.whatsappRevision = waWebVersion;
        logger.info(`Fetched WhatsApp Web revision: ${waWebVersion.join('.')}`);
        return waWebVersion;
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        logger.warn('WhatsApp Web revision fetch timed out, using cached revision');
      } else {
        logger.warn({ error: error.message }, 'Could not fetch WhatsApp Web revision');
      }
    }

    // Fallback to known-good revision
    this.whatsappRevision = cachedRevision;
    logger.warn(`Using cached WhatsApp Web revision: ${cachedRevision.join('.')}`);
    return cachedRevision;
  }

  /**
   * Get Baileys version info
   */
  async getBaileysVersion() {
    return {
      version: [2, 3000, 1015901307],
      isLatest: false
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
        version,
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
    this.sock.ev.on('device-list.update', update => this.handleDeviceListUpdate(update));
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
   */
  async handleMessageReaction(reaction) {
    try {
      const { key, reaction: reactionData } = reaction || {};
      if (!key || !reactionData) return;
      
      // Normalize reaction data
      const normalizedReaction = {
        type: 'reaction',
        key,
        reaction: {
          emoji: reactionData.text || '',
          timestamp: reactionData.timestamp,
        },
        isReactionToBot: this.isBotMessage(key),
        botMessage: this.isBotMessage(key) ? this.getBotSentMessage(key) : null,
        from: key.participant || key.remoteJid,
        remoteJid: key.remoteJid,
      };
      
      // Emit both for backward compatibility
      this.emit('message_reaction', normalizedReaction);
      this.emit('messages.reaction', [normalizedReaction]);
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

  /**
   * Handle groups update - with cache invalidation
   */
  async handleGroupsUpdate(update) {
    try {
      // Invalidate group cache for this group
      const groupJid = update?.id || update?.jid;
      if (groupJid) {
        const groups = await import('./groups.js');
        groups.default.invalidateCache(groupJid);
      }
      
      this.emit('group_update', update);
    } catch (error) {
      logger.error('Error in groups.update handler:', error);
    }
  }

  /**
   * Handle group participants update - with cache invalidation
   */
  async handleGroupParticipantsUpdate(update) {
    try {
      const { id, participants = [], action } = update || {};
      if (!id || !['add', 'remove'].includes(action)) return;
      
      // Invalidate group cache for this group
      const groups = await import('./groups.js');
      groups.default.invalidateCache(id);
      
      const notification = {
        ...update,
        id: { _serialized: id },
        participants,
        getChat: () => this.getChat(id),
        getRecipients: async () => Promise.all(participants.map(participantId => this.getContact(participantId))),
      };
      if (action === 'add') this.emit('group_join', notification);
      else this.emit('group_leave', notification);
    } catch (error) {
      logger.error({ error }, 'Group participant update handler failed');
    }
  }

  /**
   * Handle LID mapping update from Baileys
   * Updates the identity service with new LID ↔ PN mappings
   */
  async handleLidMappingUpdate(update) {
    try {
      const { lid, jid: pnJid } = update || {};
      if (!lid || !pnJid) return;
      
      // Normalize the JIDs
      const normalizedLid = identity.normalizeJid(lid);
      const normalizedPn = identity.normalizeJid(pnJid);
      
      // Add to identity service mapping
      identity.addLidPnMapping(normalizedLid, normalizedPn);
      
      logger.info(`LID mapping updated: ${normalizedLid} <-> ${normalizedPn}`);
    } catch (error) {
      logger.error({ error }, 'LID mapping update handler failed');
    }
  }

  /**
   * Handle device list update from Baileys
   * Extracts and updates LID ↔ PN mappings from device info
   */
  async handleDeviceListUpdate(update) {
    try {
      const { devices = [] } = update || {};
      
      for (const device of devices) {
        const lid = device?.id;
        const pnJid = device?.user;
        
        if (lid && pnJid) {
          const normalizedLid = identity.normalizeJid(lid);
          const normalizedPn = identity.normalizeJid(pnJid);
          
          // Add to identity service mapping
          identity.addLidPnMapping(normalizedLid, normalizedPn);
          
          logger.debug(`Device list LID mapping: ${normalizedLid} <-> ${normalizedPn}`);
        }
      }
    } catch (error) {
      logger.error({ error }, 'Device list update handler failed');
    }
  }

  /**
   * Normalize Baileys message to match expected format
   * Handles ALL Baileys v7 message types including wrapped messages
   */
  normalizeMessage(baileysMsg) {
    const key = baileysMsg?.key || {};
    
    // Use Baileys' normalizeMessageContent to unwrap ephemeral, viewOnce, edited messages
    const rawMessage = baileysMsg?.message || {};
    const message = normalizeMessageContent(rawMessage) || rawMessage || {};
    
    const remoteJid = key.remoteJid || '';
    const isGroup = remoteJid.endsWith('@g.us');
    const fromMe = Boolean(key.fromMe);
    
    // Handle LID (Lightweight ID) and PN (Phone Number) identities
    const participant = baileysMsg.participant || key.participant || (isGroup ? undefined : remoteJid);
    const author = isGroup ? participant : (fromMe ? this.getWid() || remoteJid : remoteJid);
    
    // Extract contextInfo from the unwrapped message
    const contextInfo = Object.values(message).find(value => value && typeof value === 'object' && value.contextInfo)?.contextInfo || {};
    const mentionedIds = contextInfo.mentionedJid || contextInfo.mentionedIds || [];
    
    // Handle alternate JIDs (LID/PN mapping in Baileys v7)
    const remoteJidAlt = baileysMsg.key?.remoteJidAlt || contextInfo?.remoteJidAlt;
    const participantAlt = baileysMsg.key?.participantAlt || contextInfo?.participantAlt;
    
    let body = '';
    let type = 'chat';
    let hasMedia = false;
    let isEphemeral = false;
    let isViewOnce = false;
    let isEdited = false;
    let isProtocol = false;
    
    // Check for wrapped message types first
    if (rawMessage.ephemeralMessage) {
      isEphemeral = true;
      // The actual message is inside ephemeralMessage
    }
    if (rawMessage.viewOnceMessage) {
      isViewOnce = true;
      // The actual message is inside viewOnceMessage
    }
    if (rawMessage.editedMessage) {
      isEdited = true;
      // The actual message is inside editedMessage
    }
    
    // Detect protocol messages
    if (message.protocolMessage) {
      isProtocol = true;
      type = 'protocol';
    }
    
    // Check all possible message types on the unwrapped message
    const mediaTypes = [
      ['imageMessage', 'image'],
      ['videoMessage', 'video'],
      ['stickerMessage', 'sticker'],
      ['audioMessage', 'audio'],
      ['documentMessage', 'document'],
      ['reactionMessage', 'reaction'],
    ];
    
    const interactiveTypes = [
      ['buttonsResponseMessage', 'buttons_response'],
      ['listResponseMessage', 'list_response'],
      ['templateButtonReplyMessage', 'template_button_reply'],
    ];
    
    const locationTypes = [
      ['locationMessage', 'location'],
      ['liveLocationMessage', 'live_location'],
    ];
    
    const contactTypes = [
      ['contactMessage', 'contact'],
      ['contactsArrayMessage', 'contacts'],
    ];
    
    const pollTypes = [
      ['pollCreationMessage', 'poll'],
      ['pollUpdateMessage', 'poll_update'],
    ];
    
    const groupTypes = [
      ['groupInviteMessage', 'group_invite'],
    ];
    
    if (message.conversation) {
      body = message.conversation;
    } else if (message.extendedTextMessage) {
      body = message.extendedTextMessage.text || '';
    } else {
      // Check media types
      for (const [keyName, messageType] of mediaTypes) {
        const node = message[keyName];
        if (!node) continue;
        type = messageType;
        if (['image', 'video', 'sticker', 'audio', 'document'].includes(messageType)) hasMedia = true;
        if (messageType === 'audio' && node.ptt) type = 'ptt';
        body = node.caption || node.text || '';
        break;
      }
      
      // Check interactive types
      if (type === 'chat') {
        for (const [keyName, messageType] of interactiveTypes) {
          const node = message[keyName];
          if (!node) continue;
          type = messageType;
          body = node.selectedButtonId || node.selectedRowId || node.selectedId || '';
          break;
        }
      }
      
      // Check location types
      if (type === 'chat') {
        for (const [keyName, messageType] of locationTypes) {
          const node = message[keyName];
          if (!node) continue;
          type = messageType;
          if (node.degreesLatitude !== undefined && node.degreesLongitude !== undefined) {
            body = `Location: ${node.degreesLatitude}, ${node.degreesLongitude}`;
          }
          break;
        }
      }
      
      // Check contact types
      if (type === 'chat') {
        for (const [keyName, messageType] of contactTypes) {
          const node = message[keyName];
          if (!node) continue;
          type = messageType;
          body = node.displayName || node.vcard || '';
          break;
        }
      }
      
      // Check poll types
      if (type === 'chat') {
        for (const [keyName, messageType] of pollTypes) {
          const node = message[keyName];
          if (!node) continue;
          type = messageType;
          body = node.name || node.pollCreationMessage?.name || '';
          break;
        }
      }
      
      // Check group invite types
      if (type === 'chat') {
        for (const [keyName, messageType] of groupTypes) {
          const node = message[keyName];
          if (!node) continue;
          type = messageType;
          body = node.groupJid || node.inviteCode || '';
          break;
        }
      }
    }

    const rawTimestamp = baileysMsg.messageTimestamp ?? baileysMsg.timestamp;
    const timestamp = Number(rawTimestamp?.toString?.() ?? rawTimestamp) || Math.floor(Date.now() / 1000);
    
    const normalized = {
      id: { _serialized: key.id || '' },
      from: remoteJid,
      fromMe,
      author,
      body,
      type,
      timestamp,
      hasMedia,
      isMedia: hasMedia,
      pushName: baileysMsg.pushName || '',
      isGroup,
      chatId: remoteJid,
      mentionedIds: Array.isArray(mentionedIds) ? mentionedIds : [],
      hasQuotedMsg: Boolean(contextInfo.quotedMessage && contextInfo.stanzaId),
      _quoted: contextInfo,
      _baileys: baileysMsg,
      _sock: this.sock,
      _client: this,
      _data: {
        id: key.id,
        from: remoteJid,
        to: remoteJid,
        body,
        type,
        timestamp: timestamp * 1000,
        fromMe,
        isGroup,
        notifyName: baileysMsg.pushName || '',
      },
      // LID/PN alternate identifiers
      remoteJidAlt,
      participantAlt,
      // Wrapper flags
      isEphemeral,
      isViewOnce,
      isEdited,
      isProtocol,
    };

    normalized.reply = async (content, chatId, options = {}) =>
      this.sendMessage(chatId || remoteJid, content, options, normalized);
    normalized.downloadMedia = async () => this.downloadMedia(baileysMsg);
    normalized.getChat = async () => this.getChat(remoteJid);
    normalized.getContact = async () => this.getContact(author || remoteJid);
    normalized.getMentions = async () => Promise.all(normalized.mentionedIds.map(id => this.getContact(id)));
    normalized.react = async emoji => this.react(key, emoji);
    normalized.getQuotedMessage = async () => {
      const quoted = contextInfo.quotedMessage;
      const quotedId = contextInfo.stanzaId;
      if (!quoted || !quotedId) return null;
      
      // Handle alternate JIDs for quoted messages
      const quotedParticipant = contextInfo.participant || contextInfo.participantAlt || (isGroup ? undefined : this.getWid());
      const quotedRemoteJid = contextInfo.remoteJid || contextInfo.remoteJidAlt || remoteJid;
      
      const quotedRaw = {
        key: { 
          remoteJid: quotedRemoteJid, 
          id: quotedId, 
          participant: quotedParticipant,
          fromMe: Boolean(quotedParticipant && (quotedParticipant === this.getWid() || quotedParticipant === this.sock?.user?.id)),
          remoteJidAlt: contextInfo.remoteJidAlt,
          participantAlt: contextInfo.participantAlt,
        },
        message: quoted,
        pushName: contextInfo.pushName || '',
        messageTimestamp: timestamp,
      };
      return this.normalizeMessage(quotedRaw);
    };
    normalized.delete = async everyone => this.deleteMessage(key, everyone !== false);
    normalized.pin = async (time = 2592000) => {
      if (!isGroup) return false;
      const allowedDurations = new Set([86400, 604800, 2592000]);
      const pinTime = allowedDurations.has(Number(time)) ? Number(time) : 2592000;
      return this.sock.sendMessage(remoteJid, { pin: key, type: 1, time: pinTime });
    };
    normalized.unpin = async () => {
      if (!isGroup) return false;
      return this.sock.sendMessage(remoteJid, { pin: key, type: 2 });
    };
    normalized.forward = async jid => this.forwardMessage(jid, baileysMsg);
    
    return normalized;
  }
  
  /**
   * Send a message
   * Central transport method - all messages should flow through here
   */
  async sendMessage(jid, content, options = {}, quotedMsg = null) {
    if (!this.sock) throw new Error('Socket not initialized');
    if (!jid) throw new TypeError('A recipient JID is required.');
    
    const normalizedJid = identity.normalizeJid(jid);
    
    try {
      let payload = toBaileysMediaPayload(content, options);
      if (!payload) {
        if (typeof content === 'string') payload = { text: content };
        else if (content && typeof content === 'object') payload = { ...content };
        else payload = { text: String(content ?? '') };
        if (Array.isArray(options.mentions) && options.mentions.length) payload.mentions = options.mentions;
        if (options.caption !== undefined && payload.caption === undefined) payload.caption = options.caption;
      }
      
      const sendOptions = {};
      if (options.quoted) sendOptions.quoted = options.quoted;
      else if (quotedMsg?._baileys) sendOptions.quoted = quotedMsg._baileys;
      if (options.linkPreview !== undefined) sendOptions.linkPreview = options.linkPreview;
      if (options.messageId) sendOptions.messageId = options.messageId;
      if (options.ephemeralSettings !== undefined) sendOptions.ephemeralSettings = options.ephemeralSettings;
      
      const result = await this.sock.sendMessage(normalizedJid, payload, sendOptions);
      if (result?.key) this.registerSentMessage(result.key, result);
      return result;
    } catch (error) {
      logger.error({ error, jid: normalizedJid }, 'Failed to send WhatsApp message');
      throw error;
    }
  }

  /**
   * Delete a message
   */
  async deleteMessage(key, everyone = true) {
    if (!this.sock) throw new Error('Socket not initialized');
    const messageKey = key?.id ? { ...key } : null;
    if (!messageKey?.remoteJid) throw new TypeError('A valid Baileys message key is required for deletion.');
    if (!everyone) return false;
    
    const normalizedKey = {
      ...messageKey,
      remoteJid: identity.normalizeJid(messageKey.remoteJid),
    };
    
    return this.sock.sendMessage(normalizedKey.remoteJid, { delete: normalizedKey });
  }

  /**
   * Forward a message
   * Uses Baileys native forwarding mechanism
   */
  async forwardMessage(jid, baileysMsg) {
    if (!this.sock) {
      throw new Error('Socket not initialized');
    }

    try {
      const { key, message } = baileysMsg;
      const forwardMsg = { ...message, key: { ...key } };
      delete forwardMsg.key.id;
      
      // Normalize JIDs in the forwarded message
      if (forwardMsg.key) {
        forwardMsg.key.remoteJid = identity.normalizeJid(forwardMsg.key.remoteJid);
        if (forwardMsg.key.participant) {
          forwardMsg.key.participant = identity.normalizeJid(forwardMsg.key.participant);
        }
      }
      
      const normalizedJid = identity.normalizeJid(jid);
      
      const result = await this.sock.sendMessage(normalizedJid, {
        forward: forwardMsg,
      });
      
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
   * Edit a message
   * Uses Baileys editMessage if available, falls back to delete+send
   */
  async editMessage(key, newContent, options = {}) {
    if (!this.sock) throw new Error('Socket not initialized');
    
    const messageKey = key?.id ? { ...key } : null;
    if (!messageKey?.remoteJid) throw new TypeError('A valid Baileys message key is required for editing.');
    
    const normalizedKey = {
      ...messageKey,
      remoteJid: identity.normalizeJid(messageKey.remoteJid),
    };
    
    // Try to use Baileys native editMessage if available
    if (this.sock.editMessage) {
      try {
        const payload = typeof newContent === 'string' 
          ? { text: newContent }
          : newContent;
        
        const result = await this.sock.editMessage(normalizedKey.remoteJid, normalizedKey, payload, options);
        if (result) {
          // Update our sent message registry
          if (result.key) {
            this.sentMessages.delete(normalizedKey.id || normalizedKey._serialized);
            this.registerSentMessage(result.key, result);
          }
          return result;
        }
      } catch (error) {
        logger.warn('editMessage not supported or failed, falling back to delete+send:', error.message);
      }
    }
    
    // Fallback: delete and send new message
    await this.deleteMessage(normalizedKey, true);
    return this.sendMessage(normalizedKey.remoteJid, newContent, options);
  }

  /**
   * Download media from a message
   */
  async downloadMedia(baileysMsg) {
    return downloadBaileysMedia(this.sock, baileysMsg);
  }

  /**
   * Get chat info
   */
  async getChat(jid) {
    if (!this.sock) throw new Error('Socket not initialized');
    const isGroup = Boolean(jid?.endsWith('@g.us'));
    if (!isGroup) {
      const id = { _serialized: jid };
      return {
        id, name: jid?.split('@')[0] || jid, isGroup: false, participants: [],
        sendMessage: (content, options = {}) => this.sendMessage(jid, content, options),
      };
    }
    const group = await (await import('./groups.js')).default.getGroup(jid);
    return {
      ...group,
      sendMessage: (content, options = {}) => this.sendMessage(jid, content, options),
      setMessagesAdminsOnly: onlyAdmins => this.sock.groupSettingUpdate(jid, onlyAdmins ? 'announcement' : 'not_announcement'),
      leave: () => this.sock.groupLeave(jid),
    };
  }

  /**
   * Get contact info
   */
  async getContact(jid) {
    if (!jid) throw new TypeError('A contact JID is required.');
    const serialized = String(jid);
    
    // Handle LID format (e.g., 123456@lid)
    let number;
    let isLid = false;
    
    if (serialized.includes('@')) {
      const parts = serialized.split('@');
      number = parts[0];
      isLid = parts[1] === 'lid';
    } else {
      number = serialized;
    }
    
    // Use identity service for proper resolution
    const identityResult = identity.resolveIdentity(serialized);
    const name = identityResult?.displayName || number;
    const isMe = serialized === this.getWid();
    
    return {
      id: { _serialized: serialized, user: number },
      number,
      name,
      pushname: name,
      pushName: name,
      isMe,
      isLid,
      canonicalId: identityResult?.canonicalId,
      phoneNumber: identityResult?.phoneNumber,
    };
  }

  /**
   * React to a message
   */
  async react(key, emoji) {
    if (!this.sock) throw new Error('Socket not initialized');
    const messageKey = key?.id ? { ...key } : null;
    if (!messageKey?.remoteJid) throw new TypeError('A valid Baileys message key is required for reaction.');
    
    const normalizedKey = {
      ...messageKey,
      remoteJid: identity.normalizeJid(messageKey.remoteJid),
    };
    
    return this.sock.sendMessage(normalizedKey.remoteJid, { react: { text: String(emoji || ''), key: normalizedKey } });
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

const socketManager = new SocketManager();
export default socketManager;
