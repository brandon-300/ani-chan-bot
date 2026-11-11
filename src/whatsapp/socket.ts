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
import { WHATSAPP_LOG_LEVEL } from '../utils/config.js';

// Logger configuration
const logger = pino({
  level: WHATSAPP_LOG_LEVEL,
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

  static getInstance() {
    if (!this.instance) {
      this.instance = new SocketManager();
    }
    return this.instance;
  }

  getSocket() {
    return this.sock;
  }

  getWid() {
    return this.info?.wid?._serialized || this.sock?.user?.id;
  }

  getUser() {
    return this.sock?.user;
  }

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

  async getWhatsAppRevision() {
    if (this.whatsappRevision) {
      return this.whatsappRevision;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      try {
        const waWebVersionResult = await fetchLatestWaWebVersion({
          timeout: 10000,
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
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

      if (!controller.signal.aborted) {
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
    // Never hard-code a revision — Baileys ships a known-good version.
    this.whatsappRevision = null;
    logger.warn('Could not fetch live WA version; using Baileys library default');
    return null;
  }

  async getBaileysVersion() {
    // Prefer live fetch; never invent a revision number.
    try {
      const result = await fetchLatestBaileysVersion();
      if (result?.version) return result;
    } catch {}
    return { version: null, isLatest: false };
  }

  isAuthenticated() {
    return this.isConnected && this.sock && authManager.isAuthenticated();
  }

  registerSentMessage(key, msg) {
    const msgKey = key.id || key._serialized;
    this.sentMessages.set(msgKey, { key, msg, timestamp: Date.now() });
    
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

  isBotMessage(key) {
    const msgKey = key.id || key._serialized;
    return this.sentMessages.has(msgKey);
  }

  getBotSentMessage(key) {
    const msgKey = key.id || key._serialized;
    return this.sentMessages.get(msgKey);
  }

  async getMessage(key) {
    if (!key) return { conversation: '' };
    const stored = messageStore.get(key);
    if (stored) return stored;
    return { conversation: '' };
  }

  markBackgroundInitialized() {
    this.backgroundInitialized = true;
  }

  // Services (messages, media, groups, identity) keep a reference to the socket they
  // send through. A reconnect creates a NEW socket, so each of them has to be handed
  // the new one, otherwise every reply after the first connection drop would go
  // through the dead socket and fail with "Connection Closed".
  onSocketCreated(listener) {
    if (typeof listener !== 'function') return;
    if (!this.socketCreatedListeners) this.socketCreatedListeners = new Set();
    this.socketCreatedListeners.add(listener);
  }

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
      for (const listener of this.socketCreatedListeners || []) {
        try { listener(this.sock); }
        catch (error) { logger.error({ error }, 'Socket-created listener failed'); }
      }
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
    this.sock.ev.on('lid-mapping.update', update => this.handleLidMappingUpdate(update));
  }

  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update || {};
    
    if (qr) {
      logger.info('WhatsApp pairing QR generated');
      this.emit('qr', qr);
    }
    
    if (isNewLogin) {
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
      
      if (authManager.isAuthenticated() && !this.backgroundInitialized) {
        this.emit('ready');
      } else if (authManager.isAuthenticated()) {
        console.log('\u2705 WhatsApp reconnected');
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
      console.error([
        '',
        '❌ WhatsApp rejected the saved Baileys login (401 / logged out).',
        '   The session in auth_info_baileys is no longer linked to the account.',
        '   To pair again, move it aside and start the bot in the foreground:',
        '     mv auth_info_baileys auth_info_baileys.old-$(date +%s)',
        '     node src/index.js',
        '   (this does NOT touch the whatsapp-web.js session)',
        '',
      ].join('\n'));
      // Exit code 64 is listed in ecosystem.config.cjs as "do not restart", so PM2
      // shows the process as stopped instead of retrying a login WhatsApp already
      // refused (or leaving a dead bot that still looks online).
      process.exitCode = 64;
      setTimeout(() => process.exit(64), 300);
      return;
    }
    logger.warn({ statusCode, error: error?.message }, 'WhatsApp connection closed; reconnecting');
    this.scheduleReconnect(error);
  }

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

  async connect() {
    if (this.isConnected || this.isConnecting) return;
    await this.init();
  }

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

  // Upserts are processed one at a time, in arrival order: resolving ids touches
  // the LID store (async), and two batches must never overtake each other.
  handleMessagesUpsert(upsert) {
    this.upsertChain = (this.upsertChain || Promise.resolve())
      .then(() => this.processMessagesUpsert(upsert))
      .catch(error => logger.error({ error }, 'Failed to process messages.upsert'));
    return this.upsertChain;
  }

  async processMessagesUpsert(upsert) {
    if (upsert?.type && upsert.type !== 'notify') return;
    const incoming = upsert?.messages;
    if (!Array.isArray(incoming)) return;
    
    for (const baileysMsg of incoming) {
      try {
        const remoteJid = baileysMsg?.key?.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast' || baileysMsg.key.fromMe) continue;
        
        if (baileysMsg?.key?.id && baileysMsg?.key?.remoteJid) {
          messageStore.set(baileysMsg.key, baileysMsg);
        }

        // LID -> phone-number ids must be known before the message is normalized.
        await identity.learnIds(baileysMsg);

        // Exactly one bot version may act on a message: the whatsapp-web.js and Baileys
        // versions share one account, and a version that was offline is sent every
        // message it missed when it starts again. See utils/messageClaims.js.
        const { claimMessage } = await import('../utils/messageClaims.js');
        if (!(await claimMessage(baileysMsg.key.id))) continue;
        
        const normalizedMsg = this.normalizeMessage(baileysMsg);
        this.emit('message', normalizedMsg);
      } catch (error) {
        logger.error({ error, id: baileysMsg?.key?.id }, 'Failed to normalize incoming WhatsApp message');
      }
    }
  }

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

  async handleMessageReceipt(update) {
    try {
      const { key, receipt } = update;
      if (receipt?.type === 'reaction') {
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

  async handleGroupsUpdate(update) {
    try {
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

  async handleGroupParticipantsUpdate(update) {
    try {
      const { id, participants, action, author } = update || {};
      if (id) {
        // Refresh membership BEFORE emitting, so notification.getChat() is current.
        const groups = await import('./groups.js');
        groups.default.invalidateCache(id);
      }
      if (action !== 'add' && action !== 'remove') return;

      // Baileys 7 reports participants as strings or as { id, phoneNumber, ... }.
      for (const p of participants || []) {
        if (p && typeof p === 'object' && p.id && p.phoneNumber) identity.addLidPnMapping(p.id, p.phoneNumber);
      }
      const recipientIds = (participants || [])
        .map(p => (typeof p === 'string' ? p : p?.id))
        .filter(Boolean)
        .map(jid => this.exposeId(jid));
      const authorId = author ? this.exposeId(author) : '';

      // Same shape whatsapp-web.js gave commands/admin.js: chatId, recipientIds,
      // getChat(), getRecipients().
      const notification = {
        groupJid: id,
        chatId: id,
        action,
        participants,
        recipientIds,
        author: authorId,
        getChat: () => this.getChat(id),
        getRecipients: async () => Promise.all(recipientIds.map(jid => identity.getContact(jid))),
        getContact: async () => (authorId ? identity.getContact(authorId) : null),
      };
      this.emit(action === 'add' ? 'group_join' : 'group_leave', notification);
    } catch (error) {
      logger.error('Error in group-participants.update handler:', error);
    }
  }

  async handleLidMappingUpdate(update) {
    try {
      // Baileys 7: { lid, pn } (or a list of them) whenever WhatsApp reveals a mapping.
      for (const item of Array.isArray(update) ? update : [update]) {
        if (item?.lid && item?.pn) identity.addLidPnMapping(item.lid, item.pn);
      }
    } catch (error) {
      logger.error('Error in lid-mapping.update handler:', error);
    }
  }

  // Chat object (group or DM) in the whatsapp-web.js shape, used by msg.getChat()
  // and client.getChatById().
  async getChat(jid) {
    const groups = (await import('./groups.js')).default;
    return groups.getChat(jid);
  }

  // True for the bot's own phone-number id AND its LID (LID-addressed groups
  // and mentions use the LID).
  isOwnJid(jid) {
    const user = this.sock?.user;
    if (!user || !jid) return false;
    const target = identity.normalizeJid(jid);
    return [user.id, user.lid].filter(Boolean).some(own => identity.normalizeJid(own) === target);
  }

  // Id commands see for a participant/mention: the bot always appears as its
  // phone-number id (what client.info.wid reports), whichever way WhatsApp spelled it.
  exposeId(jid) {
    if (!jid) return '';
    if (this.isOwnJid(jid)) return identity.toLegacyId(this.sock.user.id);
    return identity.toStoredId(jid);
  }

  normalizeMessage(baileysMsg) {
    if (!baileysMsg) return null;
    const key = baileysMsg.key || {};
    const rawMessage = baileysMsg.message;
    const message = normalizeMessageContent(rawMessage) || rawMessage || {};

    const remoteJid = key.remoteJid || '';
    const isGroup = remoteJid.endsWith('@g.us');
    identity.learnFromKey(key);

    // Same meaning as whatsapp-web.js, which every command was written against:
    //   msg.from   = the CHAT (the group, or the other person in a DM)
    //   msg.author = the SENDER inside a group ('' in a DM)
    // Ids use the legacy spelling (see identity.toLegacyId) so they match what is
    // stored in MongoDB. Raw Baileys values stay on msg._baileys / msg.key.
    const senderJid = isGroup ? (key.participant || '') : remoteJid;
    const chatId = this.exposeId(remoteJid);
    const author = isGroup ? this.exposeId(senderJid) : '';

    let body = '';
    let type = 'chat';
    let hasMedia = false;

    if (message.conversation) {
      body = message.conversation;
      type = 'chat';
    } else if (message.extendedTextMessage) {
      body = message.extendedTextMessage.text || '';
      type = 'chat';
    } else if (message.imageMessage) {
      body = message.imageMessage.caption || '';
      type = 'image';
      hasMedia = true;
    } else if (message.videoMessage) {
      body = message.videoMessage.caption || '';
      type = 'video';
      hasMedia = true;
    } else if (message.audioMessage) {
      type = message.audioMessage.ptt ? 'ptt' : 'audio';
      hasMedia = true;
    } else if (message.stickerMessage) {
      type = 'sticker';
      hasMedia = true;
    } else if (message.documentMessage) {
      body = message.documentMessage.caption || message.documentMessage.fileName || '';
      type = 'document';
      hasMedia = true;
    } else if (message.contactMessage) {
      type = 'vcard';
    } else if (message.locationMessage) {
      type = 'location';
    }

    // Every message type carries its own contextInfo (quote + mentions).
    let contextInfo = null;
    for (const value of Object.values(message)) {
      if (value && typeof value === 'object' && value.contextInfo) { contextInfo = value.contextInfo; break; }
    }
    const quoted = contextInfo?.quotedMessage || null;
    const quotedId = contextInfo?.stanzaId || null;
    const quotedParticipant = contextInfo?.participant || null;
    const mentionedIds = [...new Set((contextInfo?.mentionedJid || []).map(jid => this.exposeId(jid)).filter(Boolean))];

    const botLegacyId = this.sock?.user?.id ? identity.toLegacyId(this.sock.user.id) : undefined;
    const pushName = baileysMsg.pushName || '';

    const normalized = {
      id: { _serialized: key.id, id: key.id, remote: remoteJid, fromMe: key.fromMe },
      from: chatId,
      to: key.fromMe ? chatId : botLegacyId,
      author,
      body,
      type,
      timestamp: baileysMsg.messageTimestamp,
      fromMe: Boolean(key.fromMe),
      hasMedia,
      isGroup,
      chatId,
      pushName,
      mentionedIds,
      hasQuotedMsg: Boolean(quoted),
      _baileys: baileysMsg,
      key,

      // whatsapp-web.js signature, which ~70 call sites use:
      //   msg.reply(content, chatId?, options?)   e.g. msg.reply(media, undefined, { caption })
      // The second argument is an optional chat id, NOT the options. Treating it as
      // options silently dropped every caption, mention, sticker and voice-note flag.
      // msg.reply(content, { ...options }) is accepted as well.
      reply: async (content, chatIdOrOptions, maybeOptions) => {
        const messages = (await import('./messages.js')).default;
        let options = {};
        let targetChat = null;
        if (typeof chatIdOrOptions === 'string' && chatIdOrOptions) {
          targetChat = chatIdOrOptions;
          options = maybeOptions || {};
        } else if (chatIdOrOptions && typeof chatIdOrOptions === 'object') {
          options = chatIdOrOptions;
        } else {
          options = maybeOptions || {};
        }
        if (targetChat && identity.normalizeJid(targetChat) !== identity.normalizeJid(remoteJid)) {
          return messages.sendMessage(identity.normalizeJid(targetChat), content, options);
        }
        return messages.reply(normalized, content, options);
      },
      react: async (emoji) => {
        const messages = (await import('./messages.js')).default;
        return messages.react(normalized, emoji);
      },
      delete: async (everyone = true) => {
        const messages = (await import('./messages.js')).default;
        return messages.delete(normalized, everyone);
      },
      downloadMedia: async () => {
        if (!hasMedia) return null;
        return downloadBaileysMedia(this.sock, baileysMsg);
      },
      // WhatsApp includes the quoted message's content with the quote, so this
      // works for old messages and after a restart, not only for stored ones.
      getQuotedMessage: async () => {
        if (!quoted) return null;
        const quotedKey = {
          remoteJid,
          id: quotedId || undefined,
          fromMe: this.isOwnJid(quotedParticipant),
          participant: isGroup ? (quotedParticipant || undefined) : undefined,
        };
        const stored = quotedId ? messageStore.get(quotedKey) : null;
        if (stored) return this.normalizeMessage(stored);
        return this.normalizeMessage({ key: quotedKey, message: quoted, messageTimestamp: baileysMsg.messageTimestamp });
      },
      getMentions: async () => Promise.all(mentionedIds.map(id => identity.getContact(id))),
      getChat: async () => this.getChat(remoteJid),
      getContact: async () => {
        const jid = senderJid || remoteJid;
        if (baileysMsg.pushName && jid) identity.rememberContact(identity.normalizeJid(jid), baileysMsg.pushName);
        const contact = await identity.getContact(this.isOwnJid(jid) ? this.sock.user.id : jid);
        return { ...contact, pushname: baileysMsg.pushName || contact.pushname, isMe: Boolean(key.fromMe) || contact.isMe };
      },
      pin: async (duration = 86400) => {
        if (!this.sock) return false;
        await this.sock.sendMessage(identity.normalizeJid(remoteJid), { pin: key, type: 1, time: Number(duration) || 86400 });
        return true;
      },
      unpin: async () => {
        if (!this.sock) return false;
        await this.sock.sendMessage(identity.normalizeJid(remoteJid), { pin: key, type: 2 });
        return true;
      },
    };

    return normalized;
  }

  getMimeType(mediaType) {
    const mimeTypes = {
      image: 'image/jpeg',
      video: 'video/mp4',
      audio: 'audio/ogg',
      ptt: 'audio/ogg',
      sticker: 'image/webp',
      document: 'application/octet-stream',
    };
    return mimeTypes[mediaType] || 'application/octet-stream';
  }
}

const socketManager = new SocketManager();
export default socketManager;
