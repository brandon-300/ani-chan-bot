import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const AUTH_DIR = path.resolve(__dirname, '../../auth_info_baileys');

class AuthManager {
  constructor() {
    this.state = null;
    this.saveCredsFn = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized && this.state) return this.state;
    await fs.mkdir(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    this.state = state;
    this.saveCredsFn = saveCreds;
    this.initialized = true;
    console.log(`✅ Baileys auth state initialized (${AUTH_DIR})`);
    return state;
  }

  isAuthenticated() {
    return Boolean(this.state?.creds?.registered);
  }

  getState() {
    if (!this.state) throw new Error('Baileys auth state is not initialized.');
    return this.state;
  }

  async saveCreds() {
    if (!this.saveCredsFn) throw new Error('Baileys credential writer is not initialized.');
    await this.saveCredsFn();
  }

  getSaveCreds() {
    if (!this.saveCredsFn) throw new Error('Baileys credential writer is not initialized.');
    return this.saveCredsFn;
  }

  async clear() {
    this.state = null;
    this.saveCredsFn = null;
    this.initialized = false;
  }

  async getPairingCode(sock) {
    if (!sock || typeof sock.requestPairingCode !== 'function') {
      throw new Error('Baileys socket is not ready to request a pairing code.');
    }
    const rawNumber = process.env.PHONE_NUMBER || process.env.BOT_NUMBER || '';
    const phoneNumber = rawNumber.replace(/\D/g, '');
    if (phoneNumber.length < 8 || phoneNumber.length > 15) {
      throw new Error('Set PHONE_NUMBER in .env to the WhatsApp account number with country code, digits only.');
    }
    return sock.requestPairingCode(phoneNumber);
  }
}

const authManager = new AuthManager();
export default authManager;
