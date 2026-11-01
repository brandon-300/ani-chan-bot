'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

const code=fs.readFileSync(path.join(__dirname,'../utils/websiteRegistration.js'),'utf8');
const SITE_ID='d67106d2-79d1-4b07-aeba-bc9db8963697';
const sample={siteId:SITE_ID,displayName:'New Nickname',bio:'Anime fan',dob:'2002-09-20',avatarData:''};
const sender=(jid='2348000000000@c.us')=>({getContact:async()=>({id:{_serialized:jid}})});
function harness({enabled=true,users=[],profile=sample}={}){
  const writes=[],requests=[];
  const User={
    find(query){return{select(){return{lean:async()=>users.filter(u=>query.id.$in.includes(u.id))}}}},
    findOne(query){return{select(){return{lean:async()=>users.find(u=>u.websiteAccountId===query.websiteAccountId)||null}}}},
    async findOneAndUpdate(query,update,options){writes.push({query,update,options});return {...query,...update.$set}}
  };
  const mod={exports:{}};
  const crypto=require('node:crypto');
  const env={ANICHAN_SITE_URL:'https://anichan.pages.dev',
    ANICHAN_SITE_BOT_SECRET:'a'.repeat(64),ANICHAN_REG_LINK_ENABLED:enabled?'true':'false'};
  vm.runInNewContext('(function(require,module,process,fetch,URL,AbortSignal,Buffer){'+code+'\n})',
    {console})(n=>n==='../models/User'?User:n==='./cloudinary'?{
      isCloudConfigured:()=>false,
      uploadBufferToCloud:async()=>{throw Error('Cloudinary should be off')}
    }:n==='node:crypto'?crypto:require(n),mod,{env},async(url,opts)=>{
      requests.push({url,opts});
      return {ok:true,json:async()=>url.includes('claim-link')?profile:{account:profile}};
    },URL,AbortSignal,Buffer);
  // Execute CJS body: vm.runInNewContext returned the function but it must be called.
  return {mod,writes,requests};
}
function instance(settings={}){
  const ctx=harness(settings);
  // module.exports is assigned when the wrapper executes
  return ctx;
}

test('existing user keeps original ID and economic values',async()=>{
  const saved={id:'2348000000000@c.us',coins:888,bank:123,orbs:10,cards:['card1'],guildId:'guild1'};
  const {mod,writes,requests}=instance({users:[saved]});
  const result=await mod.exports.claimWebsiteCode(sender(),'12345678');
  assert.equal(result.existing,true);
  assert.equal(writes.length,1);
  assert.equal(writes[0].query.id,saved.id);
  assert.equal(writes[0].update.$set.websiteAccountId,SITE_ID);
  for(const key of ['coins','bank','orbs','cards','guildId','inventory','xp','level']){
    assert.ok(!(key in writes[0].update.$set),key+' must remain unchanged');
  }
  assert.equal(requests[0].opts.method,'POST');
  assert.equal(requests[0].opts.headers.Authorization,'Bearer '+'a'.repeat(64));
});
test('no DB writes when feature is disabled',async()=>{
  const h=instance({enabled:false});
  await assert.rejects(()=>h.mod.exports.claimWebsiteCode(sender(),'12345678'),/not enabled/);
  assert.equal(h.writes.length,0);
});
test('unknown LID is rejected safely',async()=>{
  const h=instance();
  await assert.rejects(()=>h.mod.exports.claimWebsiteCode(sender('12345@lid'),'12345678'),/identity/);
  assert.equal(h.writes.length,0);
});
test('new web user can create one linked gameplay record',async()=>{
  const h=instance();
  const result=await h.mod.exports.claimWebsiteCode(sender(),'12345678');
  assert.equal(result.existing,false);
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].update.$set['registration.status'],'active');
});
test('multiple legacy accounts are not merged',async()=>{
  const h=instance({users:[{id:'2348000000000@c.us'},{id:'2348000000000@s.whatsapp.net'}]});
  await assert.rejects(()=>h.mod.exports.claimWebsiteCode(sender(),'12345678'),/Multiple legacy accounts/);
  assert.equal(h.writes.length,0);
});
test('a different web account cannot overwrite an existing link',async()=>{
  const h=instance({users:[{id:'2348000000000@c.us',websiteAccountId:'another-id'}]});
  await assert.rejects(()=>h.mod.exports.claimWebsiteCode(sender(),'12345678'),/different website login/);
  assert.equal(h.writes.length,0);
});

