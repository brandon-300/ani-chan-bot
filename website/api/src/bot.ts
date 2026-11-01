import express, { type Request, type Response } from 'express';
import { cfg, withMongo, requestLimited, type WebAccount, type Challenge } from './mongo';
import { signedIn } from './auth';
import { bearer, millis, originAllowed, otpDigest, pin, safeEqual, token, waid } from './security';

export const bot = express.Router();
const fail=(res:Response,status:number,error:string)=>{res.status(status).set('Cache-Control','no-store').json({error});};
const authBot=(req:Request):boolean=>!!cfg().BOT_LINK_SECRET && safeEqual(bearer(req),cfg().BOT_LINK_SECRET!);
const enabled=()=>!!cfg().BOT_LINK_SECRET && cfg().WHATSAPP_LINK_ENABLED === 'true';

bot.get('/api/internal/profile',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  const whatsappId=req.query.waid;
  if(!waid(whatsappId))return fail(res,400,'Invalid sender identity.');
  try{await withMongo(async db=>{
    const a=await db.collection<WebAccount>('accounts').findOne({whatsappId});
    res.set('Cache-Control','no-store').json({account:a?{
      siteId:a._id,displayName:a.displayName,bio:a.bio,dob:a.dob,
      avatarData:a.avatarData,updatedAt:a.updatedAt
    }:null});
  });}catch{fail(res,503,'Linking database is temporarily unavailable.');}
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
    const code=pin(),key=await otpDigest(code,cfg().BOT_LINK_SECRET!);
    await db.collection<Challenge>('challenges').deleteMany({accountId:a._id,purpose:'whatsapp-link'});
    await db.collection<Challenge>('challenges').insertOne({
      _id:token(16),accountId:a._id,purpose:'whatsapp-link',tokenHash:key,attempts:0,
      expiresAt:new Date(millis()+600000),claimedAt:null
    });
    res.set('Cache-Control','no-store').json({code,command:'.reg '+code,expiresInSeconds:600});
  });}catch{if(!res.headersSent)fail(res,503,'Linking is temporarily unavailable.');}
});
bot.post('/api/internal/claim-link',async(req,res)=>{
  if(!authBot(req))return fail(res,403,'Forbidden.');
  const body=(req.body && typeof req.body==='object')?req.body:{};
  const code=String(body.code||'');
  if(!waid(body.whatsappId)||!/^\d{8}$/.test(code))return fail(res,400,'Invalid linking request.');
  if(!enabled())return fail(res,503,'Website linking is not activated yet.');
  try{await withMongo(async db=>{
    const identity=body.whatsappId as string;
    if(!await requestLimited(db,identity,'link-attempt',7))return fail(res,429,'Too many attempts.');
    const key=await otpDigest(code,cfg().BOT_LINK_SECRET!);
    const claimed=await db.collection<Challenge>('challenges').findOneAndUpdate({
      purpose:'whatsapp-link',tokenHash:key,claimedAt:null,expiresAt:{$gt:new Date()}
    },{$set:{claimedAt:millis()}},{returnDocument:'after'});
    if(!claimed)return fail(res,400,'Code incorrect, expired, or already used.');
    const a=await db.collection<WebAccount>('accounts').findOne({_id:claimed.accountId});
    if(!a)return fail(res,409,'Website account no longer exists.');
    if(a.whatsappId && a.whatsappId !== identity)return fail(res,409,'Account already linked elsewhere.');
    const conflict=await db.collection<WebAccount>('accounts').findOne({whatsappId:identity});
    if(conflict && conflict._id!==a._id)return fail(res,409,'WhatsApp identity already belongs to another account.');
    try{
      const changed=await db.collection<WebAccount>('accounts').updateOne(
        {_id:a._id,$or:[{whatsappId:null},{whatsappId:identity}]},
        {$set:{whatsappId:identity,updatedAt:millis()}}
      );
      if(changed.matchedCount!==1)return fail(res,409,'Account linking conflict.');
    }catch{return fail(res,409,'Account linking conflict.');}
    res.set('Cache-Control','no-store').json({
      ok:true,siteId:a._id,displayName:a.displayName,bio:a.bio,
      dob:a.dob,avatarData:a.avatarData,updatedAt:millis()
    });
  });}catch{if(!res.headersSent)fail(res,503,'Account linking temporarily unavailable.');}
});
