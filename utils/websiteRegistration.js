'use strict';

/**
 * Preserve the existing AniChan .reg command. Never register extra commands.
 * Staging link activation requires an explicit owner-side .env switch.
 * The site first inspects the code without spending it; the bot checks
 * legacy user records before the one-time website claim can be consumed.
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
  // No guessing mobile numbers from Baileys @lid or group identifiers.
  throw new Error('Cannot securely identify this WhatsApp sender.');
}

function relatedUserIds(raw, pn) {
  const ids = new Set([raw, pn]);
  if (pn.endsWith('@s.whatsapp.net')) ids.add(pn.replace('@s.whatsapp.net', '@c.us'));
  return [...ids];
}

async function getSender(msg) {
  // Only the existing .reg handler calls this, and it rejects group chats.
  const contact = await msg.getContact();
  const raw = String(contact?.id?._serialized || '');
  if (!/^\d+@(c\.us|s\.whatsapp\.net)$/.test(raw)) {
    throw new Error('This WhatsApp identity cannot be verified.');
  }
  return { raw, pn:canonicalizeSender(raw) };
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
    redirect:'error', cache:'no-store'
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)) {
    throw new Error('Website identity is missing or invalid.');
  }
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
  return { siteId,name,bio,dob,age,avatar };
}

/**
 * Resolve all possible legacy JID variants BEFORE consuming a one-time code.
 * One existing account is retained under its original MongoDB id.
 * Never merge different ids or overwrite another websiteAccountId.
 */
async function planProfile(sender, source) {
  const profile=checkedProfile(source);
  const ids=relatedUserIds(sender.raw,sender.pn);
  const [records,claimed]=await Promise.all([
    User.find({id:{$in:ids}}).select('id websiteAccountId').lean(),
    User.findOne({websiteAccountId:profile.siteId}).select('id').lean()
  ]);
  if(records.length>1)throw new Error('Multiple legacy accounts found for this WhatsApp number. Owner reconciliation is required.');
  const userId=records[0]?.id || sender.raw;
  if(claimed?.id && claimed.id!==userId)throw new Error('This website account is already connected to another WhatsApp user.');
  if(records[0]?.websiteAccountId && records[0].websiteAccountId!==profile.siteId){
    throw new Error('Your existing WhatsApp account is already linked to a different website login.');
  }
  return {userId,existing:Boolean(records.length),profile};
}

async function applyProfile(sender, source, earlierPlan) {
  // Repeat all local checks after the website claim to detect races.
  const plan=await planProfile(sender,source);
  if(earlierPlan && (earlierPlan.userId!==plan.userId ||
      earlierPlan.profile.siteId!==plan.profile.siteId)){
    throw new Error('WhatsApp identity state changed during linking; send .reg to recover.');
  }
  const {userId,existing,profile}=plan;
  const update={
    name:profile.name,bio:profile.bio,dob:profile.dob,age:profile.age,
    websiteAccountId:profile.siteId,websiteLinkedAt:new Date(),
    'registration.status':'active','registration.nameSet':true,
    'registration.dobSet':true,'registration.bioSet':true,'registration.picSet':true
  };
  let pictureWarning='';
  if(profile.avatar){
    if(!isCloudConfigured()){
      pictureWarning='Profile picture syncing needs Cloudinary configuration.';
    }else{
      try{
        const bytes=Buffer.from(profile.avatar.split(',')[1],'base64');
        const ownerHash=crypto.createHash('sha256').update(userId).digest('hex').slice(0,24);
        const uploaded=await uploadBufferToCloud(bytes,{
          folder:'anichan/profile_pics',publicId:'website_'+ownerHash
        });
        update['profile.picUrl']=uploaded.url;
        update['profile.picPublicId']=uploaded.publicId;
      }catch{
        pictureWarning='The profile picture could not be uploaded yet; retry .reg later.';
      }
    }
  }
  // Atomic compare-and-set: a conflicting website link is never overwritten,
  // including when another request claims an account between preflight/write.
  const filter={
    id:userId,
    $or:[{websiteAccountId:profile.siteId},{websiteAccountId:null},{websiteAccountId:{$exists:false}}]
  };
  const options={upsert:!existing,new:true,setDefaultsOnInsert:true};
  const payload={ $set:update };
  if(!existing)payload.$setOnInsert={id:userId};
  let saved;
  try{saved=await User.findOneAndUpdate(filter,payload,options);}
  catch(err){
    if(err?.code===11000)throw new Error('An account was linked concurrently; send .reg to reconcile.');
    throw err;
  }
  if(!saved)throw new Error('Your WhatsApp account changed during linking; send .reg to retry.');
  // Existing coins, bank, cards, guild, loans, sessions, XP and inventory
  // are intentionally absent from $set.
  return {userId,pictureWarning,existing};
}

async function claimWebsiteCode(msg, code) {
  if(!websiteRegistrationActive())throw new Error('Website linking is not enabled yet.');
  if(!/^\d{8}$/.test(code))throw new Error('Use an eight-digit code from your AniChan website dashboard.');
  const sender=await getSender(msg);
  // Step 1: inspect without consuming the code.
  const preview=await siteRequest('/api/internal/inspect-link',{
    method:'POST',data:{whatsappId:sender.pn,code}
  });
  const plan=await planProfile(sender,preview.account);
  // Step 2: claim atomically only after both sides passed preflight checks.
  const claimed=await siteRequest('/api/internal/claim-link',{
    method:'POST',data:{whatsappId:sender.pn,code,siteId:plan.profile.siteId}
  });
  if(claimed.siteId!==plan.profile.siteId)throw new Error('Website account identity changed during linking.');
  // Step 3: update only profile and linking fields on the existing bot user.
  // If this write fails after the website claim, plain .reg can restore it.
  return applyProfile(sender,claimed,plan);
}

async function restoreLinkedProfile(msg) {
  if(!websiteRegistrationActive())return null;
  const sender=await getSender(msg);
  const data=await siteRequest('/api/internal/profile?waid='+encodeURIComponent(sender.pn));
  if(!data.account)return null;
  return applyProfile(sender,data.account);
}

module.exports={websiteRegistrationActive,claimWebsiteCode,restoreLinkedProfile};
