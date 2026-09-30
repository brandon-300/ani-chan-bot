#!/usr/bin/env node
'use strict';

// One-time, destructive reset of the shared AI sticker library.
//
//   node scripts/reset-ai-sticker-library.js                 dry run (default)
//   node scripts/reset-ai-sticker-library.js --delete --yes  real deletion
//
// Order of operations (chosen so a failure leaves a recoverable state):
//   1. Read Mongo (AiSticker, AiStickerMessage) and list Cloudinary assets.
//   2. Write a JSON backup of everything that is about to be removed.
//   3. Delete the Cloudinary assets and verify they are really gone.
//   4. Only then delete the Mongo records and verify the counts are zero.
// If step 3 fails, Mongo is untouched, so re-running the script simply resumes.
//
// The AiSticker model and code are NOT removed - only the data.

const path = require('node:path');
const fs = require('node:fs/promises');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
// utils/cloudinary configures the shared SDK singleton from either
// CLOUDINARY_URL or the three CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET vars,
// exactly like the running bot does. cloudinary.config() alone would NOT read
// the three separate vars.
const cloudinaryUtil = require('../utils/cloudinary');
const AiSticker = require('../models/AiSticker');
const AiStickerMessage = require('../models/AiStickerMessage');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_FOLDER = 'ai-stickers/shared';
const SAFE_ROOT = 'ai-stickers/';
const DELETE_BATCH = 100;

const argv = process.argv.slice(2);
const args = new Set(argv);
const shouldDelete = args.has('--delete');
const confirmed = args.has('--yes');

function argValue(name) {
  const hit = argv.find(arg => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

const folder = (argValue('--folder') || DEFAULT_FOLDER).replace(/^\/+|\/+$/g, '');
const folderPrefix = `${folder}/`;
const backupDir = path.resolve(argValue('--backup-dir') || path.join(PROJECT_ROOT, 'backups'));

function help() {
  console.log([
    'Usage:',
    '  node scripts/reset-ai-sticker-library.js                  # dry run, changes nothing',
    '  node scripts/reset-ai-sticker-library.js --delete --yes   # back up, then delete',
    '',
    'Options:',
    '  --delete             Perform the destructive deletion (dry run by default)',
    '  --yes                Required together with --delete',
    `  --folder=NAME        Cloudinary folder to clear (default: ${DEFAULT_FOLDER}; must be inside ai-stickers/)`,
    '  --backup-dir=DIR     Where the JSON backup is written (default: ./backups)',
    '',
    'Stop the bot first (pm2 stop ani-chan-bot) and start it again afterwards.',
  ].join('\n'));
}

function errMessage(err) {
  return String(err?.error?.message || err?.message || err || 'unknown error').slice(0, 300);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Termux connections drop; retry transient Cloudinary Admin API failures.
async function withRetry(label, fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        console.warn(`${label} failed (attempt ${attempt}/${attempts}): ${errMessage(err)} - retrying...`);
        await sleep(2000 * attempt);
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${errMessage(lastError)}`);
}

async function listCloudinaryAssets() {
  const assets = [];
  let nextCursor;
  do {
    const options = { type: 'upload', resource_type: 'image', prefix: folderPrefix, max_results: 500 };
    if (nextCursor) options.next_cursor = nextCursor;
    const result = await withRetry('Cloudinary list', () => cloudinary.api.resources(options));
    assets.push(...(result.resources || []));
    nextCursor = result.next_cursor;
  } while (nextCursor);
  return assets;
}

// Union of what Cloudinary reports under the prefix and what Mongo says it
// stored. Mongo's cloudinaryPublicId is authoritative even if the account uses
// dynamic folders. IDs outside ai-stickers/ are never deleted.
function collectPublicIds(assets, stickers) {
  const ids = new Set();
  for (const asset of assets) if (asset?.public_id) ids.add(asset.public_id);
  for (const sticker of stickers) {
    const id = String(sticker?.cloudinaryPublicId || '').trim();
    if (id && id.startsWith(SAFE_ROOT)) ids.add(id);
  }
  return [...ids].filter(id => id.startsWith(SAFE_ROOT));
}

async function deleteCloudinaryPublicIds(ids) {
  const failures = [];
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const batch = ids.slice(i, i + DELETE_BATCH);
    const result = await withRetry('Cloudinary delete', () => cloudinary.api.delete_resources(batch, {
      type: 'upload',
      resource_type: 'image',
      invalidate: true,
    }));
    for (const [publicId, status] of Object.entries(result?.deleted || {})) {
      if (status !== 'deleted' && status !== 'not_found') failures.push(`${publicId}: ${status}`);
    }
    console.log(`  Cloudinary delete progress: ${Math.min(i + DELETE_BATCH, ids.length)}/${ids.length}`);
  }
  if (failures.length) throw new Error(`Cloudinary refused to delete ${failures.length} asset(s), e.g. ${failures.slice(0, 3).join('; ')}`);

  try {
    await cloudinary.api.delete_folder(folder);
  } catch (err) {
    // Removing the (now empty) folder is cosmetic; the assets are what matter.
    console.warn(`Note: could not remove the empty Cloudinary folder "${folder}": ${errMessage(err)}`);
  }
}

async function countRemainingCloudinaryAssets(knownIds) {
  const byPrefix = await listCloudinaryAssets();
  let byId = 0;
  for (let i = 0; i < knownIds.length; i += DELETE_BATCH) {
    const chunk = knownIds.slice(i, i + DELETE_BATCH);
    const result = await withRetry('Cloudinary verify', () => cloudinary.api.resources_by_ids(chunk, { type: 'upload', resource_type: 'image' }));
    byId += (result?.resources || []).length;
  }
  return { byPrefix: byPrefix.length, byId };
}

async function verifyCloudinaryEmpty(knownIds) {
  let remaining = { byPrefix: -1, byId: -1 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    remaining = await countRemainingCloudinaryAssets(knownIds);
    if (remaining.byPrefix === 0 && remaining.byId === 0) return remaining;
    if (attempt < 3) await sleep(2500);
  }
  return remaining;
}

async function main() {
  if (args.has('--help') || args.has('-h')) return help();
  if (shouldDelete && !confirmed) throw new Error('Refusing to delete without --yes. Run the dry run first, then add --delete --yes.');
  if (!folder.startsWith(SAFE_ROOT) || folder.includes('..')) {
    throw new Error(`Refusing to touch folder "${folder}". Only folders inside "${SAFE_ROOT}" can be reset by this script.`);
  }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing from .env');
  if (!cloudinaryUtil.isCloudConfigured()) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET in .env');
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000, socketTimeoutMS: 30000 });
  try {
    const [stickers, attributions] = await Promise.all([
      AiSticker.find({}).lean(),
      AiStickerMessage.find({}).lean(),
    ]);
    const assets = await listCloudinaryAssets();
    const publicIds = collectPublicIds(assets, stickers);

    console.log(`Mongo AiSticker records:        ${stickers.length}`);
    console.log(`Mongo AiStickerMessage records: ${attributions.length}`);
    console.log(`Cloudinary assets under ${folder}: ${assets.length}`);
    console.log(`Cloudinary public IDs to delete: ${publicIds.length}`);

    if (!shouldDelete) {
      console.log('\nDry run only: nothing was backed up or deleted.');
      console.log('When ready: pm2 stop ani-chan-bot && node scripts/reset-ai-sticker-library.js --delete --yes');
      return;
    }

    await fs.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `ai-sticker-library-${Date.now()}.json`);
    await fs.writeFile(backupPath, JSON.stringify({
      exportedAt: new Date().toISOString(),
      folder,
      stickers,
      attributions,
      cloudinaryAssets: assets,
      publicIds,
    }, null, 2));
    console.log(`\nBackup written: ${backupPath}`);

    console.log('\nStep 1/2: deleting Cloudinary assets...');
    if (publicIds.length) await deleteCloudinaryPublicIds(publicIds);
    const remaining = await verifyCloudinaryEmpty(publicIds);
    console.log(`Cloudinary verification: ${remaining.byPrefix} left by prefix, ${remaining.byId} left by ID`);
    if (remaining.byPrefix !== 0 || remaining.byId !== 0) {
      throw new Error('Cloudinary still has sticker assets. MongoDB was NOT touched, so you can simply re-run this script.');
    }

    console.log('\nStep 2/2: deleting MongoDB records...');
    const [stickerDelete, attributionDelete] = await Promise.all([
      AiSticker.deleteMany({}),
      AiStickerMessage.deleteMany({}),
    ]);
    console.log(`Deleted AiSticker records:        ${stickerDelete.deletedCount || 0}`);
    console.log(`Deleted AiStickerMessage records: ${attributionDelete.deletedCount || 0}`);

    const [stickersLeft, attributionsLeft] = await Promise.all([
      AiSticker.countDocuments({}),
      AiStickerMessage.countDocuments({}),
    ]);
    console.log(`\nVerification: AiSticker=${stickersLeft}, AiStickerMessage=${attributionsLeft}, Cloudinary=${remaining.byPrefix}`);
    if (stickersLeft !== 0 || attributionsLeft !== 0) {
      throw new Error('MongoDB still contains sticker records. Inspect the backup and re-run.');
    }
    console.log('\nReset complete. The bot must be started/restarted before it sees the empty library:');
    console.log('  pm2 restart ani-chan-bot');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Reset failed: ${errMessage(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, collectPublicIds };
