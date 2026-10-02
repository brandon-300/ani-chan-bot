/**
 * Auth Manager
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
  }

  /**
   * Initialize auth state
   */
  async init() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      this.state = state;
      this.saveCreds = saveCreds;
      
      // Check if authenticated
      this.isAuthenticatedFlag = this.checkAuthenticated();
      
      console.log('Auth state initialized');
    } catch (error) {
      console.error('Failed to initialize auth state:', error);
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
      // For now, just reset the flag
      // Actual file cleanup would need to delete the auth directory
      this.isAuthenticatedFlag = false;
      console.log('Auth state cleared');
    } catch (error) {
      console.error('Failed to clear auth state:', error);
      throw error;
    }
  }
}

// Singleton instance
const authManager = new AuthManager();

// Initialize immediately
authManager.init().catch(err => {
  console.error('Failed to initialize auth manager:', err);
});

export default authManager;
