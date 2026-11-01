// Cloudflare Pages advanced Worker packaging for the staged Express backend.
// Wrangler's dry-run bundle is rebuilt by Pages. Prefix all bare Node builtin
// imports so the second bundler resolves the nodejs_compat polyfills.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
const nodeBuiltins=new Set(builtinModules.map(x=>x.replace(/^node:/,'')));
const dir='dist';
mkdirSync(dir,{recursive:true});
const path=dir+'/index.js';
let contents=readFileSync(path,'utf8');
const target=contents.replace(/\b(from|import\(|require\()\s*(['"])([^'"]+)\2/g,
 (whole,start,q,name)=>nodeBuiltins.has(name)?start+' '+q+'node:'+name+q:whole);
if(target===contents){
  console.log('No bare Node builtins found; retaining original bundle.');
}
writeFileSync(dir+'/_worker.js',target);
writeFileSync(dir+'/index.html','<!doctype html><meta charset="utf-8"><title>AniChan API staging</title><h1>AniChan API staging</h1><p>Health: /api/health</p>');
