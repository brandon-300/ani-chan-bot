/**
 * Groups Service for WhatsApp Adapter
 * Handles group operations and caching
 */

import socketManager from './socket.js';
import identity from './identity.js';
import pino from 'pino';
import { WHATSAPP_LOG_LEVEL } from '../utils/config.js';

const logger = pino({ level: WHATSAPP_LOG_LEVEL });

/**
 * Groups Service
 * Manages group metadata and participant caching
 */
class GroupsService {
  constructor() {
    this.sock = null;
    this.groupCache = new Map();
    this.cacheTTL = 300; // 5 minutes
    this.cacheCleanupInterval = null;
  }

  init(sock) {
    this.sock = sock || socketManager.getSocket();
    
    // Setup cache cleanup (init runs again after every reconnect; keep ONE timer)
    if (this.cacheCleanupInterval) clearInterval(this.cacheCleanupInterval);
    this.cacheCleanupInterval = setInterval(() => {
      this.cleanupCache();
    }, 60000);
    this.cacheCleanupInterval.unref?.();
  }

  getSock() {
    if (!this.sock) this.sock = socketManager.getSocket();
    return this.sock;
  }

  /**
   * Cleanup expired cache entries
   */
  cleanupCache() {
    const now = Date.now();
    for (const [key, entry] of this.groupCache) {
      if (now - entry.timestamp > this.cacheTTL * 1000) {
        this.groupCache.delete(key);
      }
    }
  }

  /**
   * Invalidate cache for a specific group
   * @param {string} jid - Group JID
   */
  invalidateCache(jid) {
    const normalized = identity.normalizeJid(jid);
    this.groupCache.delete(normalized);
    logger.debug(`Group cache invalidated for ${normalized}`);
  }

  /**
   * Get group info from cache or fetch fresh
   * @param {string} jid - Group JID
   * @returns {Promise<object>} Group info
   */
  async getGroup(jid) {
    if (!jid) throw new TypeError('A group JID is required.');
    
    const normalized = identity.normalizeJid(jid);
    
    // Check cache first
    const cached = this.groupCache.get(normalized);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL * 1000) {
      return cached.data;
    }
    
    // Fetch fresh from WhatsApp
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    try {
      const group = await sock.groupMetadata(normalized);
      
      if (!group) throw new Error('Group not found');
      
      return this.buildGroup(normalized, group);
    } catch (error) {
      logger.error(`Failed to fetch group metadata for ${normalized}:`, error);
      throw error;
    }
  }

  /**
   * Turn raw Baileys group metadata into the internal group record and cache it.
   * Internal ids stay in Baileys form; getChat() is what exposes the
   * whatsapp-web.js spelling to commands.
   */
  buildGroup(normalized, group) {
    const participants = (group.participants || []).map(p => {
      const participantId = identity.normalizeJid(p.id);
      const name = p.pushName || participantId.split('@')[0].split(':')[0];
      identity.rememberContact(participantId, name);
      // Baileys 7 reports the phone number of LID-addressed members separately.
      if (p.phoneNumber && participantId.endsWith('@lid')) identity.addLidPnMapping(participantId, p.phoneNumber);
      // Phone-number-addressed groups can report the member's LID instead.
      if (p.lid && !participantId.endsWith('@lid')) identity.addLidPnMapping(p.lid, participantId);

      return {
        id: { _serialized: participantId, user: participantId.split('@')[0].split(':')[0] },
        number: participantId.split('@')[0].split(':')[0],
        name,
        pushname: name,
        pushName: name,
        isAdmin: Boolean(p.isAdmin || p.admin === 'admin' || p.admin === 'superadmin'),
        isSuperAdmin: Boolean(p.isSuperAdmin || p.admin === 'superadmin'),
      };
    });

    const ownerJid = typeof group.owner === 'string' ? group.owner : (group.owner?._serialized || '');
    const result = {
      id: { _serialized: normalized },
      name: group.subject || normalized,
      isGroup: true,
      participants,
      adminIds: participants.filter(p => p.isAdmin).map(p => p.id._serialized),
      ownerId: ownerJid ? identity.normalizeJid(ownerJid) : '',
      desc: group.desc || '',
      descId: group.descId || '',
      descOwner: group.descOwner?._serialized || group.descOwner || '',
      creation: group.creation ? new Date(group.creation * 1000) : null,
    };

    this.groupCache.set(normalized, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * The chat object commands work with (what msg.getChat() / client.getChatById()
   * return). Same shape as whatsapp-web.js: ids in the legacy spelling, plus the
   * methods commands call on a chat (sendMessage, getInviteCode, ...).
   * The returned object is a copy; the internal cache is never handed out.
   */
  async getChat(jid) {
    if (!jid) throw new TypeError('A chat JID is required.');
    const normalized = identity.normalizeJid(jid);
    if (!normalized.endsWith('@g.us')) return this.buildDirectChat(normalized);
    return this.exposeGroup(await this.getGroup(normalized));
  }

  /** Same as getChat() for metadata the caller already fetched (used by getChats()). */
  getChatFromMetadata(jid, metadata) {
    const normalized = identity.normalizeJid(jid);
    return this.exposeGroup(this.buildGroup(normalized, metadata));
  }

  // The bot is listed in LID-addressed groups under its LID; commands compare
  // participants with client.info.wid, so show the bot under that id.
  legacyMemberId(jid) {
    const botPn = this.getSock()?.user?.id;
    if (botPn && identity.isBotJid(jid)) return identity.toLegacyId(botPn);
    return identity.toStoredId(jid);
  }

  exposeGroup(group) {
    const groupJid = group.id._serialized;
    const exposeMember = p => {
      const id = this.legacyMemberId(p.id._serialized);
      return { ...p, id: { _serialized: id, user: id.split('@')[0].split(':')[0] } };
    };
    const send = async (content, options = {}) => {
      const messages = (await import('./messages.js')).default;
      return messages.sendMessage(groupJid, content, options);
    };
    return {
      ...group,
      id: { _serialized: groupJid, user: groupJid.split('@')[0], server: 'g.us' },
      participants: group.participants.map(exposeMember),
      adminIds: group.adminIds.map(id => this.legacyMemberId(id)),
      ownerId: group.ownerId ? this.legacyMemberId(group.ownerId) : '',
      owner: group.ownerId ? { _serialized: this.legacyMemberId(group.ownerId) } : undefined,
      sendMessage: send,
      getInviteCode: () => this.getInviteCode(groupJid),
      setMessagesAdminsOnly: onlyAdmins => this.setMessagesAdminsOnly(groupJid, onlyAdmins),
      addParticipants: ids => this.addParticipants(groupJid, ids),
      removeParticipants: ids => this.removeParticipants(groupJid, ids),
      promoteParticipants: ids => this.promote(groupJid, ids),
      demoteParticipants: ids => this.demote(groupJid, ids),
      setSubject: subject => this.updateSubject(groupJid, subject),
      setDescription: desc => this.updateDescription(groupJid, desc),
      leave: () => this.leave(groupJid),
    };
  }

  buildDirectChat(normalized) {
    const send = async (content, options = {}) => {
      const messages = (await import('./messages.js')).default;
      return messages.sendMessage(normalized, content, options);
    };
    const legacy = identity.toStoredId(normalized);
    return {
      id: { _serialized: legacy, user: legacy.split('@')[0] },
      name: identity.getDisplayName(normalized),
      isGroup: false,
      participants: [],
      sendMessage: send,
    };
  }

  /**
   * Get participants of a group
   * @param {string} jid - Group JID
   * @returns {Promise<Array>} List of participants
   */
  async getParticipants(jid) {
    const group = await this.getGroup(jid);
    return group.participants || [];
  }

  /**
   * Check if user is admin in a group
   * @param {string} groupJid - Group JID
   * @param {string} userId - User JID
   * @returns {Promise<boolean>}
   */
  async isAdmin(groupJid, userId) {
    if (!groupJid || !userId) return false;
    
    const normalizedGroup = identity.normalizeJid(groupJid);
    const normalizedUser = identity.normalizeJid(userId);
    
    try {
      const group = await this.getGroup(normalizedGroup);
      return group.adminIds?.includes(normalizedUser) || false;
    } catch (error) {
      logger.error(`Failed to check admin status for ${normalizedUser} in ${normalizedGroup}:`, error);
      return false;
    }
  }

  /**
   * Check if bot is admin in a group
   * @param {string} groupJid - Group JID
   * @returns {Promise<boolean>}
   */
  async isBotAdmin(groupJid) {
    if (!groupJid) return false;
    
    const botJid = identity.getBotJid();
    if (!botJid) return false;
    
    return this.isAdmin(groupJid, botJid);
  }

  /**
   * Check if user is participant in a group
   * @param {string} groupJid - Group JID
   * @param {string} userId - User JID
   * @returns {Promise<boolean>}
   */
  async isParticipant(groupJid, userId) {
    if (!groupJid || !userId) return false;
    
    const normalizedGroup = identity.normalizeJid(groupJid);
    const normalizedUser = identity.normalizeJid(userId);
    
    try {
      const group = await this.getGroup(normalizedGroup);
      return group.participants?.some(p => p.id._serialized === normalizedUser) || false;
    } catch (error) {
      logger.error(`Failed to check participant status for ${normalizedUser} in ${normalizedGroup}:`, error);
      return false;
    }
  }

  /**
   * Promote participant to admin
   * @param {string} groupJid - Group JID
   * @param {string|string[]} userIds - User JID(s) to promote
   * @returns {Promise<boolean>}
   */
  async promote(groupJid, userIds) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalizedGroup = identity.normalizeJid(groupJid);
    const normalizedUserIds = Array.isArray(userIds) ? userIds.map(identity.normalizeJid) : [identity.normalizeJid(userIds)];
    
    try {
      await sock.groupParticipantsUpdate(normalizedGroup, normalizedUserIds, 'promote');
      this.invalidateCache(normalizedGroup);
      return true;
    } catch (error) {
      logger.error(`Failed to promote participants in ${normalizedGroup}:`, error);
      return false;
    }
  }

  /**
   * Demote admin to participant
   * @param {string} groupJid - Group JID
   * @param {string|string[]} userIds - User JID(s) to demote
   * @returns {Promise<boolean>}
   */
  async demote(groupJid, userIds) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalizedGroup = identity.normalizeJid(groupJid);
    const normalizedUserIds = Array.isArray(userIds) ? userIds.map(identity.normalizeJid) : [identity.normalizeJid(userIds)];
    
    try {
      await sock.groupParticipantsUpdate(normalizedGroup, normalizedUserIds, 'demote');
      this.invalidateCache(normalizedGroup);
      return true;
    } catch (error) {
      logger.error(`Failed to demote participants in ${normalizedGroup}:`, error);
      return false;
    }
  }

  /**
   * Remove participants from group
   * @param {string} groupJid - Group JID
   * @param {string|string[]} userIds - User JID(s) to remove
   * @returns {Promise<boolean>}
   */
  async removeParticipants(groupJid, userIds) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalizedGroup = identity.normalizeJid(groupJid);
    const normalizedUserIds = Array.isArray(userIds) ? userIds.map(identity.normalizeJid) : [identity.normalizeJid(userIds)];
    
    try {
      await sock.groupParticipantsUpdate(normalizedGroup, normalizedUserIds, 'remove');
      this.invalidateCache(normalizedGroup);
      return true;
    } catch (error) {
      logger.error(`Failed to remove participants from ${normalizedGroup}:`, error);
      return false;
    }
  }

  /**
   * Add participants to group
   * @param {string} groupJid - Group JID
   * @param {string|string[]} userIds - User JID(s) to add
   * @returns {Promise<boolean>}
   */
  async addParticipants(groupJid, userIds) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalizedGroup = identity.normalizeJid(groupJid);
    const normalizedUserIds = Array.isArray(userIds) ? userIds.map(identity.normalizeJid) : [identity.normalizeJid(userIds)];
    
    try {
      await sock.groupParticipantsUpdate(normalizedGroup, normalizedUserIds, 'add');
      this.invalidateCache(normalizedGroup);
      return true;
    } catch (error) {
      logger.error(`Failed to add participants to ${normalizedGroup}:`, error);
      return false;
    }
  }

  /**
   * Leave group
   * @param {string} groupJid - Group JID
   * @returns {Promise<boolean>}
   */
  async leave(groupJid) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalized = identity.normalizeJid(groupJid);
    
    try {
      await sock.groupLeave(normalized);
      this.invalidateCache(normalized);
      return true;
    } catch (error) {
      logger.error(`Failed to leave group ${normalized}:`, error);
      return false;
    }
  }

  /**
   * Get group invite code
   * @param {string} groupJid - Group JID
   * @returns {Promise<string>}
   */
  async getInviteCode(groupJid) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalized = identity.normalizeJid(groupJid);
    
    try {
      const code = await sock.groupInviteCode(normalized);
      return code;
    } catch (error) {
      logger.error(`Failed to get invite code for ${normalized}:`, error);
      throw error;
    }
  }

  /**
   * Revoke group invite code
   * @param {string} groupJid - Group JID
   * @returns {Promise<boolean>}
   */
  async revokeInviteCode(groupJid) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalized = identity.normalizeJid(groupJid);
    
    try {
      await sock.groupRevokeInvite(normalized);
      return true;
    } catch (error) {
      logger.error(`Failed to revoke invite code for ${normalized}:`, error);
      return false;
    }
  }

  /**
   * Update group subject
   * @param {string} groupJid - Group JID
   * @param {string} newSubject - New subject
   * @returns {Promise<boolean>}
   */
  async updateSubject(groupJid, newSubject) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    if (!newSubject) throw new TypeError('A subject is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalized = identity.normalizeJid(groupJid);
    
    try {
      await sock.groupUpdateSubject(normalized, newSubject);
      this.invalidateCache(normalized);
      return true;
    } catch (error) {
      logger.error(`Failed to update subject for ${normalized}:`, error);
      return false;
    }
  }

  /**
   * Update group description
   * @param {string} groupJid - Group JID
   * @param {string} newDesc - New description
   * @returns {Promise<boolean>}
   */
  async updateDescription(groupJid, newDesc) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalized = identity.normalizeJid(groupJid);
    
    try {
      await sock.groupUpdateDescription(normalized, newDesc);
      this.invalidateCache(normalized);
      return true;
    } catch (error) {
      logger.error(`Failed to update description for ${normalized}:`, error);
      return false;
    }
  }

  /**
   * Set messages to admins only
   * @param {string} groupJid - Group JID
   * @param {boolean} onlyAdmins - True to restrict to admins
   * @returns {Promise<boolean>}
   */
  async setMessagesAdminsOnly(groupJid, onlyAdmins) {
    if (!groupJid) throw new TypeError('A group JID is required.');
    
    const sock = this.getSock();
    if (!sock) throw new Error('WhatsApp socket is not initialized.');
    
    const normalized = identity.normalizeJid(groupJid);
    
    try {
      await sock.groupSettingUpdate(normalized, onlyAdmins ? 'announcement' : 'not_announcement');
      return true;
    } catch (error) {
      logger.error(`Failed to set messages admins only for ${normalized}:`, error);
      return false;
    }
  }

  /**
   * Get all participating groups
   * @returns {Promise<Array>} List of group JIDs
   */
  async getAllParticipatingGroups() {
    const sock = this.getSock();
    if (!sock?.groupFetchAllParticipating) throw new Error('WhatsApp socket is not connected.');
    
    try {
      const groupsById = await sock.groupFetchAllParticipating();
      return Object.keys(groupsById || {});
    } catch (error) {
      logger.error('Failed to fetch all participating groups:', error);
      throw error;
    }
  }
}

const groups = new GroupsService();
export default groups;
