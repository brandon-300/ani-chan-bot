/**
 * Identity Service for WhatsApp Adapter
 * Handles LID (Lightweight ID) and PN (Phone Number) identity resolution
 * 
 * Baileys v7 introduced LIDs (Lightweight IDs) as the preferred identity system.
 * This service provides canonical identity resolution that works with both LID and PN formats.
 */

import socketManager from './socket.js';

/**
 * Extract the numeric part from a JID
 * @param {string} jid - JID to extract from
 * @returns {string} Numeric part
 */
function numberPart(jid) {
  if (!jid) return '';
  const clean = String(jid).split('@')[0].split(':')[0];
  return clean.replace(/\D/g, '');
}

/**
 * Check if a JID is a LID (Lightweight ID)
 * @param {string} jid - JID to check
 * @returns {boolean} True if it's a LID
 */
function isLid(jid) {
  if (!jid) return false;
  return String(jid).endsWith('@lid');
}

/**
 * Check if a JID is a phone number JID
 * @param {string} jid - JID to check
 * @returns {boolean} True if it's a phone number JID
 */
function isPhoneNumberJid(jid) {
  if (!jid) return false;
  return String(jid).endsWith('@s.whatsapp.net');
}

/**
 * Check if a JID is a group JID
 * @param {string} jid - JID to check
 * @returns {boolean} True if it's a group JID
 */
function isGroupJid(jid) {
  if (!jid) return false;
  return String(jid).endsWith('@g.us');
}

/**
 * Identity Service
 * Manages identity resolution between LID and PN formats
 */
class IdentityService {
  constructor() {
    this.sock = null;
    
    // Owner IDs - can be LID or PN format
    this.ownerIds = [
      process.env.OWNER_NUMBER,
      process.env.BOT_OWNER,
      ...(process.env.OWNER_IDS || '').split(',')
    ]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    
    // Moderator IDs - can be LID or PN format
    this.modIds = (process.env.MOD_NUMBERS || '').split(',')
      .map(value => value.trim())
      .filter(Boolean);
    
    // Contact cache: maps JIDs to names
    this.contacts = new Map();
    
    // LID to PN mapping cache
    this.lidToPnMap = new Map();
    
    // PN to LID mapping cache
    this.pnToLidMap = new Map();
    
    // Track if we've synced from Baileys signalRepository
    this.syncedFromBaileys = false;
  }

  init(sock) {
    this.sock = sock || socketManager.getSocket();
  }

  getSock() {
    if (!this.sock) this.sock = socketManager.getSocket();
    return this.sock;
  }

  /**
   * Get Baileys signalRepository.lidMapping store
   * This is the authoritative source for LID<->PN mappings
   * @returns {object|null} Baileys LID mapping store or null
   */
  getBaileysLidMapping() {
    const sock = this.getSock();
    if (sock?.signalRepository?.lidMapping) {
      return sock.signalRepository.lidMapping;
    }
    return null;
  }

  /**
   * Sync mappings from Baileys signalRepository.lidMapping
   * Populates our cache from the authoritative source
   */
  async syncFromBaileys() {
    if (this.syncedFromBaileys) return;
    
    const lidMapping = this.getBaileysLidMapping();
    if (!lidMapping) return;
    
    try {
      // Get all mappings from Baileys store
      // Baileys lidMapping has methods like getLIDForPN, getPNForLID
      // We need to iterate through known mappings
      // For now, we'll rely on the event-based updates from lid-mapping.update
      // and use this as a fallback lookup
      this.syncedFromBaileys = true;
    } catch (error) {
      // Silently fail - we'll rely on event-based updates
    }
  }

  /**
   * Get PN from LID - checks Baileys store first, then cache
   * @param {string} lidJid - LID
   * @returns {string|null} PN JID or null
   */
  getPnFromLid(lidJid) {
    if (!lidJid) return null;
    const normalized = this.normalizeJid(lidJid);
    
    // First check our cache
    if (this.lidToPnMap.has(normalized)) {
      return this.lidToPnMap.get(normalized);
    }
    
    // Then check Baileys signalRepository
    const lidMapping = this.getBaileysLidMapping();
    if (lidMapping) {
      try {
        // Baileys uses getPNForLID which may be async
        // We'll try both sync and async patterns
        const pnFromBaileys = lidMapping.getPNForLID?.(normalized);
        if (pnFromBaileys) {
          // Cache the result
          this.addLidPnMapping(normalized, pnFromBaileys);
          return pnFromBaileys;
        }
      } catch (error) {
        // Fall through to cache-only
      }
    }
    
    return null;
  }

  /**
   * Get LID from PN - checks Baileys store first, then cache
   * @param {string} pnJid - Phone number JID
   * @returns {string|null} LID or null
   */
  getLidFromPn(pnJid) {
    if (!pnJid) return null;
    const normalized = this.normalizeJid(pnJid);
    
    // First check our cache
    if (this.pnToLidMap.has(normalized)) {
      return this.pnToLidMap.get(normalized);
    }
    
    // Then check Baileys signalRepository
    const lidMapping = this.getBaileysLidMapping();
    if (lidMapping) {
      try {
        const lidFromBaileys = lidMapping.getLIDForPN?.(normalized);
        if (lidFromBaileys) {
          // Cache the result
          this.addLidPnMapping(lidFromBaileys, normalized);
          return lidFromBaileys;
        }
      } catch (error) {
        // Fall through to cache-only
      }
    }
    
    return null;
  }

  /**
   * Normalize a JID by removing device suffixes
   * Preserves LID and group JIDs exactly
   * @param {string} jid - JID to normalize
   * @returns {string} Normalized JID
   */
  normalizeJid(jid) {
    if (!jid) return jid;
    const clean = String(jid).trim();
    if (!clean) return clean;
    if (!clean.includes('@')) {
      // Bare number, assume phone number
      return /^\d+$/.test(clean) ? `${clean}@s.whatsapp.net` : clean;
    }
    // Baileys may include a device suffix in a participant JID. Strip only
    // that device marker; preserve LID and group JIDs exactly otherwise.
    const withoutDevice = clean.replace(/:\d+(?=@)/, '');
    // "@c.us" is the whatsapp-web.js spelling of a phone-number id. The same
    // .env and MongoDB are shared with that codebase, so OWNER_NUMBER, MOD_NUMBERS
    // and stored ids may still use it. Baileys addresses the same account as
    // "@s.whatsapp.net", so map one to the other here: owner checks and sends
    // then work with either spelling.
    return withoutDevice.replace(/@c\.us$/, '@s.whatsapp.net');
  }

  /**
   * The spelling of an id that the rest of the bot sees and stores in MongoDB.
   *
   * The whatsapp-web.js version of this bot keyed every user, group member and
   * chat by "<number>@c.us" (or "<id>@lid" for people WhatsApp addresses by
   * LID). Both libraries receive the same stanzas from WhatsApp, so only the
   * spelling of phone-number ids differs. Everything the commands READ from the
   * adapter (msg.from / msg.author / contacts / participants / mentions) goes
   * through this, so a user keeps the SAME id (and therefore the same coins,
   * cards, guild and AI history) whichever library is running. Ids going back
   * OUT to WhatsApp are mapped the other way by normalizeJid().
   */
  toLegacyId(jid) {
    const normalized = this.normalizeJid(jid);
    if (!normalized || typeof normalized !== 'string') return normalized;
    return normalized.replace(/@s\.whatsapp\.net$/, '@c.us');
  }

  /**
   * The id a person is STORED under in MongoDB (and so the id commands see).
   *
   * WhatsApp can address one person two ways: by phone number ("234...@s.whatsapp.net")
   * or by LID ("177...@lid"). Baileys 7 hands us the LID in many chats, but the
   * whatsapp-web.js version resolved people to their phone-number id ("234...@c.us")
   * before saving them, so that is what the database holds. To find the same
   * account, a LID is translated to the phone-number id whenever WhatsApp has told
   * us the mapping (see learnFromKey / learnIds). Only when no mapping is known
   * does the LID itself come back, and a warning is logged once so it is visible.
   */
  toStoredId(jid) {
    const normalized = this.normalizeJid(jid);
    if (!normalized || typeof normalized !== 'string') return normalized;
    if (isLid(normalized)) {
      const pn = this.lidToPnMap.get(normalized);
      if (pn) return this.toLegacyId(pn);
      this.warnUnresolvedLid(normalized);
      return normalized;
    }
    return this.toLegacyId(normalized);
  }

  warnUnresolvedLid(lid) {
    if (!this.unresolvedLidWarned) this.unresolvedLidWarned = new Set();
    if (this.unresolvedLidWarned.has(lid) || this.unresolvedLidWarned.size > 500) return;
    this.unresolvedLidWarned.add(lid);
    console.warn(`[identity] No phone number known yet for ${lid}; using the LID as the user id. ` +
      'If this person is already registered under their phone number, they would be treated as new.');
  }

  /** True for the bot's own phone-number id and its LID. */
  isBotJid(jid) {
    const user = this.getSock()?.user;
    if (!user || !jid) return false;
    const target = this.normalizeJid(jid);
    return [user.id, user.lid].filter(Boolean).some(own => this.normalizeJid(own) === target);
  }

  /**
   * Learn LID <-> phone-number mappings straight from a message key. Baileys 7 puts
   * the "other" spelling of the sender in participantAlt (groups) / remoteJidAlt (DMs).
   * Synchronous, so normalizeMessage() can use it.
   */
  learnFromKey(key) {
    if (!key) return;
    const pairs = [[key.participant, key.participantAlt], [key.remoteJid, key.remoteJidAlt]];
    for (const [a, b] of pairs) {
      if (!a || !b) continue;
      const first = this.normalizeJid(a);
      const second = this.normalizeJid(b);
      if (isLid(first) && !isLid(second) && second.endsWith('@s.whatsapp.net')) this.addLidPnMapping(first, second);
      else if (isLid(second) && !isLid(first) && first.endsWith('@s.whatsapp.net')) this.addLidPnMapping(second, first);
    }
  }

  /**
   * Phone-number id for a LID, asking Baileys' own persisted LID store when the
   * in-memory cache does not know it yet. Never throws; resolves to null if unknown.
   */
  async lookupPnForLid(lidJid) {
    const lid = this.normalizeJid(lidJid);
    if (!lid || !isLid(lid)) return null;
    const cached = this.lidToPnMap.get(lid);
    if (cached) return cached;
    const store = this.getBaileysLidMapping();
    if (!store?.getPNForLID) return null;
    try {
      const pn = await Promise.race([
        Promise.resolve(store.getPNForLID(lid)),
        new Promise(resolve => setTimeout(() => resolve(null), 1500)),
      ]);
      if (pn && typeof pn === 'string') {
        this.addLidPnMapping(lid, pn);
        return this.lidToPnMap.get(lid) || null;
      }
    } catch (error) {
      // an unresolvable LID falls back to the LID id (and a warning), see toStoredId()
    }
    return null;
  }

  /**
   * Make sure every id a message mentions is resolvable BEFORE the message is
   * normalized (normalizeMessage is synchronous): sender, chat, mentioned people
   * and the quoted author.
   */
  async learnIds(baileysMsg) {
    if (!baileysMsg?.key) return;
    this.learnFromKey(baileysMsg.key);
    const candidates = new Set();
    const key = baileysMsg.key;
    if (key.participant) candidates.add(key.participant);
    if (key.remoteJid && !key.remoteJid.endsWith('@g.us')) candidates.add(key.remoteJid);
    const content = baileysMsg.message || {};
    for (const value of Object.values(content)) {
      const ctx = value && typeof value === 'object' ? value.contextInfo : null;
      if (!ctx) continue;
      for (const jid of ctx.mentionedJid || []) candidates.add(jid);
      if (ctx.participant) candidates.add(ctx.participant);
      break;
    }
    for (const jid of candidates) {
      const normalized = this.normalizeJid(jid);
      if (isLid(normalized) && !this.lidToPnMap.has(normalized)) await this.lookupPnForLid(normalized);
    }
  }

  /**
   * Mentions may be given as id strings or as contact objects ({ id: { _serialized } }),
   * in either spelling. Baileys needs plain "@s.whatsapp.net" / "@lid" strings.
   */
  toMentionJids(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      const raw = typeof item === 'string' ? item : (item?.id?._serialized || item?._serialized || item?.id || '');
      const jid = this.normalizeJid(raw);
      if (jid && typeof jid === 'string' && jid.includes('@') && !out.includes(jid)) out.push(jid);
    }
    return out;
  }

  /**
   * Get the canonical identity for a JID
   * Returns the preferred identifier (LID if available, otherwise PN)
   * @param {string} jid - JID to resolve
   * @returns {string} Canonical JID
   */
  getCanonicalId(jid) {
    if (!jid) return jid;
    const normalized = this.normalizeJid(jid);
    
    // If it's already a LID, that's the canonical form
    if (isLid(normalized)) {
      return normalized;
    }
    
    // If we have a LID mapping for this PN, return the LID
    // This checks both our cache and Baileys signalRepository
    const lid = this.getLidFromPn(normalized);
    if (lid) {
      return lid;
    }
    
    // Otherwise, return the normalized JID
    return normalized;
  }

  /**
   * Get phone number from any JID format
   * @param {string} jid - JID to extract from
   * @returns {string} Phone number
   */
  getPhoneNumber(jid) {
    if (!jid) return '';
    const normalized = this.normalizeJid(jid);
    
    if (isLid(normalized)) {
      // Try to get PN from LID mapping (checks Baileys store + cache)
      const pnJid = this.getPnFromLid(normalized);
      if (pnJid) {
        return numberPart(pnJid);
      }
      // LID format: number@lid
      return numberPart(normalized);
    }
    
    return numberPart(normalized);
  }

  /**
   * Get LID from PN if mapping exists
   * @param {string} pnJid - Phone number JID
   * @returns {string|null} LID or null if not mapped
   */
  getLidFromPn(pnJid) {
    if (!pnJid) return null;
    const normalized = this.normalizeJid(pnJid);
    return this.pnToLidMap.get(normalized) || null;
  }

  /**
   * Get PN from LID if mapping exists
   * @param {string} lidJid - LID
   * @returns {string|null} PN JID or null if not mapped
   */
  getPnFromLid(lidJid) {
    if (!lidJid) return null;
    const normalized = this.normalizeJid(lidJid);
    return this.lidToPnMap.get(normalized) || null;
  }

  /**
   * Add LID to PN mapping
   * @param {string} lidJid - LID
   * @param {string} pnJid - Phone number JID
   */
  addLidPnMapping(lidJid, pnJid) {
    if (!lidJid || !pnJid) return;
    const normalizedLid = this.normalizeJid(lidJid);
    const normalizedPn = this.normalizeJid(pnJid);
    
    this.lidToPnMap.set(normalizedLid, normalizedPn);
    this.pnToLidMap.set(normalizedPn, normalizedLid);
  }

  /**
   * Remove LID to PN mapping
   * @param {string} jid - Either LID or PN JID
   */
  removeLidPnMapping(jid) {
    if (!jid) return;
    const normalized = this.normalizeJid(jid);
    
    // If it's a LID
    if (isLid(normalized)) {
      const pnJid = this.lidToPnMap.get(normalized);
      if (pnJid) {
        this.lidToPnMap.delete(normalized);
        this.pnToLidMap.delete(pnJid);
      }
      return;
    }
    
    // If it's a PN
    const lidJid = this.pnToLidMap.get(normalized);
    if (lidJid) {
      this.pnToLidMap.delete(normalized);
      this.lidToPnMap.delete(lidJid);
    }
  }

  /**
   * Get sender info from message
   * @param {object} msg - Message object
   * @returns {object|null} Sender info with id, name, pushName, number, isLid
   */
  getSender(msg) {
    if (!msg) return null;
    
    let jid = msg.author || msg.senderId || null;
    
    // Extract from Baileys message
    if (!jid && msg._baileys?.key) {
      const raw = msg._baileys;
      jid = raw.key.remoteJid?.endsWith('@g.us')
        ? (raw.participant || raw.key.participant || raw.key.remoteJid)
        : raw.key.remoteJid;
    }
    if (!jid && msg.key) {
      jid = msg.key.remoteJid?.endsWith('@g.us')
        ? (msg.participant || msg.key.participant || msg.key.remoteJid)
        : msg.key.remoteJid;
    }
    if (!jid) return null;
    
    jid = this.normalizeJid(jid);
    const pushName = msg.pushName || msg.notifyName || this.contacts.get(jid) || this.getDisplayName(jid);
    
    return {
      id: jid,
      name: pushName,
      pushName,
      number: this.getPhoneNumber(jid),
      isLid: isLid(jid),
      canonicalId: this.getCanonicalId(jid),
    };
  }

  /**
   * Get display name for a JID
   * @param {string} jid - JID to get name for
   * @returns {string} Display name
   */
  getDisplayName(jid) {
    if (!jid) return 'Unknown';
    
    const normalized = this.normalizeJid(jid);
    const cached = this.contacts.get(normalized);
    if (cached) return cached;
    
    return this.getPhoneNumber(normalized) || 'Unknown';
  }

  /**
   * Remember a contact name
   * @param {string} jid - JID
   * @param {string} name - Name to remember
   */
  rememberContact(jid, name) {
    const normalized = this.normalizeJid(jid);
    if (normalized && name) {
      this.contacts.set(normalized, String(name));
    }
  }

  /**
   * Resolve sender name from message
   * @param {object} msg - Message object
   * @returns {Promise<string>} Sender name
   */
  async resolveSenderName(msg) {
    const sender = this.getSender(msg);
    return sender?.pushName || sender?.name || this.getDisplayName(msg?.from) || 'Unknown';
  }

  /**
   * Check if user is owner
   * Works with both LID and PN formats
   * @param {string} userId - User JID to check
   * @returns {boolean} True if user is owner
   */
  isOwner(userId) {
    if (!userId) return false;
    
    const target = this.getCanonicalId(this.normalizeJid(userId));
    
    return this.ownerIds.some(id => {
      const ownerId = this.getCanonicalId(this.normalizeJid(id));
      return target === ownerId;
    });
  }

  /**
   * Check if user is moderator
   * Works with both LID and PN formats
   * @param {string} userId - User JID to check
   * @returns {boolean} True if user is moderator
   */
  isMod(userId) {
    if (this.isOwner(userId)) return true;
    if (!userId) return false;
    
    const target = this.getCanonicalId(this.normalizeJid(userId));
    
    return this.modIds.some(id => {
      const modId = this.getCanonicalId(this.normalizeJid(id));
      return target === modId;
    });
  }

  /**
   * Check if user is admin (alias for isMod)
   * @param {string} userId - User JID to check
   * @returns {boolean} True if user is admin
   */
  isAdmin(userId) {
    return this.isMod(userId);
  }

  /**
   * Get bot's own JID
   * @returns {string} Bot's JID
   */
  getBotJid() {
    const sock = this.getSock();
    return this.normalizeJid(sock?.user?.id || socketManager.getWid() || '');
  }

  /**
   * Get bot's phone number
   * @returns {string} Bot's phone number
   */
  getBotNumber() {
    const jid = this.getBotJid();
    return jid ? numberPart(jid) : null;
  }

  /**
   * Generate mention string for user
   * @param {string} jid - User JID
   * @returns {string} Mention string
   */
  mention(jid) {
    if (!jid) return '';
    const normalized = this.normalizeJid(jid);
    const number = this.getPhoneNumber(normalized);
    return number ? `@${number}` : '';
  }

  /**
   * Get user info
   * @param {string} jid - User JID
   * @returns {Promise<object>} User info
   */
  async getUserInfo(jid) {
    if (!jid) throw new TypeError('A user JID is required.');
    const normalized = this.normalizeJid(jid);
    const cachedName = this.contacts.get(normalized);
    const name = cachedName || this.getDisplayName(normalized) || 'Unknown';
    return {
      id: normalized,
      name,
      pushName: name,
      isBot: normalized === this.getBotJid(),
      isLid: isLid(normalized),
      canonicalId: this.getCanonicalId(normalized),
      phoneNumber: this.getPhoneNumber(normalized),
    };
  }

  /**
   * Check if message is from bot
   * @param {object} msg - Message object
   * @returns {boolean} True if message is from bot
   */
  isFromBot(msg) {
    if (!msg) return false;
    if (msg.fromMe) return true;
    const sender = this.getSender(msg);
    return Boolean(sender && sender.id === this.getBotJid());
  }

  /**
   * Get contact info
   * @param {string} jid - User JID
   * @returns {Promise<object>} Contact info
   */
  async getContact(jid) {
    if (!jid) throw new TypeError('A contact JID is required.');
    let normalized = this.normalizeJid(jid);
    if (isLid(normalized) && !this.lidToPnMap.has(normalized)) await this.lookupPnForLid(normalized);
    const number = this.getPhoneNumber(normalized);
    const name = this.contacts.get(normalized) || this.getDisplayName(normalized) || number || 'Unknown';
    const isMe = this.isBotJid(normalized) || normalized === this.getBotJid();
    
    return {
      id: { _serialized: this.toStoredId(normalized), user: number },
      number,
      name,
      pushname: name,
      pushName: name,
      isMe,
      isLid: isLid(normalized),
      canonicalId: this.getCanonicalId(normalized),
    };
  }

  /**
   * Resolve identity to canonical form
   * @param {string} jid - Any JID format
   * @returns {object} Canonical identity info
   */
  resolveIdentity(jid) {
    if (!jid) return null;
    
    const normalized = this.normalizeJid(jid);
    const canonicalId = this.getCanonicalId(normalized);
    const phoneNumber = this.getPhoneNumber(normalized);
    const isLid = isLid(normalized);
    
    return {
      jid: normalized,
      canonicalId,
      phoneNumber,
      isLid,
      displayName: this.getDisplayName(normalized),
    };
  }
}

const identity = new IdentityService();
export default identity;

export { isLid, isPhoneNumberJid, isGroupJid, numberPart };
