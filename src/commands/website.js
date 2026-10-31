'use strict';
// AniChan website/WhatsApp account linking. Never trust a self-entered phone
// number; the WhatsApp adapter supplies the sender's authenticated JID.
import crypto from 'node:crypto';
import User from '../models/User.js';
import * as cloud from '../utils/cloudinary.js';
import identity from '../whatsapp/identity.js';

const SITE = (process.env.ANICHAN_SITE_URL || 'https://anichan.pages.dev').replace(/\/+$/, '');
const SECRET = process.env.ANICHAN_SITE_BOT_SECRET || '';
function asPhoneJid(jid) {
  const value = String(jid || '').replace(/:\d+(?=@)/, '');
  if (/^\d+@c\.us$/.test(value)) return value.replace('@c.us', '@s.whatsapp.net');
  if (/^\d+@(s\.whatsapp\.net|lid)$/.test(value)) return value;
  throw Error('Unsupported WhatsApp sender identity.');
}
async function senderInfo(msg) {
  const chat = await msg.getChat();
  if (!chat || chat.isGroup || String(msg.from || '').endsWith('@g.us')) {
    return null;
  }
  const raw = String(msg.author || msg.from);
  const normalized = asPhoneJid(raw);
  if (normalized.endsWith('@lid')) {
    // A LID is NOT a telephone number. Never assume its digits are the user's
    // phone number: that would risk creating a duplicate legacy account.
    const pn = await identity.lookupPnForLid(normalized);
    if (!pn) throw Error('WhatsApp LID-to-number mapping is unavailable. Retry later; no user data was changed.');
    return { raw, canonical: asPhoneJid(pn) };
  }
  return { raw, canonical: normalized };
}
async function websiteFetch(path, options = {}) {
  if (SECRET.length < 32) throw Error('Website linking is not configured yet on this bot.');
  if (!SITE.startsWith('https://')) throw Error('The website requires HTTPS.');
  const res = await fetch(SITE + path, {
    method: options.method || 'GET',
    headers: { Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/json' },
    body: options.data ? JSON.stringify(options.data) : undefined,
    signal: AbortSignal.timeout(13000),
    redirect: 'error'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error || 'Website request failed. Try again later.');
  return data;
}
function validatedProfile(p) {
  if (!p || !p.siteId || typeof p.displayName !== 'string') {
    throw Error('Incomplete linked website profile.');
  }
  const name = p.displayName.trim();
  if (name.length < 2 || name.length > 32) throw Error('Website profile name is invalid.');
  const dob = String(p.dob || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw Error('Update your date of birth on the website first.');
  const date = new Date(dob + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dob) throw Error('Invalid website date of birth.');
  const today = new Date();
  let age = today.getUTCFullYear() - date.getUTCFullYear();
  if (today.getUTCMonth() < date.getUTCMonth() ||
      (today.getUTCMonth() === date.getUTCMonth() && today.getUTCDate() < date.getUTCDate())) age--;
  if (age < 18 || age > 120) throw Error('Website account does not meet the age requirement.');
  const bio = String(p.bio || '').trim().slice(0, 160);
  const avatar = String(p.avatarData || '');
  if (avatar && (avatar.length > 120000 || !/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(avatar))) {
    throw Error('Website picture is invalid.');
  }
  return { name, bio, date, age, avatar };
}
function variants(jid) {
  const normalized = String(jid).replace(/:\d+(?=@)/, '');
  if (normalized.endsWith('@s.whatsapp.net')) return [normalized.replace('@s.whatsapp.net','@c.us'), normalized];
  if (normalized.endsWith('@c.us')) return [normalized, normalized.replace('@c.us','@s.whatsapp.net')];
  return [normalized];
}
async function applyWebsiteProfile(sender, source) {
  const profile = validatedProfile(source);
  // Look up legacy wweb.js IDs first to avoid creating a second balance or
  // inventory for a user who has migrated to Baileys.
  const candidateIds = Array.from(new Set([...variants(sender.raw), ...variants(sender.canonical)]));
  const matches = await User.find({ id: { $in: candidateIds } }).select('id profile').lean();
  if (matches.length > 1) throw Error('Multiple legacy WhatsApp account IDs detected. Manual reconciliation is required.');
  const userId = matches[0]?.id || sender.raw;
  const set = {
    name: profile.name,
    bio: profile.bio,
    dob: profile.date,
    age: profile.age,
    registration: { status: 'active', nameSet: true, dobSet: true, bioSet: true, picSet: true }
  };
  let pictureWarning = '';
  if (profile.avatar) {
    if (!cloud.isCloudConfigured()) {
      pictureWarning = 'Cloudinary is unavailable; profile picture will sync later.';
    } else {
      const raw = Buffer.from(profile.avatar.split(',')[1], 'base64');
      const ownerHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 18);
      const imageHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 14);
      const pic = await cloud.uploadBufferToCloud(raw, { folder: 'anichan/profile_pics', publicId: 'web_' + ownerHash + '_' + imageHash });
      set['profile.picUrl'] = pic.url;
      set['profile.picPublicId'] = pic.publicId;
    }
  }
  await User.findOneAndUpdate({ id: userId }, { $set: set }, {
    upsert: true, new: true, setDefaultsOnInsert: true
  });
  // Never overwrite coins, bank balance, card ownership, guilds or inventory.
  return { userId, pictureWarning };
}
async function safeSync(msg, sender) {
  const response = await websiteFetch('/api/internal/profile?waid=' + encodeURIComponent(sender.canonical));
  if (!response.account) return null;
  return applyWebsiteProfile(sender, response.account);
}
const websiteCommands = {
  async website(client,msg) {
    await msg.reply('🌸 *AniChan Website*\n\n' + SITE +
      '\n\nCreate or sign into your website account. Linking is required to synchronize your profile with the bot.\n\nOnce linking is activated, generate a code in your website dashboard and send * .link 12345678 * privately to this bot. Never share your code.');
  },
  async link(client,msg,args) {
    let sender;
    try { sender = await senderInfo(msg); }
    catch { return msg.reply('❌ Cannot securely resolve your WhatsApp identity right now.'); }
    if (!sender) return msg.reply('🔒 Account linking only works in a private message with AniChan.');
    if (SECRET.length < 32) return msg.reply('⏳ Website linking is being configured. Visit ' + SITE);
    const code = String(args?.[0] || '').trim();
    if (!/^\d{8}$/.test(code)) return msg.reply('🌸 Open ' + SITE + '/dashboard, generate a WhatsApp link code and send *.link 12345678* here in DM.');
    try {
      const linked = await websiteFetch('/api/internal/claim-link', { method: 'POST', data: { whatsappId: sender.canonical, code } });
      // This can fail after the website link was claimed. The separate
      // .syncprofile command retries idempotently without reusing the code.
      const result = await applyWebsiteProfile(sender, linked);
      return msg.reply('✅ Your AniChan website account is linked!\n\nProfile synchronized. Your existing coins, cards and guild are preserved.' +
        (result.pictureWarning ? '\n⚠️ ' + result.pictureWarning : ''));
    } catch (err) {
      return msg.reply('⚠️ Could not complete linking: ' + err.message +
        '\n\nIf the website already shows you are linked, run *.syncprofile* to recover.');
    }
  },
  async syncprofile(client,msg) {
    let sender;
    try { sender = await senderInfo(msg); }
    catch { return msg.reply('❌ Cannot securely resolve your WhatsApp identity right now.'); }
    if (!sender) return msg.reply('🔒 Website profile syncing is only available in DMs.');
    if (SECRET.length < 32) return msg.reply('⏳ Website sync has not been activated yet.');
    try {
      const synced = await safeSync(msg, sender);
      if (!synced) return msg.reply('🔗 No linked website account found. Visit ' + SITE + '/dashboard first.');
      return msg.reply('✅ Synced your display name, bio, date of birth, and available profile picture from the website.' +
        (synced.pictureWarning ? '\n⚠️ ' + synced.pictureWarning : ''));
    } catch (err) {
      return msg.reply('⚠️ Profile sync failed: ' + err.message);
    }
  }
};
export default websiteCommands;
