/**
 * Baileys Authentication State Management
 * Uses multi-file auth state for persistence across restarts
 */

import { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.join(__dirname, '../../../auth_info_baileys');

// Create auth state
const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

/**
 * Authentication state manager
 * Handles auth state persistence and connection recovery
 */
class AuthManager {
  constructor() {
    this.state = state;
    this.saveCreds = saveCreds;
    this.authDir = AUTH_DIR;
    this.pairingCode = null;
    this.pairingNumber = null;
  }

  /**
   * Check if already authenticated
   */
  isAuthenticated() {
    return this.state.creds && this.state.creds.registered;
  }

  /**
   * Check if pairing code is available
   */
  hasPairingCode() {
    return !!this.pairingCode;
  }

  /**
   * Get current auth state
   */
  getState() {
    return this.state;
  }

  /**
   * Get save creds function
   */
  getSaveCreds() {
    return this.saveCreds;
  }

  /**
   * Request pairing code
   * @param {string} phoneNumber - Phone number in international format
   * @returns {Promise<string>} Pairing code
   */
  async requestPairingCode(phoneNumber) {
    try {
      this.pairingNumber = phoneNumber;
      // Note: In Baileys, pairing code is requested through the socket
      // This will be called from the socket initialization
      return this.pairingCode;
    } catch (error) {
      console.error('Failed to request pairing code:', error);
      throw error;
    }
  }

  /**
   * Set pairing code (called from socket event)
   * @param {string} code - Pairing code
   */
  setPairingCode(code) {
    this.pairingCode = code;
  }

  /**
   * Get pairing code
   */
  getPairingCode() {
    return this.pairingCode;
  }

  /**
   * Get pairing number
   */
  getPairingNumber() {
    return this.pairingNumber;
  }

  /**
   * Clear pairing code
   */
  clearPairingCode() {
    this.pairingCode = null;
    this.pairingNumber = null;
  }
}

const authManager = new AuthManager();

export default authManager;
