// Real, disposable staging signup/login/profile/logout integration test.
// No real email address, Gmail delivery, game record or production API is touched.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
const base='https://anichan-api-stage.pages.dev';
const qaId=Date.now()+'-'+randomInt(100000,1000000);
const qaEmail='ani-qa-smoke-'+qaId+'@example.invalid';
const qaPassword=randomBytes(24).toString('base64url');
const qaName='AniChan Staging QA';
const request=async(path,{method='GET',body,cookie}={})=>{
  const headers={Accept:'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(cookie)headers.Cookie=cookie;
  const r=await fetch(base+path,{method,headers,
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const payload=await r.json().catch(()=>null);
  return {status:r.status,payload,cookie:r.headers.get('set-cookie')?.split(';')[0],phase:r.headers.get('x-anichan-qa-phase')};
};
let result=await request('/api/auth/register',{method:'POST',body:{
  displayName:qaName,email:qaEmail,password:qaPassword,dob:'2001-03-21'
}});
if(result.status!==201)console.error('Staging registration failed:',{status:result.status,phase:result.phase});
assert.equal(result.status,201,'Website registration should succeed');
assert.equal(result.payload?.account?.email,qaEmail,'Email stored correctly');
assert.ok(result.cookie?.startsWith('anichan_session='),'Session cookie required');
assert.equal(result.payload?.account?.linked,false);
console.log('Disposable staging signup succeeded:',qaEmail);
const registeredCookie=result.cookie;
result=await request('/api/me',{cookie:registeredCookie});
assert.equal(result.status,200);
assert.equal(result.payload?.account?.email,qaEmail);
console.log('Authenticated profile session lookup succeeded');
result=await request('/api/profile',{method:'POST',cookie:registeredCookie,
  body:{displayName:'AniChan QA Updated',bio:'Isolated integration test',dob:'2001-03-21',avatarData:''}});
assert.equal(result.status,200,'Profile update must succeed');
assert.equal(result.payload?.account?.displayName,'AniChan QA Updated');
console.log('Staging profile update succeeded');
result=await request('/api/auth/logout',{method:'POST',cookie:registeredCookie,body:{}});
assert.equal(result.status,200,'Logout must succeed');
result=await request('/api/me',{cookie:registeredCookie});
assert.equal(result.status,200);
assert.equal(result.payload?.account,null,'Logged-out session must be revoked');
console.log('Logout revoked prior cookie');
result=await request('/api/auth/login',{method:'POST',body:{email:qaEmail,password:qaPassword}});
assert.equal(result.status,200,'Login must succeed');
assert.equal(result.payload?.account?.displayName,'AniChan QA Updated');
assert.ok(result.cookie?.startsWith('anichan_session='),'Login session cookie required');
console.log('Staging login with existing credentials succeeded');
console.log('TEST COMPLETE. Remove disposable staging account and its sessions:',qaEmail);
// The QA email is an @example.invalid address, so no outbound email was sent.
