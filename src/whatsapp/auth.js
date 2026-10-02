/**
 * Auth Manager for WhatsApp Adapter
 * Handles authentication state for Baileys
 * Uses multi-file auth state for Termux compatibility
 */

import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_DIR = path.join(__dirname, '../../../auth_info_baileys');

/**
 * Auth Manager
 * Manages authentication state and credentials
 */
class AuthManager {
  constructor() {
    this.state = null;
    this.saveCreds = null;
    this.isAuthenticatedFlag = false;
    this.initialized = false;
  }

  /**
   * Initialize auth state
   */
  async init() {
    if (this.initialized) {
      return this.state;
    }
    
    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      this.state = state;
      this.saveCreds = saveCreds;
      
      // Check if authenticated
      this.isAuthenticatedFlag = this.checkAuthenticated();
      this.initialized = true;
      
      console.log('✅ Auth state initialized');
      return this.state;
    } catch (error) {
      console.error('❌ Failed to initialize auth state:', error);
      throw error;
    }
  }

  /**
   * Check if authenticated
   */
  checkAuthenticated() {
    if (!this.state) return false;
    return this.state.creds && this.state.creds.registered;
  }

  /**
   * Check if currently authenticated
   */
  isAuthenticated() {
    return this.isAuthenticatedFlag;
  }

  /**
   * Get auth state
   */
  getState() {
    if (!this.state) {
      throw new Error('Auth state not initialized. Call init() first.');
    }
    return this.state;
  }

  /**
   * Save credentials
   */
  async saveCreds() {
    if (!this.saveCreds) {
      throw new Error('saveCreds not initialized. Call init() first.');
    }
    return this.saveCreds();
  }

  /**
   * Get saveCreds function (for compatibility)
   */
  getSaveCreds() {
    if (!this.saveCreds) {
      throw new Error('saveCreds not initialized. Call init() first.');
    }
    return this.saveCreds;
  }

  /**
   * Clear auth state
   */
  async clear() {
    try {
      this.isAuthenticatedFlag = false;
      this.state = null;
      this.saveCreds = null;
      this.initialized = false;
      console.log('✅ Auth state cleared');
    } catch (error) {
      console.error('❌ Failed to clear auth state:', error);
      throw error;
    }
  }

  /**
   * Get pairing code for Termux
   * Uses PHONE_NUMBER from .env
   */
  async getPairingCode(sock) {
    if (!sock) {
      throw new Error('Socket not provided');
    }
    
    const phoneNumber = process.env.PHONE_NUMBER || process.env.BOT_NUMBER;
    if (!phoneNumber) {
      throw new Error('PHONE_NUMBER or BOT_NUMBER not set in .env, cannot generate pairing code');
    }
    
    try {
      console.log(`🔑 Requesting pairing code for: ${phoneNumber}`);
      const pairingCode = await sock.requestPairingCode(phoneNumber);
      console.log(`✅ Pairing code generated: ${pairingCode}`);
      return pairingCode;
    } catch (error) {
      console.error('❌ Failed to generate pairing code:', error);
      throw error;
    }
  }
}

// Singleton instance
const authManager = new AuthManager();

export default authManager;
