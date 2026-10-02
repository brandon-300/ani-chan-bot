import socketManager from './socket.js';

function numberPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

class IdentityService {
  constructor() {
    this.sock = null;
    this.ownerIds = [process.env.OWNER_NUMBER, process.env.BOT_OWNER, ...(process.env.OWNER_IDS || '').split(',')]
      .map(value => String(value || '').trim()).filter(Boolean);
    this.modIds = (process.env.MOD_NUMBERS || '').split(',').map(value => value.trim()).filter(Boolean);
    this.contacts = new Map();
  }

  init(sock) { this.sock = sock || socketManager.getSocket(); }

  getSock() {
    if (!this.sock) this.sock = socketManager.getSocket();
    return this.sock;
  }

  normalizeJid(jid) {
    if (!jid) return jid;
    const clean = String(jid).trim();
    if (!clean) return clean;
    if (!clean.includes('@')) return /^\d+$/.test(clean) ? `${clean}@s.whatsapp.net` : clean;
    // Baileys may include a device suffix in a participant JID. Strip only
    // that device marker; preserve LID and group JIDs exactly otherwise.
    return clean.replace(/:\d+(?=@)/, '');
  }

  getSender(msg) {
    if (!msg) return null;
    let jid = msg.author || msg.senderId || null;
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
    const pushName = msg.pushName || msg.notifyName || this.contacts.get(jid) || numberPart(jid);
    return { id: jid, name: pushName, pushName, number: numberPart(jid) };
  }

  rememberContact(jid, name) {
    const normalized = this.normalizeJid(jid);
    if (normalized && name) this.contacts.set(normalized, String(name));
  }

  async resolveSenderName(msg) {
    const sender = this.getSender(msg);
    return sender?.pushName || sender?.name || numberPart(msg?.from) || 'Unknown';
  }

  isOwner(userId) {
    if (!userId) return false;
    const target = numberPart(this.normalizeJid(userId));
    return this.ownerIds.some(id => numberPart(this.normalizeJid(id)) === target);
  }

  isMod(userId) {
    if (this.isOwner(userId)) return true;
    if (!userId) return false;
    const target = numberPart(this.normalizeJid(userId));
    return this.modIds.some(id => numberPart(this.normalizeJid(id)) === target);
  }

  isAdmin(userId) { return this.isMod(userId); }

  getBotJid() {
    const sock = this.getSock();
    return this.normalizeJid(sock?.user?.id || socketManager.getWid() || '');
  }

  getBotNumber() {
    const jid = this.getBotJid();
    return jid ? numberPart(jid) : null;
  }

  mention(jid) {
    return jid ? `@${numberPart(this.normalizeJid(jid))}` : '';
  }

  async getUserInfo(jid) {
    if (!jid) throw new TypeError('A user JID is required.');
    const normalized = this.normalizeJid(jid);
    const cachedName = this.contacts.get(normalized);
    const name = cachedName || numberPart(normalized) || 'Unknown';
    return { id: normalized, name, pushName: name, isBot: normalized === this.getBotJid() };
  }

  isFromBot(msg) {
    if (!msg) return false;
    if (msg.fromMe) return true;
    const sender = this.getSender(msg);
    return Boolean(sender && sender.id === this.getBotJid());
  }

  async getContact(jid) {
    if (!jid) throw new TypeError('A contact JID is required.');
    const normalized = this.normalizeJid(jid);
    const number = numberPart(normalized);
    const name = this.contacts.get(normalized) || number || 'Unknown';
    const isMe = normalized === this.getBotJid();
    return {
      id: { _serialized: normalized, user: number },
      number,
      name,
      pushname: name,
      pushName: name,
      isMe,
    };
  }
}

const identity = new IdentityService();
export default identity;
