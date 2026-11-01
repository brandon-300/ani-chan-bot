'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const assert=require('node:assert/strict');

const CODE='12345678', SITE='d67106d2-79d1-4b07-aeba-bc9db8963697';
const WA='2348000000000@s.whatsapp.net';
const env={BOT_LINK_SECRET:'a'.repeat(64),WHATSAPP_LINK_ENABLED:'true'};
const profile={_id:SITE,emailVerifiedAt:1730000000,whatsappId:null,displayName:'AniChan Tester',
  bio:'Anime lover',dob:'2002-03-04',avatarData:'',updatedAt:1730000001};
let activeAccount={...profile};
let challenge={_id:'challenge',accountId:SITE,purpose:'whatsapp-link',tokenHash:'otp-'+CODE,
  claimedAt:null,attempts:0,expiresAt:new Date(Date.now()+600000)};
const stats={reads:0,updates:0,challengeWrites:0};
function matches(doc,q){
  if(!doc)return false;
  return Object.entries(q).every(([k,v])=>{
    if(k==='$or')return v.some(x=>matches(doc,x));
    if(v && typeof v==='object' && !Array.isArray(v) && !(v instanceof Date)){
      if('$gt' in v)return new Date(doc[k]).getTime()>new Date(v.$gt).getTime();
      if('$lt' in v)return doc[k]<v.$lt;
      if('$ne' in v)return doc[k]!==v.$ne;
    }
    return doc[k]===v;
  });
}
const db={
  collection(name){
    if(name==='accounts')return{
      findOne:async q=>{stats.reads++;return matches(activeAccount,q)?{...activeAccount}:null;},
      updateOne:async(q,u)=>{
        if(!matches(activeAccount,q))return {matchedCount:0};
        activeAccount={...activeAccount,...u.$set};stats.updates++;
        return {matchedCount:1,modifiedCount:1};
      }
    };
    if(name==='challenges')return {
      findOne:async q=>matches(challenge,q)?{...challenge}:null,
      findOneAndUpdate:async(q,u)=>{
        if(!matches(challenge,q))return null;
        challenge={...challenge,...u.$set};stats.challengeWrites++;return {...challenge};
      }
    };
    return {};
  }
};
const routes={get:{},post:{}};
const mockExpress={Router:()=>({
  get(path,fn){routes.get[path]=fn},
  post(path,fn){routes.post[path]=fn}
})};
const mocks={
  'express':mockExpress,
  './auth':{signedIn:async()=>({...activeAccount})},
  './mongo':{cfg:()=>env,withMongo:async fn=>fn(db),requestLimited:async()=>true},
  './security':{
    bearer:req=>(req.headers.authorization||'').replace(/^Bearer /,''),
    safeEqual:(a,b)=>a===b,
    waid:s=>typeof s==='string'&&/^\d{7,17}@s\.whatsapp\.net$/.test(s),
    originAllowed:()=>true,
    otpDigest:async code=>'otp-'+code,
    millis:()=>Date.now(),pin:()=>CODE,token:()=> 'fake-token'
  }
};
const source=fs.readFileSync(path.join(__dirname,'src/bot.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true
}}).outputText;
const module={exports:{}};
vm.runInNewContext(compiled,{exports:module.exports,module,require:name=>{
  if(!(name in mocks))throw Error('Unexpected dependency '+name);
  return mocks[name];
},console,Date},{filename:'bot.js'});
function response(){
  return {
    code:200,body:null,headers:{},
    status(n){this.code=n;return this},
    set(a,b){this.headers[a]=b;return this},
    json(payload){this.body=payload;return this}
  };
}
async function request(route,{body={},bearer=true}={}){
  const req={body,query:{},headers:{authorization:bearer?'Bearer '+env.BOT_LINK_SECRET:''},
    get(k){return this.headers[k.toLowerCase()]||''}};
  const res=response();
  const handler=routes.post[route] || routes.get[route];
  assert.ok(handler,'Missing handler '+route);
  await handler(req,res);return res;
}
async function run(){
  let r=await request('/api/internal/inspect-link',{bearer:false,body:{whatsappId:WA,code:CODE}});
  assert.equal(r.code,403,'Bearer secret required');
  r=await request('/api/internal/inspect-link',{body:{whatsappId:WA,code:CODE}});
  assert.equal(r.code,200,'Valid code should inspect');
  assert.equal(r.body.account.siteId,SITE);
  assert.equal(challenge.claimedAt,null,'Preflight MUST NOT consume code');
  assert.equal(activeAccount.whatsappId,null,'Preflight MUST NOT link account');

  r=await request('/api/internal/claim-link',{body:{whatsappId:WA,code:CODE,siteId:'e3bb92a9-cc43-4ebd-9417-4637a26b18b2'}});
  assert.equal(r.code,409,'Wrong inspected website ID rejected');
  assert.equal(challenge.claimedAt,null,'Wrong site ID MUST NOT spend code');

  r=await request('/api/internal/claim-link',{body:{whatsappId:WA,code:CODE,siteId:SITE}});
  assert.equal(r.code,200,'Valid claim should succeed exactly once');
  assert.equal(r.body.siteId,SITE);
  assert.equal(activeAccount.whatsappId,WA);
  assert.ok(challenge.claimedAt,'Challenge consumed atomically');
  assert.equal(stats.challengeWrites,1);
  assert.equal(stats.updates,1);

  r=await request('/api/internal/claim-link',{body:{whatsappId:WA,code:CODE,siteId:SITE}});
  assert.equal(r.code,400,'Reusing consumed challenge must fail');
  assert.equal(stats.updates,1);

  challenge={...challenge,claimedAt:null,expiresAt:new Date(Date.now()-1000)};
  r=await request('/api/internal/inspect-link',{body:{whatsappId:WA,code:CODE}});
  assert.equal(r.code,400,'Expired code rejected');

  challenge={...challenge,claimedAt:null,expiresAt:new Date(Date.now()+600000)};
  r=await request('/api/internal/inspect-link',{body:{whatsappId:'2348000000001@s.whatsapp.net',code:CODE}});
  assert.equal(r.code,409,'Website account cannot be linked to two WhatsApp identities');
  assert.equal(stats.updates,1);

  env.WHATSAPP_LINK_ENABLED='false';
  r=await request('/api/internal/inspect-link',{body:{whatsappId:WA,code:CODE}});
  assert.equal(r.code,503,'Linking gate prevents unauthorised rollout');
  console.log('PASS: secret verification, read-only inspection, site-ID match, atomic one-time code, replay and expiry rejection, identity collisions, disabled feature gate');
}
run().catch(e=>{console.error(e);process.exitCode=1});
