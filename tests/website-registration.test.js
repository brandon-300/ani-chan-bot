'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const code=fs.readFileSync(path.join(__dirname,'../utils/websiteRegistration.js'),'utf8');
const SITE_ID='d67106d2-79d1-4b07-aeba-bc9db8963697';
const SITE_PROFILE={siteId:SITE_ID,displayName:'Verified Website User',bio:'Anime',dob:'2002-09-20',avatarData:''};
const WA='2348000000000@c.us';
function sender(jid=WA){return {getContact:async()=>({id:{_serialized:jid}})}}
function setup({active=true,users=[],linkedProfile=null,siteUrl='https://anichan-api-stage.pages.dev'}={}){
 const writes=[],requests=[];
 const User={
  find(q){return{select(){return{lean:async()=>users.filter(u=>q.id.$in.includes(u.id))}}}},
  findOne(q){return{select(){return{lean:async()=>users.find(u=>u.websiteAccountId===q.websiteAccountId)||null}}}},
  async findOneAndUpdate(q,u,options){writes.push({q,u,options});return {id:q.id}}
 };
 const mod={exports:{}},secret='s'.repeat(64);
 const env={ANICHAN_SITE_URL:siteUrl,ANICHAN_SITE_BOT_SECRET:secret,ANICHAN_REG_LINK_ENABLED:active?'true':'false'};
 const fn=vm.runInNewContext('(function(require,module,process,fetch,URL,AbortSignal,Buffer){'+code+'\n})',{console});
 fn(n=>n==='../models/User'?User:n==='./cloudinary'?{isCloudConfigured:()=>false}:n==='node:crypto'?crypto:require(n),
  mod,{env},async(url,opts)=>{
   requests.push({url,opts});
   const body=url.includes('/handoff')?
    {ticket:'f'.repeat(64),expiresInSeconds:900}:
    {account:linkedProfile};
   return {ok:true,json:async()=>body};
  },URL,AbortSignal,Buffer);
 return {api:mod.exports,writes,requests};
}
test('.reg handoff sends a private website URL fragment, never chat verification code',async()=>{
 const h=setup();const result=await h.api.createWebsiteHandoff(sender());
 assert.equal(result.alreadyLinked,false);
 assert.equal(result.url,'https://anichan-api-stage.pages.dev/register#wa='+'f'.repeat(64));
 assert.equal(result.expiresInSeconds,900);
 assert.equal(h.requests.length,1);
 assert.ok(h.requests[0].url.endsWith('/api/internal/handoff'));
 assert.equal(JSON.parse(h.requests[0].opts.body).whatsappId,'2348000000000@s.whatsapp.net');
 assert.equal(h.writes.length,0);
 assert.equal(h.api.claimWebsiteCode,undefined);
});
test('a linked account does not require another .reg or handoff',async()=>{
 const h=setup({users:[{id:WA,websiteAccountId:SITE_ID}]});
 const result=await h.api.createWebsiteHandoff(sender());
 assert.equal(result.alreadyLinked,true);
 assert.equal(h.requests.length,0);
});
test('ambiguous legacy identifiers are rejected before link issuance',async()=>{
 const h=setup({users:[{id:WA},{id:'2348000000000@s.whatsapp.net'}]});
 await assert.rejects(()=>h.api.createWebsiteHandoff(sender()),/Multiple legacy accounts/);
 assert.equal(h.requests.length,0);
});
test('unknown WhatsApp LIDs cannot claim another person’s account',async()=>{
 const h=setup();
 await assert.rejects(()=>h.api.createWebsiteHandoff(sender('123@lid')),/identity/);
 assert.equal(h.requests.length,0);
});
test('returning from website automatically restores a linked gameplay account',async()=>{
 const saved={id:WA,coins:877,bank:5500,cards:['a'],guildId:'myguild',websiteAccountId:null};
 const h=setup({users:[saved],linkedProfile:SITE_PROFILE});
 const outcome=await h.api.restoreLinkedProfile(sender());
 assert.equal(outcome.existing,true);
 assert.equal(h.requests.length,1);
 assert.ok(h.requests[0].url.includes('/api/internal/profile?waid='));
 assert.equal(h.writes.length,1);
 assert.equal(h.writes[0].q.id,WA);
 assert.equal(h.writes[0].options.upsert,false);
 assert.equal(h.writes[0].u.$set.websiteAccountId,SITE_ID);
 assert.equal(h.writes[0].u.$set['registration.status'],'active');
 for(const key of ['coins','bank','orbs','cards','guildId','inventory','loans','xp','email','emailVerifiedAt','sessionLockedAt']){
   assert.ok(!(key in h.writes[0].u.$set),'Must preserve '+key);
 }
});
test('a brand new verified website user is activated on their next message',async()=>{
 const h=setup({linkedProfile:SITE_PROFILE});
 const x=await h.api.restoreLinkedProfile(sender());
 assert.equal(x.existing,false);
 assert.equal(h.writes[0].options.upsert,true);
 assert.equal(h.writes[0].u.$setOnInsert.id,WA);
});
test('legacy accounts already connected to a different website cannot be overwritten',async()=>{
 const h=setup({users:[{id:WA,websiteAccountId:'someone-else'}],linkedProfile:SITE_PROFILE});
 await assert.rejects(()=>h.api.restoreLinkedProfile(sender()),/different website login/);
 assert.equal(h.writes.length,0);
});
test('feature switch protects running production bot',async()=>{
 const h=setup({active:false,linkedProfile:SITE_PROFILE});
 assert.equal(h.api.websiteRegistrationActive(),false);
 assert.equal(await h.api.restoreLinkedProfile(sender()),null);
 await assert.rejects(()=>h.api.createWebsiteHandoff(sender()),/not enabled/);
 assert.equal(h.requests.length,0);
 assert.equal(h.writes.length,0);
});
test('bot registration URLs respect configured staging site',()=>{
 const h=setup();const v=h.api.websiteRegistrationLinks();
 assert.deepEqual(JSON.parse(JSON.stringify(v)),{
  register:'https://anichan-api-stage.pages.dev/register',
  login:'https://anichan-api-stage.pages.dev/login'
 });
});
test('first bot interaction can automatically reconcile website identity',()=>{
 const index=fs.readFileSync(path.join(__dirname,'../index.js'),'utf8');
 assert.match(index,/if \(!wasActive && command !== 'reg'\)/);
 assert.match(index,/restoreLinkedProfile\(msg\)/);
 assert.match(index,/return \{blocked:false,senderId:restored.userId,wasActive:true,user\}/);
});
