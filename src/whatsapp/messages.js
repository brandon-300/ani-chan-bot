import { toBaileysMediaPayload } from './media.js';
import socketManager from './socket.js';

function messageKey(message) {
  const raw = message?._baileys?.key || message?.key || {};
  const id = raw.id || message?.id?._serialized || message?.id;
  const remoteJid = raw.remoteJid || message?.chatId || message?.from;
  if (!id || !remoteJid) return null;
  return {
    ...raw,
    id,
    remoteJid,
    fromMe: raw.fromMe ?? Boolean(message?.fromMe),
    participant: raw.participant || (message?.isGroup ? message?.author : undefined),
  };
}

function payloadFor(content, options = {}) {
  const mediaPayload = toBaileysMediaPayload(content, options);
  if (mediaPayload) return mediaPayload;
  if (typeof content === 'string') {
    const text = { text: content };
    if (Array.isArray(options.mentions) && options.mentions.length) text.mentions = options.mentions;
    return text;
  }
  if (content && typeof content === 'object') {
    const payload = { ...content };
    if (Array.isArray(options.mentions) && options.mentions.length) payload.mentions = options.mentions;
    if (options.caption !== undefined && payload.caption === undefined) payload.caption = options.caption;
    return payload;
  }
  return { text: String(content ?? '') };
}

function sendOptions(options = {}, quotedMessage = null) {
  const output = {};
  const quoted = options.quoted || quotedMessage?._baileys || null;
  if (quoted) output.quoted = quoted;
  if (options.linkPreview !== undefined) output.linkPreview = options.linkPreview;
  if (options.messageId) output.messageId = options.messageId;
  return output;
}

class MessagesService {
  constructor() {
    this.sock = null;
  }

  init(sock) {
    this.sock = sock || null;
  }

  getSock() {
    if (!this.sock) throw new Error('WhatsApp socket is not initialized.');
    return this.sock;
  }

  async sendText(jid, text, options = {}) {
    return this.sendMessage(jid, text, options);
  }

  async sendMessage(jid, content, options = {}, quotedMessage = null) {
    if (!jid) throw new TypeError('A recipient JID is required.');
    const sock = this.getSock();
    const payload = payloadFor(content, options);
    const result = await sock.sendMessage(jid, payload, sendOptions(options, quotedMessage));
    if (result?.key) socketManager.registerSentMessage(result.key, result);
    return result;
  }

  async reply(message, content, options = {}) {
    const jid = message?.chatId || message?.from;
    if (!jid) throw new TypeError('Cannot reply to a message without a chat JID.');
    const quote = message?._baileys || null;
    return this.sendMessage(jid, content, { ...options, quoted: options.quoted || quote });
  }

  async react(message, emoji) {
    const sock = this.getSock();
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot react without a valid WhatsApp message key.');
    return sock.sendMessage(key.remoteJid, { react: { text: String(emoji || ''), key } });
  }

  async delete(message, forEveryone = true) {
    const sock = this.getSock();
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot delete without a valid WhatsApp message key.');
    if (!forEveryone) return false;
    return sock.sendMessage(key.remoteJid, { delete: key });
  }

  async edit(message, newText) {
    const jid = message?.chatId || message?.from;
    if (!jid) throw new TypeError('Cannot edit a message without a chat JID.');
    await this.delete(message, true);
    return this.sendText(jid, newText);
  }

  async sendTyping(jid) {
    return this.getSock().sendPresenceUpdate('composing', jid);
  }

  async sendRecording(jid) {
    return this.getSock().sendPresenceUpdate('recording', jid);
  }

  async clearPresence(jid) {
    return this.getSock().sendPresenceUpdate('paused', jid);
  }

  async markAsRead(message) {
    const key = messageKey(message);
    if (!key) throw new TypeError('Cannot mark read without a valid WhatsApp message key.');
    return this.getSock().readMessages([key]);
  }
}

const messages = new MessagesService();
export default messages;
