#!/usr/bin/env node
'use strict';

// Import .wastickers packs into the ONE shared sticker library.
//
//   node scripts/import-anime-sticker-packs.js --dry-run     inspect packs only
//   node scripts/import-anime-sticker-packs.js               real import
//
// Per pack (one anime each), fully committed before the next pack starts:
//   extract -> keep valid .webp only -> SHA-256 dedupe -> skip hashes already in
//   the library -> cheap generic Gemini screening (throttled, retried, cached)
//   -> pick the most varied reactions to reach TARGET per anime -> upload each
//   physical asset to Cloudinary once -> insert ONE shared Mongo record.
// Persona analysis is NOT done here: the bot's existing delayed background
// queue does it on the next start, using the anime/character/generic metadata
// stored below. Safe to re-run: existing hashes are skipped and an anime that
// already has TARGET stickers is left alone.

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
// Same Cloudinary helper the bot uses at runtime: it reads CLOUDINARY_URL or
// the three CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET vars and uploads with the
// same folder/public_id convention as the owner .stickerimport flow.
const cloudinaryUtil = require('../utils/cloudinary');
const gemini = require('../utils/gemini');
const { AI_STICKER_MAX_BYTES, AI_STICKER_ANALYSIS_DELAY_MS } = require('../utils/config');
const AiSticker = require('../models/AiSticker');

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.join(__dirname, '..');
const CLOUDINARY_FOLDER = 'ai-stickers/shared';
const DEFAULT_TARGET = 10;
const DEFAULT_MAX_CANDIDATES = 40;
const SCREEN_ATTEMPTS = 3;
const UPLOAD_ATTEMPTS = 3;
// Stop hammering a dead/rate-limited Gemini API: after this many candidates in
// a row fail even after retries, the pack is abandoned (progress stays cached).
const MAX_CONSECUTIVE_SCREEN_FAILURES = 4;
const RETRY_BASE_MS = Math.max(0, Number.parseInt(process.env.STICKER_IMPORT_RETRY_BASE_MS ?? '3000', 10) || 0);

// Reaction labels a generic screening may return. Must stay a subset of
// ALLOWED_REACTIONS in utils/aiStickers.js (a unit test enforces this).
const GENERIC_REACTIONS = [
  'amused', 'happy', 'laughing', 'love', 'excited', 'sad', 'angry', 'confused',
  'surprised', 'embarrassed', 'shy', 'awkward', 'sleepy', 'annoyed', 'teasing',
  'disbelief', 'worried', 'supportive', 'neutral',
];
const GENERIC_REACTION_SET = new Set(GENERIC_REACTIONS);
// The reaction spread the library should cover for each anime.
const TARGET_REACTIONS = [
  'laughing', 'happy', 'sad', 'angry', 'surprised',
  'confused', 'embarrassed', 'teasing', 'supportive', 'neutral',
];

function argValue(argv, name) {
  const hit = argv.find(arg => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function parseOptions(argv) {
  const flags = new Set(argv);
  const positiveInt = (name, fallback) => {
    const raw = argValue(argv, name);
    const value = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const delayRaw = Number.parseInt(argValue(argv, '--delay-ms') ?? '', 10);
  return {
    help: flags.has('--help') || flags.has('-h'),
    dryRun: flags.has('--dry-run'),
    noScreen: flags.has('--no-screen'),
    keep: flags.has('--keep'),
    target: positiveInt('--target', DEFAULT_TARGET),
    maxCandidates: positiveInt('--max-candidates', DEFAULT_MAX_CANDIDATES),
    delayMs: Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : Math.max(0, AI_STICKER_ANALYSIS_DELAY_MS),
    sourceDir: path.resolve(argValue(argv, '--dir') || path.join(PROJECT_ROOT, 'imports', 'anime-stickers')),
    manifestArg: argValue(argv, '--manifest'),
    unzip: process.env.UNZIP_BIN || 'unzip',
  };
}

function usage() {
  console.log([
    'Usage:',
    '  node scripts/import-anime-sticker-packs.js --dry-run',
    '  node scripts/import-anime-sticker-packs.js',
    '',
    'Put Naruto.wastickers, OnePiece.wastickers, ... in imports/anime-stickers/.',
    'Optional imports/anime-stickers/manifest.json gives exact anime names:',
    '  [{"file":"Naruto.wastickers","animeId":"naruto","animeName":"Naruto",',
    '    "sourcePackName":"Naruto Reactions","sourceUrl":"...","characters":["Naruto Uzumaki"]}]',
    '',
    'Options:',
    '  --dry-run              Extract and validate only. No Gemini, Cloudinary or Mongo writes.',
    `  --target=N             Stickers to keep per anime (default ${DEFAULT_TARGET})`,
    `  --max-candidates=N     Screen at most N stickers per pack (default ${DEFAULT_MAX_CANDIDATES})`,
    '  --delay-ms=N           Pause between Gemini screening calls (default: AI_STICKER_ANALYSIS_DELAY_MS)',
    '  --no-screen            Skip Gemini screening (selection becomes arbitrary; not recommended)',
    '  --keep                 Leave finished .wastickers files in place instead of archiving them',
    '  --dir=DIR --manifest=FILE',
  ].join('\n'));
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown-anime';
}

function packId(value) {
  return slug(value).replace(/-/g, '_');
}

function humanizeFilename(base) {
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsePackMetadata(file, manifest) {
  const item = (manifest || []).find(entry => String(entry.file || '').toLowerCase() === file.toLowerCase()) || {};
  const base = path.basename(file, path.extname(file));
  const animeName = String(item.animeName || humanizeFilename(base) || base).trim();
  return {
    animeId: item.animeId ? slug(item.animeId) : slug(animeName),
    animeName,
    // Cast hints only: each sticker's own characters come from screening.
    castHints: Array.isArray(item.characters) ? item.characters.map(String).map(s => s.trim()).filter(Boolean).slice(0, 30) : [],
    sourcePackId: item.sourcePackId ? String(item.sourcePackId) : packId(item.sourcePackName || base),
    sourcePackName: String(item.sourcePackName || `${animeName} Reactions`),
    sourceUrl: String(item.sourceUrl || ''),
  };
}

async function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.packs) ? parsed.packs : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Could not read manifest ${manifestPath}: ${err.message}`);
  }
}

function errMessage(err) {
  return String(err?.error?.message || err?.message || err || 'unknown error').slice(0, 300);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(label, attempts, fn) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        console.warn(`  ${label} failed (attempt ${attempt}/${attempts}): ${errMessage(err)}`);
        await sleep(RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastError;
}

// ─── Pack extraction ───────────────────────────────────────────────────────
async function assertUnzipAvailable(unzip) {
  try {
    await execFileAsync(unzip, ['-v']);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`"${unzip}" was not found. In Termux run: pkg install unzip`);
    // unzip -v exits 0 normally; any other exit still proves the binary exists.
  }
}

async function extractPack(unzip, packPath, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  try {
    await execFileAsync(unzip, ['-qq', '-o', packPath, '-d', outDir], { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    // Info-ZIP exit code 1 means "finished with warnings"; the files are fine.
    if (err.code !== 1) throw new Error(`Could not extract ${path.basename(packPath)}: ${errMessage(err)}`);
  }
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      // Only .webp: a .wastickers also carries a tray icon (.png) that is not a sticker.
      else if (/\.webp$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(outDir);
  return files.sort();
}

function isValidWebp(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP';
}

async function loadCandidates(files, maxBytes) {
  const byHash = new Map();
  const skipped = { invalid: 0, tooLarge: 0, duplicate: 0 };
  for (const file of files) {
    const bytes = await fs.readFile(file);
    if (!isValidWebp(bytes)) { skipped.invalid += 1; continue; }
    if (bytes.length > maxBytes) { skipped.tooLarge += 1; continue; }
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (byHash.has(hash)) { skipped.duplicate += 1; continue; }
    byHash.set(hash, { path: file, hash, bytes: bytes.length, genericAnalysis: null, characters: [] });
  }
  return { candidates: [...byHash.values()], skipped };
}

function sampleEvenly(list, max) {
  if (list.length <= max) return list;
  const picked = [];
  for (let i = 0; i < max; i += 1) picked.push(list[Math.floor((i * list.length) / max)]);
  return picked;
}

// ─── Generic (persona-independent) screening ───────────────────────────────
function normalizeLabel(value) {
  const label = String(value || '').trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, '-').slice(0, 32);
  return /^[a-z0-9][a-z0-9-]*$/.test(label) ? label : null;
}

function labelList(value, limit = 8, allowed = null) {
  if (!Array.isArray(value)) return [];
  const labels = value.map(normalizeLabel).filter(Boolean).filter(label => !allowed || allowed.has(label));
  return [...new Set(labels)].slice(0, limit);
}

function parseGenericAnalysis(rawText, castHints = []) {
  const text = String(rawText || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('generic screening returned no JSON object');
  const value = JSON.parse(text.slice(start, end + 1));
  const reactions = labelList(value.reactions, 8, GENERIC_REACTION_SET);
  if (!reactions.length) throw new Error('generic screening returned no usable reaction labels');
  const hintByLower = new Map(castHints.map(name => [name.toLowerCase(), name]));
  const characters = Array.isArray(value.characters)
    ? [...new Set(value.characters.map(name => hintByLower.get(String(name || '').trim().toLowerCase())).filter(Boolean))].slice(0, 6)
    : [];
  return {
    expression: String(value.expression || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    emotions: labelList(value.emotions),
    moods: labelList(value.moods),
    uses: labelList(value.uses),
    reactions,
    characters,
    diversityScore: Math.max(0, Math.min(1, Number(value.diversityScore) || 0)),
  };
}

async function screenCandidate(candidate, meta) {
  const image = (await fs.readFile(candidate.path)).toString('base64');
  const hints = meta.castHints.length ? meta.castHints.join(', ') : 'none - return an empty characters array';
  const raw = await gemini.generateVision({
    systemPrompt: 'You are a concise anime sticker cataloguer for a shared reaction library. Describe only what the sticker shows; do not role-play or infer any persona.',
    prompt: `This sticker is from the anime ${meta.animeName}. Return only JSON with: expression (short string), arrays emotions, moods, uses, reactions, characters, and diversityScore (0 to 1: how distinctive and broadly usable this reaction is in chat). reactions may only use these labels: ${GENERIC_REACTIONS.join(', ')}. characters may only contain names from this list when clearly visible: ${hints}. Keep labels short and lowercase.`,
    base64Image: image,
    mimeType: 'image/webp',
    maxOutputTokens: 512,
  });
  return parseGenericAnalysis(raw, meta.castHints);
}

async function loadScreeningCache(cachePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_err) {
    return {};
  }
}

async function saveScreeningCache(cachePath, cache) {
  const tmp = `${cachePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache));
  await fs.rename(tmp, cachePath);
}

// Screens candidates one at a time (rate-limit friendly), retrying transient
// failures and remembering successes on disk so a dropped connection never
// wastes finished work. Returns only candidates that were screened.
async function screenAll(candidates, meta, options, cache, cachePath) {
  const screened = [];
  let failed = 0;
  let consecutiveFailures = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const cacheKey = `${meta.animeId}:${candidate.hash}`;
    if (cache[cacheKey]) {
      candidate.genericAnalysis = cache[cacheKey];
      candidate.characters = cache[cacheKey].characters || [];
      screened.push(candidate);
      continue;
    }
    try {
      const analysis = await withRetry(`screening ${candidate.hash.slice(0, 8)}`, SCREEN_ATTEMPTS, () => screenCandidate(candidate, meta));
      candidate.genericAnalysis = analysis;
      candidate.characters = analysis.characters;
      cache[cacheKey] = analysis;
      consecutiveFailures = 0;
      await saveScreeningCache(cachePath, cache).catch(err => console.warn(`  Could not save screening cache: ${errMessage(err)}`));
      screened.push(candidate);
      console.log(`  screened ${screened.length + failed}/${candidates.length}: ${analysis.reactions.join(', ')}`);
    } catch (err) {
      failed += 1;
      consecutiveFailures += 1;
      console.warn(`  gave up on ${candidate.hash.slice(0, 8)}: ${errMessage(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_SCREEN_FAILURES) {
        console.warn(`  ${consecutiveFailures} failures in a row - Gemini looks unavailable or rate limited; stopping this pack.`);
        break;
      }
    }
    if (i < candidates.length - 1 && options.delayMs > 0) await sleep(options.delayMs);
  }
  return { screened, failed };
}

// ─── Selection ─────────────────────────────────────────────────────────────
// Greedy coverage: every pick should add reaction types the anime does not have
// yet, preferring distinctive stickers. Ties break by hash so results are stable.
function chooseDiverse(candidates, count) {
  const selected = [];
  const covered = new Set();
  const remaining = [...candidates];
  while (remaining.length && selected.length < count) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((candidate, index) => {
      const analysis = candidate.genericAnalysis || {};
      const reactions = analysis.reactions || [];
      const newTarget = reactions.filter(label => TARGET_REACTIONS.includes(label) && !covered.has(label)).length;
      const newOther = reactions.filter(label => !TARGET_REACTIONS.includes(label) && !covered.has(label)).length;
      const score = newTarget * 10 + newOther * 4 + (analysis.diversityScore || 0) * 5 + Math.min((analysis.uses || []).length, 3);
      const better = score > bestScore || (score === bestScore && candidate.hash < remaining[bestIndex].hash);
      if (better) { bestScore = score; bestIndex = index; }
    });
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    for (const label of chosen.genericAnalysis?.reactions || []) covered.add(label);
  }
  return selected;
}

// ─── Persisting ────────────────────────────────────────────────────────────
async function importOne(candidate, meta) {
  const bytes = await fs.readFile(candidate.path);
  const uploaded = await withRetry(`upload ${candidate.hash.slice(0, 8)}`, UPLOAD_ATTEMPTS, () => cloudinaryUtil.uploadBufferToCloud(bytes, {
    folder: CLOUDINARY_FOLDER,
    publicId: candidate.hash,
    resourceType: 'image',
    format: 'webp',
  }));
  if (!uploaded?.url || !/^https:\/\//i.test(uploaded.url) || !uploaded.publicId) {
    throw new Error('Cloudinary did not return a secure URL and public ID');
  }
  const { characters: _perStickerCharacters, ...genericFields } = candidate.genericAnalysis || {};
  try {
    await AiSticker.create({
      personaId: 'shared',
      hash: candidate.hash,
      cloudinaryPublicId: uploaded.publicId,
      cloudinaryUrl: uploaded.url,
      cloudinaryVersion: Number.isFinite(Number(uploaded.version)) ? Number(uploaded.version) : null,
      format: 'webp',
      bytes: bytes.length,
      animeId: meta.animeId,
      animeName: meta.animeName,
      characters: candidate.characters || [],
      sourcePackId: meta.sourcePackId,
      sourcePackName: meta.sourcePackName,
      sourceUrl: meta.sourceUrl,
      genericAnalysis: candidate.genericAnalysis ? { ...genericFields, analyzedAt: new Date() } : null,
      analysisStatus: 'unclassified',
      personaAnalyses: [],
      importedAt: new Date(),
    });
    return 'imported';
  } catch (err) {
    if (err.code === 11000 || err.code === 11001) return 'duplicate';
    // Mongo failed after the upload: remove the orphan unless a record exists.
    const exists = await AiSticker.exists({ hash: candidate.hash }).catch(() => true);
    if (!exists) await cloudinaryUtil.deleteFromCloud(uploaded.publicId);
    throw err;
  }
}

// ─── One pack ──────────────────────────────────────────────────────────────
async function processPack(packFile, ctx) {
  const { options, manifest, tempRoot, cache, cachePath } = ctx;
  const meta = parsePackMetadata(packFile, manifest);
  const packPath = path.join(options.sourceDir, packFile);
  console.log(`\n== ${packFile} -> ${meta.animeName} (${meta.animeId})`);

  const files = await extractPack(options.unzip, packPath, path.join(tempRoot, crypto.createHash('sha1').update(packFile).digest('hex').slice(0, 12)));
  const { candidates: allCandidates, skipped } = await loadCandidates(files, AI_STICKER_MAX_BYTES);
  console.log(`  ${files.length} .webp file(s): ${allCandidates.length} valid unique, skipped ${skipped.invalid} invalid, ${skipped.tooLarge} too large, ${skipped.duplicate} duplicate`);
  if (!allCandidates.length) throw new Error('no valid .webp stickers found in this pack');

  const known = new Set((await AiSticker.find({ hash: { $in: allCandidates.map(c => c.hash) } }, { hash: 1 }).lean()).map(doc => doc.hash));
  const fresh = allCandidates.filter(candidate => !known.has(candidate.hash));
  const existingForAnime = await AiSticker.countDocuments({ animeId: meta.animeId });
  const need = options.target - existingForAnime;
  console.log(`  ${known.size} already in library, ${fresh.length} new; ${meta.animeName} has ${existingForAnime}/${options.target}`);

  if (need <= 0) { console.log('  Target already reached - nothing to import.'); return { imported: 0, archived: true }; }
  if (!fresh.length) { console.log('  No new stickers in this pack.'); return { imported: 0, archived: true }; }
  if (options.dryRun) { console.log(`  Dry run: would screen up to ${Math.min(fresh.length, options.maxCandidates)} and import ${Math.min(need, fresh.length)}.`); return { imported: 0, archived: false }; }

  const pool = sampleEvenly(fresh, options.maxCandidates);
  let eligible = pool;
  if (!options.noScreen) {
    console.log(`  Screening ${pool.length} candidate(s), ${options.delayMs} ms apart...`);
    const { screened, failed } = await screenAll(pool, meta, options, cache, cachePath);
    if (screened.length < Math.min(need, pool.length)) {
      throw new Error(`only ${screened.length}/${pool.length} candidates could be screened (${failed} failed, need ${need}). Nothing imported for this anime; re-run later - finished screenings are cached.`);
    }
    eligible = screened;
  }

  const chosen = chooseDiverse(eligible, need);
  console.log(`  Selected ${chosen.length} of ${eligible.length}: ${[...new Set(chosen.flatMap(c => c.genericAnalysis?.reactions || []))].join(', ') || '(unscreened)'}`);
  let imported = 0;
  for (const candidate of chosen) {
    const outcome = await importOne(candidate, meta);
    if (outcome === 'imported') { imported += 1; console.log(`  imported ${candidate.hash.slice(0, 8)}`); }
    else console.log(`  skipped ${candidate.hash.slice(0, 8)} (already exists)`);
  }
  return { imported, archived: true };
}

async function archivePack(packFile, options, stamp) {
  const archiveDir = path.join(options.sourceDir, 'processed', stamp);
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.rename(path.join(options.sourceDir, packFile), path.join(archiveDir, packFile));
  return archiveDir;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) return usage();
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing from .env');
  if (!options.dryRun) {
    if (!cloudinaryUtil.isCloudConfigured()) throw new Error('Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET in .env');
    if (!options.noScreen && !process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing from .env (or use --no-screen)');
  }
  await assertUnzipAvailable(options.unzip);

  const manifestPath = path.resolve(options.manifestArg || path.join(options.sourceDir, 'manifest.json'));
  const manifest = await readManifest(manifestPath);
  const entries = await fs.readdir(options.sourceDir).catch(err => {
    if (err.code === 'ENOENT') throw new Error(`Folder not found: ${options.sourceDir}`);
    throw err;
  });
  const packs = entries.filter(name => /\.wastickers$/i.test(name)).sort();
  if (!packs.length) throw new Error(`No .wastickers files found in ${options.sourceDir}`);

  const cachePath = path.join(options.sourceDir, '.screening-cache.json');
  const cache = await loadScreeningCache(cachePath);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000, socketTimeoutMS: 60000 });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ani-stickers-'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const failures = [];
  let totalImported = 0;
  try {
    for (const packFile of packs) {
      try {
        const result = await processPack(packFile, { options, manifest, tempRoot, cache, cachePath });
        totalImported += result.imported;
        if (result.archived && !options.keep && !options.dryRun) {
          const dir = await archivePack(packFile, options, stamp);
          console.log(`  archived to ${path.relative(PROJECT_ROOT, dir) || dir}`);
        }
      } catch (err) {
        failures.push(`${packFile}: ${errMessage(err)}`);
        console.error(`  FAILED: ${errMessage(err)}`);
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }

  console.log(`\nDone: ${totalImported} sticker(s) imported${options.dryRun ? ' (dry run)' : ''}, ${failures.length} pack(s) failed.`);
  if (failures.length) {
    failures.forEach(line => console.error(` - ${line}`));
    process.exitCode = 1;
  }
  if (totalImported > 0) console.log('Restart the bot so it loads the new library and queues persona analysis: pm2 restart ani-chan-bot');
}

if (require.main === module) {
  main().catch(async err => {
    console.error(`Import failed: ${errMessage(err)}`);
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  GENERIC_REACTIONS,
  TARGET_REACTIONS,
  parseOptions,
  parsePackMetadata,
  parseGenericAnalysis,
  isValidWebp,
  chooseDiverse,
  sampleEvenly,
};
