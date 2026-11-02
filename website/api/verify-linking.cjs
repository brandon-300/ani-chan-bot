'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const ts=require('typescript');

const WA='2348000000000@s.whatsapp.net';
const SITE='d67106d2-79d1-4b07-aeba-bc9db8963697';
const secret='x'.repeat(64);
const env={BOT_LINK_SECRET:secret,WHATSAPP_LINK_ENABLED:'true'};
let user={_id:SITE,emailVerifiedAt:Date.now(),whatsappId:null,
 displayName:'Anime Lover',bio:'Testing',dob:'2001-01-01',avatarData:''};
let ticket=null;
let signedIn=true;
const calls={handoffWrites:0,accountUpdates:0,ticketClaims:0};
function matches(doc,filter){
 if(!doc)return false;
 return Object.entries(filter).every(([key,value])=>{
  if(key==='$or')return value.some(f=>matches(doc,f));
  if(value && typeof value==='object' && !(value instanceof Date)){
   if('$gt' in value)return new Date(doc[key]).getTime()>new Date(value.$gt).getTime();
  }
  return doc[key]===value;
 });
}
const db={collection(name){
 if(name==='accounts')return{
   findOne:async q=>matches(user,q)?{...user}:null,
   updateOne:async(q,u)=>{
    if(!matches(user,q))return {matchedCount:0};
    user={...user,...u.$set};calls.accountUpdates++;
    return {matchedCount:1,modifiedCount:1}
   }
 };
 if(name==='whatsappHandoffs')return{
  deleteMany:async()=>{ticket=null;return {deletedCount:1}},
  insertOne:async v=>{ticket={...v};calls.handoffWrites++;return {acknowledged:true}},
  findOne:async q=>matches(ticket,q)?{...ticket}:null,
  findOneAndUpdate:async(q,u)=>{
    if(!matches(ticket,q))return null;
    ticket={...ticket,...u.$set};calls.ticketClaims++;return {...ticket}
  }
 };
 return {};
}};
const routes={};
const mocks={
 express:{Router:()=>({
  get(route,fn){routes['GET '+route]=fn},
  post(route,fn){routes['POST '+route]=fn}
 })},
 './auth':{signedIn:async()=>signedIn?{...user}:null},
 './mongo':{cfg:()=>env,withMongo:async fn=>fn(db),requestLimited:async()=>true},
 './security':{
  bearer:req=>(req.headers.authorization||'').replace(/^Bearer /,''),
  digest:async value=>'digest:'+value,
  millis:()=>Date.now(),originAllowed:()=>true,
  safeEqual:(a,b)=>a===b,token:()=> 'f'.repeat(64),
  waid:x=>typeof x==='string' && /^\d{7,17}@s\.whatsapp\.net$/.test(x)
 }
};
const tsSource=fs.readFileSync(path.join(__dirname,'src/bot.ts'),'utf8');
const compiled=ts.transpileModule(tsSource,{compilerOptions:{
 target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true
}}).outputText;
const stage={exports:{}};
vm.runInNewContext(compiled,{module:stage,exports:stage.exports,require:n=>{
 if(n==='express')return {__esModule:true,default:mocks.express,...mocks.express};
 if(!(n in mocks))throw Error('Unmocked import '+n);
 return mocks[n];
},console,Date},{filename:'bot.js'});
function response(){
 return{statusCode:200,payload:null,headers:{},status(code){this.statusCode=code;return this},
 set(k,v){this.headers[k]=v;return this},json(body){this.payload=body;return this}};
}
async function request(method,route,{body={},auth=true}={}){
 const handler=routes[method+' '+route];assert.ok(handler,'Route missing '+method+' '+route);
 const req={body,query:{},headers:{authorization:auth?'Bearer '+secret:''},
  get(name){return this.headers[name.toLowerCase()]||''}};
 const res=response();await handler(req,res);return res;
}
async function run(){
 let r=await request('POST','/api/internal/handoff',{body:{whatsappId:WA},auth:false});
 assert.equal(r.statusCode,403,'Bot requests require the shared secret');
 env.WHATSAPP_LINK_ENABLED='false';
 r=await request('POST','/api/internal/handoff',{body:{whatsappId:WA}});
 assert.equal(r.statusCode,503,'Website linking stays off without activation');
 env.WHATSAPP_LINK_ENABLED='true';
 r=await request('POST','/api/internal/handoff',{body:{whatsappId:WA}});
 assert.equal(r.statusCode,200,'Bot can issue private URL ticket');
 assert.equal(r.payload.ticket,'f'.repeat(64));
 assert.equal(r.payload.expiresInSeconds,900);
 assert.equal(ticket.whatsappId,WA);
 assert.equal(user.whatsappId,null,'Issuing ticket never binds an account');
 const t=r.payload.ticket;
 signedIn=false;
 r=await request('POST','/api/link/complete',{body:{ticket:t}});
 assert.equal(r.statusCode,401,'Website must be logged in');
 assert.equal(ticket.claimedAt,null);
 signedIn=true;user.emailVerifiedAt=null;
 r=await request('POST','/api/link/complete',{body:{ticket:t}});
 assert.equal(r.statusCode,403,'Email must be verified inside website');
 assert.equal(ticket.claimedAt,null);
 user.emailVerifiedAt=Date.now();
 r=await request('POST','/api/link/complete',{body:{ticket:t}});
 assert.equal(r.statusCode,200,'Website-only linking completes');
 assert.equal(r.payload.linked,true);
 assert.equal(user.whatsappId,WA);
 assert.ok(ticket.claimedAt,'Ticket consumed only by verified web account');
 assert.equal(calls.ticketClaims,1);
 assert.equal(calls.accountUpdates,1);
 r=await request('POST','/api/link/complete',{body:{ticket:t}});
 assert.equal(r.statusCode,400,'Ticket replay must fail');
 assert.equal(calls.accountUpdates,1);
 // Verify a different WhatsApp number cannot steal an existing web login.
 ticket={...ticket,whatsappId:'2348000000001@s.whatsapp.net',claimedAt:null,expiresAt:new Date(Date.now()+600000)};
 r=await request('POST','/api/link/complete',{body:{ticket:t}});
 assert.equal(r.statusCode,409,'Cannot attach a different WhatsApp number to a linked account');
 assert.equal(calls.accountUpdates,1);
 console.log('PASS: .reg sends private website ticket; signup/login and email proof enforced exclusively in browser; replay, identity collision, auth and feature gates secure');
}
run().catch(e=>{console.error(e);process.exitCode=1});
