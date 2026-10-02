/**
 * Groups Service for WhatsApp Adapter
 * Handles group operations: metadata, participants, admin checks, etc.
 */

import socketManager from './socket.js';
import identity from './identity.js';

class GroupsService {
  constructor() {
    this.sock = null;
    this.cache = new Map();
    this.cacheTTL = 300000; // 5 minutes
  }

  init(sock) {
    this.sock = sock || socketManager.getSocket();
  }

  getSock() {
    if (!this.sock) {
      this.sock = socketManager.getSocket();
    }
    return this.sock;
  }

  /**
   * Get group info
   * @param {string} jid - Group JID
   * @returns {Promise<object>} Group info
   */
  async getGroup(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    
    // Check cache
    const cached = this.cache.get(normalizedJid);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }
    
    try {
      const metadata = await sock.groupMetadata(normalizedJid);
      
      const groupInfo = {
        id: { _serialized: normalizedJid },
        name: metadata.subject,
        isGroup: true,
        participants: metadata.participants.map(p => {
          const participantId = identity.normalizeJid(p.id);
          const name = p.pushName || participantId.split('@')[0].split(':')[0];
          identity.rememberContact(participantId, name);
          return {
            id: { _serialized: participantId, user: participantId.split('@')[0].split(':')[0] },
            number: participantId.split('@')[0].split(':')[0],
            isAdmin: Boolean(p.isAdmin),
            isSuperAdmin: Boolean(p.isSuperAdmin),
            pushName: name,
            pushname: name,
            name,
          };
        }),
        owner: metadata.owner,
        creationTimestamp: metadata.creation,
        desc: metadata.desc || '',
        descId: metadata.descId || null,
        descOwner: metadata.descOwner || null,
        inviteCode: metadata.inviteCode || null,
      };
      
      // Cache the result
      this.cache.set(normalizedJid, { data: groupInfo, timestamp: Date.now() });
      
      return groupInfo;
    } catch (error) {
      console.error('Failed to get group metadata:', error);
      throw error;
    }
  }

  /**
   * Check if user is admin in group
   * @param {string} jid - Group JID
   * @param {string} userId - User JID
   * @returns {Promise<boolean>}
   */
  async isAdmin(jid, userId) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    const normalizedUserId = identity.normalizeJid(userId);
    
    try {
      const metadata = await sock.groupMetadata(normalizedJid);
      const participant = metadata.participants.find(p => identity.normalizeJid(p.id) === normalizedUserId);
      return Boolean(participant?.isAdmin || participant?.isSuperAdmin);
    } catch (error) {
      console.error('Failed to check admin status:', error);
      throw error;
    }
  }

  /**
   * Check if bot is admin in group
   * @param {string} jid - Group JID
   * @returns {Promise<boolean>}
   */
  async isBotAdmin(jid) {
    const botJid = identity.getBotJid();
    return this.isAdmin(jid, botJid);
  }

  /**
   * Promote participant to admin
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to promote
   * @returns {Promise<boolean>}
   */
  async promote(jid, userIds) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    const userIdArray = Array.isArray(userIds) ? userIds : [userIds];
    
    try {
      await sock.groupParticipantsUpdate(
        normalizedJid,
        userIdArray.map(id => identity.normalizeJid(id)),
        'promote'
      );
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to promote participants:', error);
      return false;
    }
  }

  /**
   * Demote admin to participant
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to demote
   * @returns {Promise<boolean>}
   */
  async demote(jid, userIds) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    const userIdArray = Array.isArray(userIds) ? userIds : [userIds];
    
    try {
      await sock.groupParticipantsUpdate(
        normalizedJid,
        userIdArray.map(id => identity.normalizeJid(id)),
        'demote'
      );
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to demote participants:', error);
      return false;
    }
  }

  /**
   * Remove participants from group
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to remove
   * @returns {Promise<boolean>}
   */
  async removeParticipants(jid, userIds) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    const userIdArray = Array.isArray(userIds) ? userIds : [userIds];
    
    try {
      await sock.groupParticipantsUpdate(
        normalizedJid,
        userIdArray.map(id => identity.normalizeJid(id)),
        'remove'
      );
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to remove participants:', error);
      return false;
    }
  }

  /**
   * Add participants to group
   * @param {string} jid - Group JID
   * @param {string|string[]} userIds - User JID(s) to add
   * @returns {Promise<boolean>}
   */
  async addParticipants(jid, userIds) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    const userIdArray = Array.isArray(userIds) ? userIds : [userIds];
    
    try {
      await sock.groupParticipantsUpdate(
        normalizedJid,
        userIdArray.map(id => identity.normalizeJid(id)),
        'add'
      );
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to add participants:', error);
      return false;
    }
  }

  /**
   * Get group invite code
   * @param {string} jid - Group JID
   * @returns {Promise<string>} Invite code
   */
  async getInviteCode(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    
    try {
      const code = await sock.groupInviteCode(normalizedJid);
      return code;
    } catch (error) {
      console.error('Failed to get invite code:', error);
      throw error;
    }
  }

  /**
   * Revoke group invite code
   * @param {string} jid - Group JID
   * @returns {Promise<boolean>}
   */
  async revokeInviteCode(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    
    try {
      await sock.groupRevokeInvite(normalizedJid);
      return true;
    } catch (error) {
      console.error('Failed to revoke invite code:', error);
      return false;
    }
  }

  /**
   * Restrict or open group messaging for all participants.
   * @param {string} jid - Group JID
   * @param {boolean} adminsOnly - True restricts messages to admins
   */
  async setMessagesAdminsOnly(jid, adminsOnly) {
    const sock = this.getSock();
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    await sock.groupSettingUpdate(normalizedJid, adminsOnly ? 'announcement' : 'not_announcement');
    this.cache.delete(normalizedJid);
    return true;
  }

  /**
   * Update group subject
   * @param {string} jid - Group JID
   * @param {string} newSubject - New group subject
   * @returns {Promise<boolean>}
   */
  async updateSubject(jid, newSubject) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    
    try {
      await sock.groupUpdateSubject(normalizedJid, newSubject);
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to update group subject:', error);
      return false;
    }
  }

  /**
   * Update group description
   * @param {string} jid - Group JID
   * @param {string} newDesc - New group description
   * @returns {Promise<boolean>}
   */
  async updateDescription(jid, newDesc) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    
    try {
      await sock.groupUpdateDescription(normalizedJid, newDesc);
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to update group description:', error);
      return false;
    }
  }

  /**
   * Get group participant list
   * @param {string} jid - Group JID
   * @returns {Promise<Array>} List of participants
   */
  async getParticipants(jid) {
    const group = await this.getGroup(jid);
    return group.participants || [];
  }

  /**
   * Check if user is in group
   * @param {string} jid - Group JID
   * @param {string} userId - User JID
   * @returns {Promise<boolean>}
   */
  async isParticipant(jid, userId) {
    const participants = await this.getParticipants(jid);
    const normalizedUserId = identity.normalizeJid(userId);
    
    return participants.some(p => p.id._serialized === normalizedUserId);
  }

  /**
   * Leave group
   * @param {string} jid - Group JID
   * @returns {Promise<boolean>}
   */
  async leave(jid) {
    const sock = this.getSock();
    if (!sock) throw new Error('Socket not initialized');
    
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    
    try {
      await sock.groupLeave(normalizedJid);
      
      // Invalidate cache
      this.cache.delete(normalizedJid);
      
      return true;
    } catch (error) {
      console.error('Failed to leave group:', error);
      return false;
    }
  }

  /**
   * Clear group cache
   * @param {string} jid - Group JID
   */
  clearCache(jid) {
    const normalizedJid = jid.endsWith('@g.us') ? jid : `${jid}@g.us`;
    this.cache.delete(normalizedJid);
  }

  /**
   * Clear all cache
   */
  clearAllCache() {
    this.cache.clear();
  }
}

const groups = new GroupsService();
export default groups;
