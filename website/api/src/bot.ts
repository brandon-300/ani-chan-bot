import express, { type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { cfg, withMongo, requestLimited, type WebAccount } from './mongo';
import { signedIn } from './auth';
import { bearer, digest, millis, originAllowed, safeEqual, token, waid } from './security';

/**
 * Website-only AniChan login/linking. A WhatsApp DM to .reg produces an opaque,
 * short-lived one-use URL fragment delivered to the verified WhatsApp contact.
 * Signup, login, email verification and final linking ALL happen in browser.
 * No chat OTP, no .reg CODE, and no gameplay collection writes from this API.
 */
export const bot = express.Router();
type Handoff = {
  _id: string; // SHA256 of a cryptographically random 32-byte URL token
  whatsappId: string;
  expiresAt: Date;
  claimedAt: number | null;
  createdAt: number;
};
const fail = (res:Response,status:number,error:string) => {
  res.status(status).set('Cache-Control','no-store').json({error});
};
const validSecret = () => typeof cfg().BOT_LINK_SECRET === 'string' && cfg().BOT_LINK_SECRET!.length >= 32;
const authBot = (req:Request) => validSecret() && safeEqual(bearer(req),cfg().BOT_LINK_SECRET!);
const enabled = () => validSecret() && cfg().WHATSAPP_LINK_ENABLED === 'true';
const profile = (a:WebAccount) => ({
  siteId:a._id,displayName:a.displayName,bio:a.bio,dob:a.dob,
  avatarData:a.avatarData,updatedAt:a.updatedAt
});
const remoteIp=(req:Request)=>req.get('CF-Connecting-IP')||'unavailable';

bot.get('/api/internal/profile',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  if(!enabled())return fail(res,503,'Website linking has not been activated.');
  const id=req.query.waid;
  if(!waid(id))return fail(res,400,'Invalid WhatsApp identity.');
  try{
    await withMongo(async db=>{
      const a=await db.collection<WebAccount>('accounts').findOne({whatsappId:id});
      res.set('Cache-Control','no-store').json({account:a?profile(a):null});
    });
  }catch{if(!res.headersSent)fail(res,503,'Website account service unavailable.');}
});

/** Authenticated bot call made ONLY in response to .reg in a private DM. */
bot.post('/api/internal/handoff',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  if(!enabled())return fail(res,503,'Website linking has not been activated.');
  const body=req.body && typeof req.body==='object' && !Array.isArray(req.body)?req.body:{};
  if(!waid(body.whatsappId))return fail(res,400,'Invalid WhatsApp identity.');
  const identity=body.whatsappId as string;
  try{
    await withMongo(async db=>{
      if(!await requestLimited(db,identity,'wa-handoff',5))return fail(res,429,'Too many registration links requested.');
      const existing=await db.collection<WebAccount>('accounts').findOne({whatsappId:identity});
      if(existing)return res.set('Cache-Control','no-store').json({linked:true});
      // Invalidate any previously sent link to this WhatsApp account.
      await db.collection<Handoff>('whatsappHandoffs').deleteMany({whatsappId:identity});
      const ticket=token(32); // 256-bit cryptographic randomness
      await db.collection<Handoff>('whatsappHandoffs').insertOne({
        _id:await digest(ticket), whatsappId:identity,
        expiresAt:new Date(millis()+900_000),claimedAt:null,createdAt:millis()
      });
      // The bot adds this ticket as a URL FRAGMENT (#wa=...), ensuring it is
      // not included in HTTP request paths, referrers or server access logs.
      res.set('Cache-Control','no-store').json({ticket,expiresInSeconds:900});
    });
  }catch{if(!res.headersSent)fail(res,503,'Unable to create a private website login link.');}
});

/**
 * Browser-only completion. The link is proof of possession of the actual
 * WhatsApp DM; website login + verified email are independently required.
 * Website DB applies a partial UNIQUE index on whatsappId. The ticket is
 * atomically consumed so it cannot be replayed or used for a second account.
 */
bot.post('/api/link/complete',async(req,res)=>{
  if(!originAllowed(req))return fail(res,403,'Invalid request origin.');
  if(!enabled())return fail(res,503,'Website linking has not been activated.');
  const input=req.body && typeof req.body==='object' && !Array.isArray(req.body)?req.body:{};
  if(typeof input.ticket!=='string' || !/^[a-f0-9]{64}$/.test(input.ticket)){
    return fail(res,400,'Invalid or expired private WhatsApp link.');
  }
  try{
    await withMongo(async db=>{
      const account=await signedIn(req,db);
      if(!account)return fail(res,401,'Log in on the website first.');
      if(!account.emailVerifiedAt)return fail(res,403,'Verify your email on the website before linking.');
      if(!await requestLimited(db,remoteIp(req),'wa-complete:'+account._id,8)){
        return fail(res,429,'Too many linking attempts.');
      }
      const tokenHash=await digest(input.ticket);
      const ticket=await db.collection<Handoff>('whatsappHandoffs').findOne({
        _id:tokenHash,claimedAt:null,expiresAt:{$gt:new Date()}
      });
      if(!ticket)return fail(res,400,'This WhatsApp link has expired or was already used. Send .reg privately to AniChan again.');
      if(account.whatsappId && account.whatsappId!==ticket.whatsappId){
        return fail(res,409,'This website account is already linked to another WhatsApp number.');
      }
      const conflict=await db.collection<WebAccount>('accounts').findOne({whatsappId:ticket.whatsappId});
      if(conflict && conflict._id!==account._id){
        return fail(res,409,'That WhatsApp identity belongs to another website account.');
      }
      // Claim only once, even when the user presses twice or opens two tabs.
      const consumed=await db.collection<Handoff>('whatsappHandoffs').findOneAndUpdate({
        _id:tokenHash,claimedAt:null,expiresAt:{$gt:new Date()}
      },{$set:{claimedAt:millis()}},{returnDocument:'after'});
      if(!consumed)return fail(res,409,'That private link was already used.');
      try{
        const updated=await db.collection<WebAccount>('accounts').updateOne({
          _id:account._id, $or:[{whatsappId:null},{whatsappId:ticket.whatsappId}]
        },{$set:{whatsappId:ticket.whatsappId,updatedAt:millis()}});
        if(updated.matchedCount!==1){
          return fail(res,409,'Account linking conflict. Send .reg to get another private link.');
        }
      }catch{return fail(res,409,'Account linking conflict. Send .reg to get another private link.');}
      res.set('Cache-Control','no-store').json({ok:true,linked:true,message:'WhatsApp connected. Return to AniChan and continue chatting.'});
    });
  }catch{if(!res.headersSent)fail(res,503,'Website linking is temporarily unavailable.');}
});
