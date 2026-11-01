'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const vm=require('node:vm');

// Keep the website template pixel-for-pixel consistent with the approved
// whatsapp-web.js email template; no email is sent during this test.
const original=require(path.resolve(__dirname,'../../utils/emailTemplate.js'));
const input=fs.readFileSync(path.join(__dirname,'src/emailTemplate.ts'),'utf8');
const output=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const mod={exports:{}};
vm.runInNewContext(output,{module:mod,exports:mod.exports,require,Buffer,console},{filename:'emailTemplate.ts'});
const staged=mod.exports;
for(const hasHeader of [false,true]){
 for(const hasAvatar of [false,true]){
  const opts={code:'123456',purpose:'email_verification',ttlMinutes:10,
    brandName:'AniChan',hasHeader,hasAvatar};
  const baseline=original.buildVerificationEmail(opts);
  const current=staged.buildVerificationEmail(opts);
  assert.equal(current.html,baseline.html,'Verification HTML layout must match original');
  assert.equal(current.text,baseline.text,'Fallback plain text must match original');
  assert.equal(current.subject,baseline.subject,'Subject must match original');
  if(hasHeader)assert.ok(current.html.includes('cid:anichan-header'));
  if(hasAvatar)assert.ok(current.html.includes('cid:anichan-avatar'));
 }
}
const reset=staged.buildVerificationEmail({code:'654321',purpose:'password_reset',hasHeader:true,hasAvatar:true});
assert.ok(reset.html.includes('Password Recovery Code'));
assert.ok(reset.html.includes('cid:anichan-header'));
assert.ok(reset.html.includes('cid:anichan-avatar'));
assert.ok(reset.html.includes('654321'));
assert.ok(!reset.html.includes('123456'));
console.log('PASS: staged verification emails precisely match original AniChan HTML and text across all image configurations');
console.log('PASS: password recovery retains AniChan HTML template and CID image references');
