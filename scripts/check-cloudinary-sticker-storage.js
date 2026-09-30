#!/usr/bin/env node
'use strict';

// Read-only diagnostic: where does Cloudinary really keep the AI stickers?
//
//   node scripts/check-cloudinary-sticker-storage.js
//   node scripts/check-cloudinary-sticker-storage.js --probe-upload
//
// Default mode changes nothing. It reads the newest reset backup in backups/
// (or --backup=FILE) and asks Cloudinary whether each old sticker still exists,
// under its recorded public ID or under the bare hash. It also samples what the
// account root looks like.
//
// --probe-upload additionally uploads ONE 1x1 test image to ai-stickers/probe,
// prints what Cloudinary reports (public_id, asset_folder, ...), then deletes
// it. That shows exactly where the importer's uploads will land.

const path = require('node:path');
const fs = require('node:fs/promises');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const cloudinary = require('cloudinary').v2;
// Configures the shared SDK exactly like the running bot (CLOUDINARY_URL or the
// three CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET variables).
const cloudinaryUtil = require('../utils/cloudinary');

const PROJECT_ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const probeUpload = argv.includes('--probe-upload');
const backupArg = argv.find(arg => arg.startsWith('--backup='));
const BATCH = 100;
// Smallest valid PNG (1x1 transparent pixel).
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function errMessage(err) {
  return String(err?.error?.message || err?.message || err || 'unknown error').slice(0, 300);
}

async function findBackup() {
  if (backupArg) return path.resolve(backupArg.slice('--backup='.length));
  const dir = path.join(PROJECT_ROOT, 'backups');
  const names = (await fs.readdir(dir).catch(() => [])).filter(name => /^ai-sticker-library-\d+\.json$/.test(name)).sort();
  return names.length ? path.join(dir, names[names.length - 1]) : null;
}

function describe(resource) {
  return {
    public_id: resource.public_id,
    asset_folder: resource.asset_folder === undefined ? '(not reported)' : (resource.asset_folder || '(root)'),
    folder: resource.folder === undefined ? '(not reported)' : resource.folder,
    created_at: resource.created_at || '(unknown)',
  };
}

async function existingByIds(ids) {
  const found = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const result = await cloudinary.api.resources_by_ids(ids.slice(i, i + BATCH), { type: 'upload', resource_type: 'image' });
    found.push(...(result?.resources || []));
  }
  return found;
}

async function checkBackup() {
  const backupPath = await findBackup();
  if (!backupPath) {
    console.log('No backups/ai-sticker-library-*.json found, skipping the old-sticker check.');
    return;
  }
  const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  const stickers = Array.isArray(backup.stickers) ? backup.stickers : [];
  console.log(`Backup: ${backupPath}`);
  console.log(`Old sticker records in backup: ${stickers.length}`);
  const recordedIds = [...new Set(stickers.map(s => String(s.cloudinaryPublicId || '')).filter(Boolean))];
  const bareIds = [...new Set(stickers.map(s => String(s.hash || '')).filter(Boolean))];
  console.log('Sample recorded public IDs:', recordedIds.slice(0, 3));

  const stillRecorded = await existingByIds(recordedIds);
  const stillBare = await existingByIds(bareIds);
  console.log(`\nStill in Cloudinary under the RECORDED public ID: ${stillRecorded.length}/${recordedIds.length}`);
  stillRecorded.slice(0, 5).forEach(r => console.log('  ', describe(r)));
  console.log(`Still in Cloudinary under the BARE HASH as public ID: ${stillBare.length}/${bareIds.length}`);
  stillBare.slice(0, 5).forEach(r => console.log('  ', describe(r)));
}

async function sampleRoot() {
  console.log('\n--- Newest 10 image assets in the account (any folder) ---');
  const result = await cloudinary.api.resources({ type: 'upload', resource_type: 'image', max_results: 10, direction: 'desc' });
  const rows = result?.resources || [];
  if (!rows.length) console.log('  (none)');
  rows.forEach(r => console.log('  ', describe(r)));

  console.log('\n--- Assets whose public ID starts with "ai-stickers/" ---');
  const byPrefix = await cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix: 'ai-stickers/', max_results: 10 });
  console.log(`  ${(byPrefix?.resources || []).length} found (showing up to 10)`);
  (byPrefix?.resources || []).forEach(r => console.log('  ', describe(r)));

  console.log('\n--- Assets inside the Media Library folder "ai-stickers/shared" (dynamic folder mode only) ---');
  try {
    const byFolder = await cloudinary.api.resources_by_asset_folder('ai-stickers/shared', { max_results: 10 });
    console.log(`  ${(byFolder?.resources || []).length} found`);
    (byFolder?.resources || []).forEach(r => console.log('  ', describe(r)));
  } catch (err) {
    console.log(`  Not available on this account: ${errMessage(err)}`);
  }
}

function uploadProbe() {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'ai-stickers/probe', public_id: `folder-probe-${Date.now()}`, overwrite: true, resource_type: 'image', format: 'png' },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(TINY_PNG);
  });
}

async function runProbe() {
  console.log('\n--- Probe upload (uploads 1 tiny image, then deletes it) ---');
  const result = await uploadProbe();
  const asset = {
    public_id: result.public_id,
    asset_folder: result.asset_folder === undefined ? '(not reported)' : (result.asset_folder || '(root)'),
    display_name: result.display_name === undefined ? '(not reported)' : result.display_name,
    folder: result.folder === undefined ? '(not reported)' : result.folder,
  };
  console.log('  Cloudinary reported:', asset);
  try {
    const removed = await cloudinary.uploader.destroy(result.public_id, { resource_type: 'image', invalidate: true });
    console.log(`  Probe deleted: ${removed?.result || 'unknown'}`);
  } catch (err) {
    console.log(`  WARNING: could not delete the probe (${result.public_id}): ${errMessage(err)}. Delete it manually in the Media Library.`);
  }
  const idHasFolder = String(result.public_id).startsWith('ai-stickers/probe/');
  const reportsAssetFolder = result.asset_folder !== undefined;
  console.log('\nWhat this means (read from the values above, not assumed):');
  console.log(`  - public_id ${idHasFolder ? 'INCLUDES' : 'does NOT include'} the "ai-stickers/probe/" prefix`);
  console.log(`  - asset_folder is ${reportsAssetFolder ? `reported (${asset.asset_folder})` : 'not reported'}`);
  if (reportsAssetFolder) {
    console.log('  - The account appears to use dynamic folders: the Media Library folder is asset_folder, separate from the public_id text.');
  } else {
    console.log('  - No asset_folder field: the account appears to use classic (fixed) folders.');
  }
}

async function main() {
  if (!cloudinaryUtil.isCloudConfigured()) {
    throw new Error('Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET in .env');
  }
  console.log(probeUpload ? 'Mode: read-only checks + probe upload' : 'Mode: read-only (add --probe-upload to test where uploads land)');
  await checkBackup();
  await sampleRoot();
  if (probeUpload) await runProbe();
  console.log('\nDone. Nothing else was changed.');
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Check failed: ${errMessage(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, describe };
