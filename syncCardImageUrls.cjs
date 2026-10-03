// Sync versioned Cloudinary URLs into a card CSV's `newImageUrl` column.
//
// Usage (from the repository root):
//   node syncCardImageUrls.js card-imageurl-final-ascii.csv
//   node syncCardImageUrls.js input.csv output.csv
//   node syncCardImageUrls.js input.csv --in-place
//   node syncCardImageUrls.js input.csv --folder=card-images
//
// By default the source is never overwritten: output goes to
// <input-name>.versioned.csv. --in-place makes a timestamped .bak first.
// Exact normalized name matches are preferred. If the CSV has duplicate card
// names, a filename containing both the card name and series can disambiguate
// them. Missing or ambiguous matches are reported and left unchanged.
//
// Cloudinary credentials are read from the project's .env using the same
// CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET settings as utils/cloudinary.js.
// The CSV is local input/output; download it from Drive first and upload the
// generated CSV back to Drive after reviewing the report.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FOLDER = 'card-images';

function parseCsv(text) {
  const input = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  if (quoted) throw new Error('Malformed CSV: an opening quote was not closed.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function encodeCsvField(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeCsv(rows) {
  return `${rows.map(row => row.map(encodeCsvField).join(',')).join('\n')}\n`;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function assetNameKeys(asset) {
  const keys = new Set();
  const publicId = String(asset.public_id || '').split('/').pop();
  const displayName = String(asset.display_name || '').split('/').pop();
  for (const value of [publicId, displayName]) {
    const key = normalizeName(value);
    if (key) keys.add(key);
  }
  return [...keys];
}

function buildVersionedUrl(asset, cloudName) {
  const version = Number(asset.version);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`Cloudinary asset ${asset.public_id || '(unknown)'} has no valid version number.`);
  }

  // The Admin API's secure_url is the canonical Cloudinary URL. Ensure the
  // current version is in the delivery path even if a response omits it.
  if (asset.secure_url) {
    const url = new URL(asset.secure_url);
    const resourceType = asset.resource_type || 'image';
    const deliveryType = asset.type || 'upload';
    const marker = `/${resourceType}/${deliveryType}/`;
    const markerAt = url.pathname.indexOf(marker);
    if (markerAt === -1) {
      throw new Error(`Unexpected Cloudinary secure_url for ${asset.public_id}: ${asset.secure_url}`);
    }
    const tailStart = markerAt + marker.length;
    const tail = url.pathname.slice(tailStart);
    const versionedTail = tail.replace(/^v\d+\//, '');
    url.pathname = `${url.pathname.slice(0, tailStart)}v${version}/${versionedTail}`;
    return url.toString();
  }

  if (!cloudName || !asset.public_id || !asset.format) {
    throw new Error(`Cannot build a secure URL for Cloudinary asset ${asset.public_id || '(unknown)'}.`);
  }
  const resourceType = asset.resource_type || 'image';
  const deliveryType = asset.type || 'upload';
  const publicId = String(asset.public_id)
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
  const extension = publicId.toLowerCase().endsWith(`.${String(asset.format).toLowerCase()}`)
    ? ''
    : `.${asset.format}`;
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/${resourceType}/${deliveryType}/v${version}/${publicId}${extension}`;
}

function indexAssets(assets) {
  const index = new Map();
  for (const asset of assets) {
    if ((asset.resource_type || 'image') !== 'image') continue;
    for (const key of assetNameKeys(asset)) {
      if (!index.has(key)) index.set(key, new Map());
      const identity = asset.asset_id || `${asset.resource_type || 'image'}:${asset.public_id}`;
      index.get(key).set(identity, asset);
    }
  }
  return index;
}

function seriesQualifiedAssets(assets, name, series) {
  const nameKey = normalizeName(name);
  const seriesKey = normalizeName(series);
  if (!nameKey || !seriesKey) return [];
  const matches = new Map();
  for (const asset of assets) {
    if ((asset.resource_type || 'image') !== 'image') continue;
    const hasNameAndSeries = assetNameKeys(asset).some(key =>
      key.startsWith(nameKey) && key.length > nameKey.length && key.includes(seriesKey)
    );
    if (!hasNameAndSeries) continue;
    const identity = asset.asset_id || `${asset.resource_type || 'image'}:${asset.public_id}`;
    matches.set(identity, asset);
  }
  return [...matches.values()];
}

function updateRows(rows, assets, cloudName) {
  if (!rows.length) throw new Error('The CSV is empty.');
  const headers = rows[0];
  const nameColumn = headers.indexOf('name');
  const urlColumn = headers.indexOf('newImageUrl');
  const idColumn = headers.indexOf('cardId');
  const seriesColumn = headers.indexOf('series');
  if (nameColumn < 0 || urlColumn < 0) {
    throw new Error('CSV must contain `name` and `newImageUrl` columns.');
  }

  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].length !== headers.length) {
      throw new Error(`Malformed CSV: row ${i + 1} has ${rows[i].length} cells; expected ${headers.length}.`);
    }
  }

  const nameCounts = new Map();
  for (const row of rows.slice(1)) {
    const key = normalizeName(row[nameColumn]);
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  const index = indexAssets(assets);
  const report = { updated: 0, unmatched: [], ambiguous: [] };
  const updatedRows = rows.map(row => [...row]);

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const cardId = idColumn < 0 ? `row ${i + 1}` : row[idColumn];
    const name = row[nameColumn];
    const key = normalizeName(name);

    if (!key) {
      report.unmatched.push({ cardId, name, reason: 'empty card name' });
      continue;
    }
    const duplicateCsvName = nameCounts.get(key) > 1;
    const exactCandidates = [...(index.get(key) || new Map()).values()];
    const qualifiedCandidates = seriesColumn < 0
      ? []
      : seriesQualifiedAssets(assets, name, row[seriesColumn]);
    const candidates = duplicateCsvName
      ? qualifiedCandidates
      : (exactCandidates.length === 1
        ? exactCandidates
        : (qualifiedCandidates.length > 0 ? qualifiedCandidates : exactCandidates));
    if (candidates.length === 0) {
      if (duplicateCsvName) {
        report.ambiguous.push({ cardId, name, reason: 'duplicate CSV name has no series-qualified Cloudinary asset match' });
      } else {
        report.unmatched.push({ cardId, name, reason: 'no exact or series-qualified Cloudinary asset-name match' });
      }
      continue;
    }
    if (candidates.length > 1) {
      report.ambiguous.push({
        cardId,
        name,
        reason: `multiple Cloudinary assets match: ${candidates.map(asset => asset.public_id).join(', ')}`,
      });
      continue;
    }

    updatedRows[i][urlColumn] = buildVersionedUrl(candidates[0], cloudName);
    report.updated += 1;
  }

  return { rows: updatedRows, report };
}

async function listFolderAssets(api, folder) {
  const assets = [];
  let nextCursor;
  do {
    const options = { max_results: 500 };
    if (nextCursor) options.next_cursor = nextCursor;
    const result = await api.resources_by_asset_folder(folder, options);
    assets.push(...(result.resources || []));
    nextCursor = result.next_cursor;
  } while (nextCursor);
  return assets;
}

async function listFixedFolderAssets(api, folder) {
  const assets = [];
  let nextCursor;
  do {
    const options = { prefix: `${folder.replace(/\/+$/, '')}/`, max_results: 500 };
    if (nextCursor) options.next_cursor = nextCursor;
    const result = await api.resources('upload', options);
    assets.push(...(result.resources || []));
    nextCursor = result.next_cursor;
  } while (nextCursor);
  return assets;
}

async function fetchFolderAssets(api, folder) {
  try {
    return await listFolderAssets(api, folder);
  } catch (error) {
    const status = error.http_code || (error.error && error.error.http_code);
    if (status !== 404) throw error;
    console.warn('Cloudinary returned 404 for asset-folder listing; retrying as a legacy fixed-folder prefix.');
    return listFixedFolderAssets(api, folder);
  }
}

function parseArgs(args) {
  const options = { folder: null, inPlace: false, force: false, help: false, positional: [] };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--in-place') options.inPlace = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--folder=')) options.folder = arg.slice('--folder='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function printHelp() {
  console.log(`Sync versioned Cloudinary URLs into a CSV.\n\nUsage:\n  node syncCardImageUrls.js <input.csv> [output.csv] [options]\n\nOptions:\n  --folder=NAME  Cloudinary asset folder (default: card-images)\n  --in-place     Replace input after creating a timestamped .bak copy\n  --force        Allow replacing an existing output file\n  --help         Show this help\n\nRequires Cloudinary credentials in the project .env. By default, writes a\nseparate <input-name>.versioned.csv file. Unmatched/ambiguous rows are kept\nunchanged and listed in the report.`);
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) return printHelp();
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  options.folder = options.folder || process.env.CARD_IMAGES_FOLDER || DEFAULT_FOLDER;
  if (options.positional.length < 1 || options.positional.length > 2) {
    throw new Error('Provide an input CSV and optionally an output CSV. Use --help for usage.');
  }
  if (!options.folder.trim()) throw new Error('Cloudinary folder name cannot be blank.');
  if (options.inPlace && options.positional.length === 2) {
    throw new Error('Do not provide an output path with --in-place.');
  }

  const inputPath = path.resolve(options.positional[0]);
  const inputParsed = path.parse(inputPath);
  const outputPath = options.inPlace
    ? inputPath
    : path.resolve(options.positional[1] || path.join(inputParsed.dir, `${inputParsed.name}.versioned${inputParsed.ext || '.csv'}`));

  if (inputPath === outputPath && !options.inPlace) {
    throw new Error('Refusing to overwrite the input; use --in-place to do so with a backup.');
  }
  if (!fs.existsSync(inputPath)) throw new Error(`Input CSV not found: ${inputPath}`);
  if (outputPath !== inputPath && fs.existsSync(outputPath) && !options.force) {
    throw new Error(`Output already exists: ${outputPath}. Choose another path or pass --force.`);
  }

  // Load the same .env as the bot, then reuse its Cloudinary configuration.
  const { isCloudConfigured } = require('./utils/cloudinary');
  const cloudinary = require('cloudinary').v2;
  if (!isCloudConfigured()) {
    throw new Error('Cloudinary credentials are missing. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in the repository .env.');
  }

  console.log(`Fetching image assets from Cloudinary folder: ${options.folder}`);
  const assets = await fetchFolderAssets(cloudinary.api, options.folder);
  const imageAssets = assets.filter(asset => (asset.resource_type || 'image') === 'image');
  if (imageAssets.length === 0) {
    throw new Error(`No image assets were found in Cloudinary folder "${options.folder}".`);
  }

  const sourceRows = parseCsv(fs.readFileSync(inputPath, 'utf8'));
  const { rows, report } = updateRows(sourceRows, imageAssets, cloudinary.config().cloud_name);
  const csvOutput = serializeCsv(rows);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (options.inPlace) {
    const backupPath = `${inputPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(inputPath, backupPath);
    const tempPath = `${inputPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, csvOutput, 'utf8');
    fs.renameSync(tempPath, inputPath);
    console.log(`Backup: ${backupPath}`);
  } else {
    fs.writeFileSync(outputPath, csvOutput, 'utf8');
  }

  console.log(`Cloudinary assets fetched: ${assets.length} (${imageAssets.length} images)`);
  console.log(`Rows updated: ${report.updated}`);
  console.log(`Unmatched: ${report.unmatched.length}; ambiguous/skipped: ${report.ambiguous.length}`);
  console.log(`CSV written: ${outputPath}`);
  for (const item of [...report.unmatched, ...report.ambiguous]) {
    console.warn(`- ${item.cardId} | ${item.name}: ${item.reason}`);
  }
}

module.exports = {
  parseCsv,
  serializeCsv,
  normalizeName,
  buildVersionedUrl,
  indexAssets,
  seriesQualifiedAssets,
  updateRows,
  listFolderAssets,
  listFixedFolderAssets,
  fetchFolderAssets,
  parseArgs,
  main,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
