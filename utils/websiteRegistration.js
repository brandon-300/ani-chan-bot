'use strict';

/**
 * The *existing* .reg command is the only entry point for website signup and
 * WhatsApp identity verification. No new chat commands are registered here.
 * This integration stays off until ANICHAN_REG_LINK_ENABLED=true is explicitly
 * configured on the running wweb.js bot.
 */
const crypto = require('node:crypto');
const User = require('../models/User');
const { uploadBufferToCloud, isCloudConfigured } = require('./cloudinary');

const SITE = (process.env.ANICHAN_SITE_URL || 'https://anichan.pages.dev').replace(/\/+$/, '');
const SECRET = process.env.ANICHAN_SITE_BOT_SECRET || '';
const ACTIVE = process.env.ANICHAN_REG_LINK_ENABLED === 'true';

function websiteRegistrationActive() {
  return ACTIVE && SECRET.length >= 32;
}

function canonicalizeSender(jid) {
  const raw = String(jid || '').trim().replace(/:\d+(?=@)/, '');
  if (/^\d+@c\.us$/.test(raw)) return raw.replace('@c.us', '@s.whatsapp.net');
  if (/^\d+@s\.whatsapp\.net$/.test(raw)) return raw;
  // The current bot is whatsapp-web.js. Unresolved Baileys @lid IDs must
  // never be treated as a phone number when assigning an existing account.
  throw new Error('Cannot securely identify this WhatsApp sender.');
}

function relatedUserIds(raw, pn) {
  const set = new Set([raw, pn]);
  if (pn.endsWith('@s.whatsapp.net')) set.add(pn.replace('@s.whatsapp.net', '@c.us'));
  return [...set];
}

async function getSender(msg) {
  const contact = await msg.getContact();
  const raw = String(contact?.id?._serialized || msg.author || msg.from || '');
  if (!raw || !/^\d+@(c\.us|s\.whatsapp\.net)$/.test(raw)) {
    throw new Error('This WhatsApp identity cannot be verified.');
  }
  return { raw, pn: canonicalizeSender(raw) };
}

async function siteRequest(path, { method = 'GET', data } = {}) {
  if (!websiteRegistrationActive()) throw new Error('Website account linking is not enabled yet.');
  const url = new URL(SITE);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Website connection settings are invalid.');
  }
  const response = await fetch(url.origin + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + SECRET,
      ...(data ? { 'Content-Type': 'application/json' } : {})
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(13000),
    redirect: 'error',
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(
    response.status >= 500 ? 'The website is temporarily unavailable.' :
    typeof payload.error === 'string' ? payload.error : 'The verification failed.'
  );
  return payload;
}

function checkedProfile(source) {
  const siteId = String(source?.siteId || '');
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw new Error('Website identity is missing or invalid.');
  const name = String(source?.displayName || '').trim();
  if (name.length < 2 || name.length > 32) throw new Error('Invalid website display name.');
  const bio = String(source?.bio || '').trim();
  if (bio.length > 160) throw new Error('Invalid website bio.');
  const dobText = String(source?.dob || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobText)) throw new Error('Set your date of birth on the website first.');
  const dob = new Date(dobText + 'T00:00:00Z');
  if (Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== dobText) {
    throw new Error('Invalid website date of birth.');
  }
  const today = new Date();
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  if (today.getUTCMonth() < dob.getUTCMonth() ||
      (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate())) age--;
  if (age < 18 || age > 120) throw new Error('The website account does not meet the age requirement.');
  const avatar = String(source?.avatarData || '');
  if (avatar && (avatar.length > 120000 ||
      !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(avatar))) {
    throw new Error('The website profile picture is invalid.');
  }
  return { siteId, name, bio, dob, age, avatar };
}

async function applyProfile(sender, source) {
  const profile = checkedProfile(source);
  const ids = relatedUserIds(sender.raw, sender.pn);
  const [records, claimed] = await Promise.all([
    User.find({ id: { $in: ids } }).select('id websiteAccountId').lean(),
    User.findOne({ websiteAccountId: profile.siteId }).select('id').lean()
  ]);
  if (records.length > 1) throw new Error('Multiple legacy accounts found for this WhatsApp number. Owner reconciliation is required.');
  const userId = records[0]?.id || sender.raw;
  if (claimed?.id && claimed.id !== userId) throw new Error('This website account is already connected to another WhatsApp user.');
  if (records[0]?.websiteAccountId && records[0].websiteAccountId !== profile.siteId) {
    throw new Error('Your existing WhatsApp account is already linked to a different website login.');
  }
  const update = {
    name: profile.name,
    bio: profile.bio,
    dob: profile.dob,
    age: profile.age,
    websiteAccountId: profile.siteId,
    websiteLinkedAt: new Date(),
    'registration.status': 'active',
    'registration.nameSet': true,
    'registration.dobSet': true,
    'registration.bioSet': true,
    'registration.picSet': true
  };
  let pictureWarning = '';
  if (profile.avatar) {
    if (!isCloudConfigured()) {
      pictureWarning = 'Profile picture syncing needs Cloudinary configuration.';
    } else {
      try {
        const bytes = Buffer.from(profile.avatar.split(',')[1], 'base64');
        const ownerHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
        const uploaded = await uploadBufferToCloud(bytes, {
          folder: 'anichan/profile_pics',
          publicId: 'website_' + ownerHash
        });
        update['profile.picUrl'] = uploaded.url;
        update['profile.picPublicId'] = uploaded.publicId;
      } catch {
        pictureWarning = 'The profile picture could not be uploaded yet; retry registration later.';
      }
    }
  }

  // The $set list contains ONLY profile/linking data. Existing coins, bank,
  // cards, loans, orbs, guilds, inventory, XP, games and achievements survive.
  await User.findOneAndUpdate(
    { id: userId },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return { userId, pictureWarning, existing: Boolean(records.length) };
}

async function claimWebsiteCode(msg, code) {
  if (!websiteRegistrationActive()) throw new Error('Website linking is not enabled yet.');
  if (!/^\d{8}$/.test(code)) throw new Error('Use an eight-digit code from your AniChan website dashboard.');
  const sender = await getSender(msg);
  const claimed = await siteRequest('/api/internal/claim-link', {
    method: 'POST',
    data: { whatsappId: sender.pn, code }
  });
  // Claiming the D1 code precedes the MongoDB profile update. If the update
  // fails, .reg without arguments can recover by reading /api/internal/profile.
  return applyProfile(sender, claimed);
}

async function restoreLinkedProfile(msg) {
  if (!websiteRegistrationActive()) return null;
  const sender = await getSender(msg);
  const data = await siteRequest('/api/internal/profile?waid=' + encodeURIComponent(sender.pn));
  if (!data.account) return null;
  return applyProfile(sender, data.account);
}

module.exports = { websiteRegistrationActive, claimWebsiteCode, restoreLinkedProfile };
