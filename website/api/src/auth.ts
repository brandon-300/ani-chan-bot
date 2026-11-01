import express, { type Request, type Response } from 'express';
import type { Db } from 'mongodb';
import { cfg, publicAccount, requestLimited, withMongo, type WebAccount, type Session, type Challenge } from './mongo';
import { cookieValue, digest, isAdult, millis, normalizedEmail, normalizedString,
  originAllowed, passwordDigest, pin, otpDigest, safeEqual, setSessionCookie, token } from './security';

export const auth = express.Router();
const ipOf = (req: Request) => req.get('CF-Connecting-IP') || 'unknown';
const reject = (res: Response, status: number, error: string) => {res.status(status).set('Cache-Control','no-store').json({error});};
const validateEmail = (email: string) => email.length<160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const authBody = (req: Request) => (req.body && typeof req.body==='object' && !Array.isArray(req.body)) ? req.body : {};
const settingsReady = () => !!(cfg().RESEND_API_KEY && cfg().EMAIL_FROM && cfg().OTP_SECRET && cfg().OTP_SECRET!.length>=32);

export async function signedIn(req: Request, db: Db): Promise<WebAccount|null> {
  const cookie = cookieValue(req);
  if (!cookie) return null;
  const session = await db.collection<Session>('sessions').findOne({_id:await digest(cookie),expiresAt:{$gt:new Date()}});
  if (!session) return null;
  return db.collection<WebAccount>('accounts').findOne({_id:session.accountId});
}
async function startSession(res: Response, db:Db, account:WebAccount) {
  const raw=token(), expiresAt=new Date(millis()+14*86400_000);
  await db.collection<Session>('sessions').insertOne({_id:await digest(raw),accountId:account._id,expiresAt});
  setSessionCookie(res,raw);
}
async function sendEmail(to:string,subject:string,text:string): Promise<void> {
  const e=cfg();
  if(!settingsReady()) throw Error('Email service is not configured.');
  const r=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+e.RESEND_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({from:e.EMAIL_FROM,to:[to],subject,text}),signal:AbortSignal.timeout(10000)
  });
  if(!r.ok)throw Error('Email could not be delivered.');
}
async function createChallenge(db:Db,account:WebAccount,purpose:'verify-email'|'reset-password'):Promise<string> {
  const code=String(Math.floor(100000+crypto.getRandomValues(new Uint32Array(1))[0]/4294967296*900000));
  const hash=await otpDigest(code+':'+purpose+':'+account._id,cfg().OTP_SECRET!);
  await db.collection<Challenge>('challenges').deleteMany({accountId:account._id,purpose});
  await db.collection<Challenge>('challenges').insertOne({_id:token(16),accountId:account._id,purpose,
    tokenHash:hash,attempts:0,expiresAt:new Date(millis()+10*60000),claimedAt:null});
  return code;
}
async function claimEmailChallenge(db:Db,account:WebAccount,purpose:'verify-email'|'reset-password',raw:unknown):Promise<boolean> {
  const code=String(raw||'');
  if(!/^\d{6}$/.test(code))return false;
  const existing=await db.collection<Challenge>('challenges').findOne({accountId:account._id,purpose,claimedAt:null,expiresAt:{$gt:new Date()}});
  if(!existing||existing.attempts>=5)return false;
  await db.collection<Challenge>('challenges').updateOne({_id:existing._id},{$inc:{attempts:1}});
  const expected=await otpDigest(code+':'+purpose+':'+account._id,cfg().OTP_SECRET!);
  if(!safeEqual(expected,existing.tokenHash))return false;
  const result=await db.collection<Challenge>('challenges').updateOne({_id:existing._id,claimedAt:null,expiresAt:{$gt:new Date()},attempts:{$lte:5}},{$set:{claimedAt:millis()}});
  return result.modifiedCount===1;
}
auth.get('/api/me', async(req,res)=>{
  try{const account=await withMongo(db=>signedIn(req,db));res.set('Cache-Control','no-store').json({account:publicAccount(account)});}
  catch{reject(res,503,'Account service temporarily unavailable.');}
});
auth.post('/api/auth/register',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  const body=authBody(req), email=normalizedEmail(body.email), displayName=normalizedString(body.displayName,32),
    password=typeof body.password==='string'?body.password:'', dob=body.dob;
  if(!validateEmail(email))return reject(res,400,'Please use a valid email.');
  if(displayName.length<2||/[<>\x00-\x1f]/.test(displayName))return reject(res,400,'Display name must be 2–32 characters.');
  if(password.length<10||password.length>128)return reject(res,400,'Password must be 10–128 characters.');
  if(!isAdult(dob))return reject(res,400,'You must provide a valid date of birth and be at least 18.');
  try{await withMongo(async db=>{
    if(!await requestLimited(db,ipOf(req),'register',4))return reject(res,429,'Too many registration attempts.');
    const salt=token(16),hash=await passwordDigest(password,salt),t=millis();
    const account:WebAccount={_id:crypto.randomUUID(),email,displayName,bio:'',dob,avatarData:'',
      passwordSalt:salt,passwordHash:hash,emailVerifiedAt:null,whatsappId:null,createdAt:t,updatedAt:t};
    try{await db.collection<WebAccount>('accounts').insertOne(account);}
    catch(err){if((err as {code?:number}).code===11000)return reject(res,409,'An account with this email already exists.');throw err}
    await startSession(res,db,account);
    res.status(201).set('Cache-Control','no-store').json({account:publicAccount(account)});
  });}catch{if(!res.headersSent)reject(res,503,'Account service temporarily unavailable.');}
});
auth.post('/api/auth/login',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  const b=authBody(req),email=normalizedEmail(b.email),password=typeof b.password==='string'?b.password:'';
  if(!validateEmail(email)||!password||password.length>128)return reject(res,400,'Invalid credentials.');
  try{await withMongo(async db=>{
    if(!await requestLimited(db,ipOf(req),'login',12))return reject(res,429,'Too many login attempts.');
    const a=await db.collection<WebAccount>('accounts').findOne({email});
    const calculated=await passwordDigest(password,a?.passwordSalt||'00000000000000000000000000000000');
    if(!a||!safeEqual(calculated,a.passwordHash))return reject(res,401,'Invalid email or password.');
    await startSession(res,db,a);
    res.set('Cache-Control','no-store').json({account:publicAccount(a)});
  });}catch{if(!res.headersSent)reject(res,503,'Login service temporarily unavailable.');}
});
auth.post('/api/auth/logout',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  try{await withMongo(async db=>{const c=cookieValue(req);if(c)await db.collection<Session>('sessions').deleteOne({_id:await digest(c)});});
    setSessionCookie(res,'',0);res.set('Cache-Control','no-store').json({ok:true});
  }catch{reject(res,503,'Unable to sign out.');}
});
auth.post('/api/profile',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  const b=authBody(req),displayName=normalizedString(b.displayName,32),bio=normalizedString(b.bio,160),
    avatar=typeof b.avatarData==='string'?b.avatarData:'',dob=b.dob;
  if(displayName.length<2||/[<>\x00-\x1f]/.test(displayName))return reject(res,400,'Invalid display name.');
  if(bio.length>160||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(bio))return reject(res,400,'Invalid bio.');
  if(!isAdult(dob))return reject(res,400,'Date of birth must be valid (18+).');
  if(avatar.length>120000||(avatar&&!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(avatar)))return reject(res,400,'Invalid avatar.');
  try{await withMongo(async db=>{
    const a=await signedIn(req,db);if(!a)return reject(res,401,'Please sign in.');
    if(!await requestLimited(db,ipOf(req),'profile:'+a._id,25))return reject(res,429,'Too many updates.');
    const update={displayName,bio,avatarData:avatar,dob,updatedAt:millis()};
    await db.collection<WebAccount>('accounts').updateOne({_id:a._id},{$set:update});
    res.set('Cache-Control','no-store').json({account:publicAccount({...a,...update}),whatsappSynced:false});
  });}catch{if(!res.headersSent)reject(res,503,'Unable to update profile.');}
});
auth.post('/api/auth/email/send',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  if(!settingsReady())return reject(res,503,'Email verification is not configured yet.');
  try{await withMongo(async db=>{
    const a=await signedIn(req,db);if(!a)return reject(res,401,'Please sign in.');
    if(a.emailVerifiedAt)return res.json({ok:true,alreadyVerified:true});
    if(!await requestLimited(db,ipOf(req),'verify-email:'+a._id,4))return reject(res,429,'Too many requests.');
    const code=await createChallenge(db,a,'verify-email');
    try{await sendEmail(a.email,'Verify your AniChan email','Your AniChan verification code is '+code+'. It expires in 10 minutes.');}
    catch{await db.collection<Challenge>('challenges').deleteMany({accountId:a._id,purpose:'verify-email'});return reject(res,503,'Unable to send verification email.');}
    res.json({ok:true});
  });}catch{if(!res.headersSent)reject(res,503,'Email service unavailable.');}
});
auth.post('/api/auth/email/confirm',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  if(!settingsReady())return reject(res,503,'Email verification is not configured yet.');
  try{await withMongo(async db=>{
    const a=await signedIn(req,db);if(!a)return reject(res,401,'Please sign in.');
    if(!await requestLimited(db,ipOf(req),'verify-email-confirm:'+a._id,8))return reject(res,429,'Too many attempts.');
    if(!await claimEmailChallenge(db,a,'verify-email',authBody(req).code))return reject(res,400,'Code incorrect or expired.');
    await db.collection<WebAccount>('accounts').updateOne({_id:a._id},{$set:{emailVerifiedAt:millis()}});
    res.json({ok:true});
  });}catch{if(!res.headersSent)reject(res,503,'Email service unavailable.');}
});
auth.post('/api/auth/reset/send',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  if(!settingsReady())return reject(res,503,'Password recovery is not configured yet.');
  const email=normalizedEmail(authBody(req).email);
  if(!validateEmail(email))return reject(res,400,'Enter a valid email address.');
  try{await withMongo(async db=>{
    if(!await requestLimited(db,ipOf(req),'reset-send',4))return reject(res,429,'Too many requests.');
    const a=await db.collection<WebAccount>('accounts').findOne({email,emailVerifiedAt:{$ne:null}});
    if(a){const code=await createChallenge(db,a,'reset-password');
      await sendEmail(a.email,'AniChan password recovery','Your AniChan recovery code is '+code+'. It expires in 10 minutes.').catch(()=>undefined);}
    res.json({ok:true,message:'If a verified account exists, a recovery code has been sent.'});
  });}catch{if(!res.headersSent)reject(res,503,'Password recovery temporarily unavailable.');}
});
auth.post('/api/auth/reset/confirm',async(req,res)=>{
  if(!originAllowed(req))return reject(res,403,'Invalid request origin.');
  if(!settingsReady())return reject(res,503,'Password recovery is not configured yet.');
  const b=authBody(req),email=normalizedEmail(b.email),pw=typeof b.password==='string'?b.password:'';
  if(!validateEmail(email)||pw.length<10||pw.length>128)return reject(res,400,'Invalid recovery request.');
  try{await withMongo(async db=>{
    if(!await requestLimited(db,ipOf(req),'reset-confirm',8))return reject(res,429,'Too many attempts.');
    const a=await db.collection<WebAccount>('accounts').findOne({email,emailVerifiedAt:{$ne:null}});
    if(!a||!await claimEmailChallenge(db,a,'reset-password',b.code))return reject(res,400,'Invalid or expired recovery code.');
    const salt=token(16),hash=await passwordDigest(pw,salt);
    await db.collection<WebAccount>('accounts').updateOne({_id:a._id},{$set:{passwordSalt:salt,passwordHash:hash,updatedAt:millis()}});
    await db.collection<Session>('sessions').deleteMany({accountId:a._id});
    res.json({ok:true});
  });}catch{if(!res.headersSent)reject(res,503,'Password recovery unavailable.');}
});
