import { env } from 'cloudflare:workers';
import { MongoClient, type Db } from 'mongodb';
import { digest, millis } from './security';

export interface Environment {
  MONGODB_URI?: string;
  BOT_LINK_SECRET?: string;
  OTP_SECRET?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  WHATSAPP_LINK_ENABLED?: string;
}
export function cfg(): Environment { return env as unknown as Environment; }
export interface WebAccount {
  _id: string;
  email: string;
  displayName: string;
  bio: string;
  dob: string;
  avatarData: string;
  passwordSalt: string;
  passwordHash: string;
  emailVerifiedAt?: number | null;
  whatsappId?: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface Session {
  _id: string;
  accountId: string;
  expiresAt: Date;
}
export interface Challenge {
  _id: string;
  accountId: string;
  purpose: 'whatsapp-link'|'verify-email'|'reset-password';
  tokenHash: string;
  attempts: number;
  expiresAt: Date;
  claimedAt?: number | null;
}
let indexInit: Promise<void> | null = null;
async function ensureSiteIndexes(db: Db): Promise<void> {
  if (!indexInit) {
    indexInit = Promise.all([
      db.collection<WebAccount>('accounts').createIndex({email:1},{unique:true}),
      db.collection<WebAccount>('accounts').createIndex(
        {whatsappId:1},{unique:true,partialFilterExpression:{whatsappId:{$type:'string'}}}
      ),
      db.collection<Session>('sessions').createIndex({expiresAt:1},{expireAfterSeconds:0}),
      db.collection<Challenge>('challenges').createIndex({expiresAt:1},{expireAfterSeconds:0}),
      db.collection('rateLimits').createIndex({expiresAt:1},{expireAfterSeconds:0})
    ]).then(()=>undefined).catch(err=>{indexInit=null;throw err});
  }
  await indexInit;
}
export async function withMongo<T>(fn: (db: Db, client: MongoClient) => Promise<T>): Promise<T> {
  const uri = cfg().MONGODB_URI;
  if (!uri) throw new Error('Database not configured');
  const client = new MongoClient(uri, {
    maxPoolSize: 1, minPoolSize: 0, connectTimeoutMS: 4500,
    serverSelectionTimeoutMS: 4500, maxIdleTimeMS: 10_000
  });
  try {
    await client.connect();
    const db = client.db('anichan_site');
    await ensureSiteIndexes(db);
    return await fn(db,client);
  } finally { await client.close().catch(()=>undefined); }
}
export async function requestLimited(db: Db, ip: string, label: string, max: number): Promise<boolean> {
  const key = await digest(label + ':' + ip);
  const windowStart = Math.floor(millis() / 900_000) * 900_000;
  const entry = await db.collection<{_id:string; count:number; expiresAt:Date}>('rateLimits')
    .findOneAndUpdate({_id:key+':'+windowStart},{$inc:{count:1},$setOnInsert:{expiresAt:new Date(windowStart+1800000)}},
    {upsert:true,returnDocument:'after'});
  return (entry?.count||0) <= max;
}
export function publicAccount(a: WebAccount | null) {
  return a ? {id:a._id,email:a.email,displayName:a.displayName,bio:a.bio,dob:a.dob,
    avatarData:a.avatarData,linked:Boolean(a.whatsappId),emailVerified:Boolean(a.emailVerifiedAt)} : null;
}
