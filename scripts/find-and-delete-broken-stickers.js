#!/usr/bin/env node
'use strict';

// Find AI sticker records whose stored Cloudinary URL returns HTTP 404.
// Safe by default: it only reports candidates. Deletion requires both
// --delete and --yes. Network errors and non-404 responses are never deleted.
require('dotenv').config();

const axios = require('axios');
const mongoose = require('mongoose');
const AiSticker = require('../models/AiSticker');

const args = new Set(process.argv.slice(2));
const DELETE = args.has('--delete');
const YES = args.has('--yes');
const limitArg = process.argv.find(value => value.startsWith('--limit='));
const limit = limitArg ? Math.max(1, Number.parseInt(limitArg.slice('--limit='.length), 10) || 1) : 0;
const timeoutArg = process.argv.find(value => value.startsWith('--timeout-ms='));
const timeoutMs = timeoutArg ? Math.max(1000, Number.parseInt(timeoutArg.slice('--timeout-ms='.length), 10) || 10000) : 10000;

function usage() {
  console.log(`Usage:
  node scripts/find-and-delete-broken-stickers.js
  node scripts/find-and-delete-broken-stickers.js --limit=100 --timeout-ms=10000
  node scripts/find-and-delete-broken-stickers.js --delete --yes

Default behavior is dry-run. Only records whose stored cloudinaryUrl returns HTTP 404
are deletion candidates. --delete --yes is required to remove them.
`);
}

function shortId(value) {
  return String(value || '').slice(-12);
}

async function checkUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { status: null, kind: 'invalid_url', error: 'missing or invalid URL' };
  }

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      maxContentLength: 4 * 1024 * 1024,
      maxBodyLength: 4 * 1024 * 1024,
      validateStatus: () => true,
    });
    response.data?.destroy?.();
    if (response.status === 404) return { status: 404, kind: 'not_found' };
    return { status: response.status, kind: response.status >= 200 && response.status < 300 ? 'ok' : 'http_error' };
  } catch (error) {
    return {
      status: error.response?.status || null,
      kind: 'request_error',
      error: error.code || error.message,
    };
  }
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    usage();
    return;
  }
  if (DELETE && !YES) {
    throw new Error('Refusing to delete without --yes. Run a dry-run first, then use --delete --yes after reviewing the list.');
  }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing from .env');

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 30000,
  });

  try {
    const query = AiSticker.find({}, {
      _id: 1,
      hash: 1,
      personaId: 1,
      cloudinaryUrl: 1,
      cloudinaryPublicId: 1,
    }).sort({ createdAt: 1 });
    if (limit) query.limit(limit);
    const records = await query.lean();

    console.log(`Checking ${records.length} sticker record(s)${limit ? ` (limit ${limit})` : ''}...`);
    const broken = [];
    let checked = 0;

    for (const record of records) {
      checked += 1;
      const result = await checkUrl(record.cloudinaryUrl);
      if (result.kind === 'not_found' || result.kind === 'invalid_url') {
        broken.push({ record, result });
        console.log(`[BROKEN] ${shortId(record._id)} hash=${String(record.hash || '').slice(0, 8)} persona=${record.personaId || 'unknown'} status=${result.status || 'invalid'} publicId=${record.cloudinaryPublicId || '(none)'}`);
      } else if (result.kind === 'request_error') {
        console.log(`[SKIP]   ${shortId(record._id)} hash=${String(record.hash || '').slice(0, 8)} request error=${result.error}`);
      }
      if (checked % 25 === 0) console.log(`Progress: ${checked}/${records.length}`);
    }

    console.log(`Found ${broken.length} deletion candidate(s) out of ${records.length}.`);
    if (!DELETE) {
      console.log('Dry-run only: no MongoDB records were deleted.');
      return;
    }

    const ids = broken.map(item => item.record._id);
    if (!ids.length) {
      console.log('Nothing to delete.');
      return;
    }
    const deletion = await AiSticker.deleteMany({ _id: { $in: ids } });
    console.log(`Deleted ${deletion.deletedCount || 0} broken sticker record(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async error => {
  console.error(`Cleanup failed: ${error.message}`);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
