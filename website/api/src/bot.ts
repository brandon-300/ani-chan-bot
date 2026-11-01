import express, { type Request, type Response } from 'express';
import { cfg, withMongo, requestLimited, type WebAccount, type Challenge } from './mongo';
import { signedIn } from './auth';
import { bearer, millis, originAllowed, otpDigest, pin, safeEqual, token, waid } from './security';

/**
 * Website ↔ WhatsApp identity linking. The only chat registration command is
 * .reg; this API is callable solely by the wweb.js bot with BOT_LINK_SECRET.
 * All writes stay in the isolated anichan_site DB, never gameplay collections.
 */
export const bot = express.Router();
const fail = (res:Response,status:number,error:string) => {
  res.status(status).set('Cache-Control','no-store').json({error});
};
const authBot = (req:Request):boolean =>
  !!cfg().BOT_LINK_SECRET && safeEqual(bearer(req),cfg().BOT_LINK_SECRET!);
const enabled = () => !!cfg().BOT_LINK_SECRET && cfg().WHATSAPP_LINK_ENABLED === 'true';

function candidate(req:Request): {whatsappId:string;code:string;siteId?:string}|null {
  const body=req.body && typeof req.body==='object' && !Array.isArray(req.body) ? req.body : {};
  const whatsappId=body.whatsappId;
  const code=body.code;
  const siteId=body.siteId;
  if(!waid(whatsappId) || typeof code!=='string' || !/^\d{8}$/.test(code))return null;
  if(siteId!==undefined && (typeof siteId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteId)))return null;
  return {whatsappId,code,siteId};
}
function profile(a:WebAccount){
  return {siteId:a._id,displayName:a.displayName,bio:a.bio,dob:a.dob,
    avatarData:a.avatarData,updatedAt:a.updatedAt};
}
async function getChallenge(db:import('mongodb').Db,code:string){
  const hash=await otpDigest(code,cfg().BOT_LINK_SECRET!);
  const challenge=await db.collection<Challenge>('challenges').findOne({
    purpose:'whatsapp-link', tokenHash:hash,claimedAt:null,expiresAt:{$gt:new Date()}
  });
  if(!challenge)return null;
  const account=await db.collection<WebAccount>('accounts').findOne({_id:challenge.accountId});
  if(!account || !account.emailVerifiedAt)return null;
  return {challenge,account,hash};
}
async function guarded(db:import('mongodb').Db,req:Request,res:Response,identity:string,tag:string){
  // Bound both to the sender and globally to limit accidental bot loops.
  const who=await requestLimited(db,identity,'wa-link:'+tag,12);
  const overall=await requestLimited(db,'stage','wa-link:global:'+tag,250);
  if(!who || !overall){fail(res,429,'Too many account linking attempts.');return false;}
  return true;
}

bot.get('/api/internal/profile',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  if(!enabled())return fail(res,503,'Website linking is not activated yet.');
  const whatsappId=req.query.waid;
  if(!waid(whatsappId))return fail(res,400,'Invalid sender identity.');
  try{await withMongo(async db=>{
    const a=await db.collection<WebAccount>('accounts').findOne({whatsappId});
    res.set('Cache-Control','no-store').json({account:a?profile(a):null});
  });}catch{if(!res.headersSent)fail(res,503,'Linking database is temporarily unavailable.');}
});

bot.post('/api/link/start',async(req,res)=>{
  if(!originAllowed(req))return fail(res,403,'Invalid request origin.');
  if(!enabled())return fail(res,503,'Website linking is not activated yet.');
  try{await withMongo(async db=>{
    const a=await signedIn(req,db);
    if(!a)return fail(res,401,'Please sign in.');
    if(!a.emailVerifiedAt)return fail(res,403,'Verify your email address before linking WhatsApp.');
    if(a.whatsappId)return fail(res,409,'This website account is already linked.');
    if(!await requestLimited(db,a._id,'link-start',5))return fail(res,429,'Too many linking requests.');
    // Keep a short-lived code, securely HMAC-hashed in MongoDB.
    // Extremely rare collision: try again rather than issuing an ambiguous code.
    for(let attempt=0;attempt<5;attempt++){
      const code=pin(),hash=await otpDigest(code,cfg().BOT_LINK_SECRET!);
      const existing=await db.collection<Challenge>('challenges').findOne({
        purpose:'whatsapp-link', tokenHash:hash, claimedAt:null, expiresAt:{$gt:new Date()}
      });
      if(existing)continue;
      await db.collection<Challenge>('challenges').deleteMany({accountId:a._id,purpose:'whatsapp-link'});
      await db.collection<Challenge>('challenges').insertOne({
        _id:token(16),accountId:a._id,purpose:'whatsapp-link',tokenHash:hash,attempts:0,
        expiresAt:new Date(millis()+600000),claimedAt:null
      });
      return res.set('Cache-Control','no-store').json({code,command:'.reg '+code,expiresInSeconds:600});
    }
    fail(res,503,'Could not generate a unique code. Please retry.');
  });}catch{if(!res.headersSent)fail(res,503,'Linking is temporarily unavailable.');}
});

bot.post('/api/internal/inspect-link',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  if(!enabled())return fail(res,503,'Website linking is not activated yet.');
  const input=candidate(req);
  if(!input)return fail(res,400,'Invalid linking request.');
  try{await withMongo(async db=>{
    if(!await guarded(db,req,res,input.whatsappId,'inspect'))return;
    const found=await getChallenge(db,input.code);
    if(!found)return fail(res,400,'Code incorrect, expired, or already used.');
    if(found.account.whatsappId && found.account.whatsappId!==input.whatsappId)return fail(res,409,'Website account already linked to another WhatsApp identity.');
    const other=await db.collection<WebAccount>('accounts').findOne({whatsappId:input.whatsappId});
    if(other && other._id!==found.account._id)return fail(res,409,'WhatsApp identity already belongs to another website account.');
    res.set('Cache-Control','no-store').json({account:profile(found.account)});
  });}catch{if(!res.headersSent)fail(res,503,'Link preflight temporarily unavailable.');}
});

bot.post('/api/internal/claim-link',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  if(!enabled())return fail(res,503,'Website linking is not activated yet.');
  const input=candidate(req);
  if(!input?.siteId)return fail(res,400,'Link claim must include verified website identity.');
  try{await withMongo(async db=>{
    if(!await guarded(db,req,res,input.whatsappId,'claim'))return;
    const found=await getChallenge(db,input.code);
    if(!found)return fail(res,400,'Code incorrect, expired, or already used.');
    if(found.account._id!==input.siteId)return fail(res,409,'Website account did not match the inspected code.');
    if(found.account.whatsappId && found.account.whatsappId!==input.whatsappId)return fail(res,409,'Website account already linked elsewhere.');
    const other=await db.collection<WebAccount>('accounts').findOne({whatsappId:input.whatsappId});
    if(other && other._id!==input.siteId)return fail(res,409,'WhatsApp identity already linked elsewhere.');
    // A single atomic update makes the code one-time even for simultaneous
    // requests from different bot workers. Winner alone may update account.
    const consumed=await db.collection<Challenge>('challenges').findOneAndUpdate({
      _id:found.challenge._id,claimedAt:null,expiresAt:{$gt:new Date()},attempts:{$lt:5}
    },{$set:{claimedAt:millis()}},{returnDocument:'after'});
    if(!consumed)return fail(res,409,'Code already consumed or expired.');
    // Partial unique index on whatsappId prevents concurrent cross-account
    // claims. On failure, burn the code; user can request another safely.
    try{
      const result=await db.collection<WebAccount>('accounts').updateOne({
        _id:input.siteId,
        $or:[{whatsappId:null},{whatsappId:input.whatsappId}]
      },{$set:{whatsappId:input.whatsappId,updatedAt:millis()}});
      if(result.matchedCount!==1)return fail(res,409,'Account linking conflict.');
    }catch{return fail(res,409,'Account linking conflict.');}
    const latest=await db.collection<WebAccount>('accounts').findOne({_id:input.siteId});
    if(!latest)return fail(res,409,'Website account no longer exists.');
    res.set('Cache-Control','no-store').json({ok:true,...profile(latest)});
  });}catch{if(!res.headersSent)fail(res,503,'Account linking temporarily unavailable.');}
});
