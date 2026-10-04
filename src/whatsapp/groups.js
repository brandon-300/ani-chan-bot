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
    
    // Setup cache cleanup
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
      
      const participants = (group.participants || []).map(p => {
        const participantId = identity.normalizeJid(p.id);
        const name = p.pushName || participantId.split('@')[0].split(':')[0];
        identity.rememberContact(participantId, name);
        
        return {
          id: { _serialized: participantId, user: participantId.split('@')[0].split(':')[0] },
          number: participantId.split('@')[0].split(':')[0],
          name,
          pushname: name,
          pushName: name,
          isAdmin: Boolean(p.isAdmin),
          isSuperAdmin: Boolean(p.isSuperAdmin),
        };
      });
      
      const result = {
        id: { _serialized: normalized },
        name: group.subject || normalized,
        isGroup: true,
        participants,
        adminIds: participants.filter(p => p.isAdmin).map(p => p.id._serialized),
        ownerId: group.owner?._serialized || '',
        desc: group.desc || '',
        descId: group.descId || '',
        descOwner: group.descOwner?._serialized || '',
        creation: group.creation ? new Date(group.creation * 1000) : null,
      };
      
      // Cache the result
      this.groupCache.set(normalized, { data: result, timestamp: Date.now() });
      
      return result;
    } catch (error) {
      logger.error(`Failed to fetch group metadata for ${normalized}:`, error);
      throw error;
    }
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
