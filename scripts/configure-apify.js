#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { Writable } = require('node:stream');

// Configure on the phone, never through chat. Replace only the token setting
// and keep all other .env settings; an atomic rename avoids partial writes.
function saveToken(value, envPath = path.join(__dirname, '..', '.env')) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 4096) throw new Error('Enter a valid Apify API token without quotes or spaces.');
  if (!fs.lstatSync(envPath).isFile()) throw new Error('The existing .env must be a regular file.');
  const original = fs.readFileSync(envPath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let found = false;
  let updated = original.replace(/^[ \t]*(?:export[ \t]+)?APIFY_TOKEN[ \t]*=.*(?:\r?\n|$)/gm, () => {
    if (found) return '';
    found = true;
    return `APIFY_TOKEN=${token}${newline}`;
  });
  if (!found) updated += `${updated && !updated.endsWith('\n') ? newline : ''}APIFY_TOKEN=${token}${newline}`;
  const temporary = `${envPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, updated, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, envPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

async function readToken() {
  if (!process.stdin.isTTY) {
    let token = '';
    for await (const chunk of process.stdin) {
      token += chunk;
      if (token.length > 4096) throw new Error('Token input is too long.');
    }
    return token;
  }
  // Readline owns raw mode and cleanup, while a muted output stream prevents
  // echoing the secret (including when backspace or paste is used in Termux).
  const muted = new Writable({ write(chunk, encoding, done) { done(); } });
  const reader = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write('Apify API token (hidden): ');
  try {
    return await new Promise((resolve, reject) => {
      reader.on('SIGINT', () => { reader.close(); reject(new Error('Cancelled; no settings changed.')); });
      reader.on('close', () => reject(new Error('No token entered; no settings changed.')));
      reader.question('', resolve);
    });
  } finally {
    reader.close();
    process.stdout.write('\n');
  }
}

async function main() {
  const token = await readToken();
  saveToken(token);
  console.log('✅ APIFY_TOKEN saved to .env. Other settings preserved.');
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.code ? `❌ Could not update the existing .env (${err.code}). No token was printed.` : `❌ ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { saveToken };
