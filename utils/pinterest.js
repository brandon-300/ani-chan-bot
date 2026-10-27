'use strict';

const axios = require('axios');
const { createHash } = require('node:crypto');

// Support both the documented schema and the flat output observed on-device:
// found/status/pinId may be absent, with an opaque e1_ ID in the pin permalink.
const ENDPOINT = 'https://api.apify.com/v2/acts/accountable_eel~pinterest-search-lookup/run-sync-get-dataset-items';
const CACHE_MAX_QUERIES = 50;
const cache = new Map();
const pending = new Map();

class PinterestError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function setting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new PinterestError('PINTEREST_CONFIG');
  return value;
}

function pinIdFromRow(row) {
  const validId = /^(?:\d+|e1_[A-Za-z0-9_-]+)$/;
  if (typeof row.pinId === 'string' && validId.test(row.pinId)) return row.pinId;
  // Preserve exact IDs as strings for persistent per-chat deduplication.
  // Only extract from real Pinterest pin permalinks, never arbitrary URLs.
  try {
    const link = new URL(row.url);
    if (link.protocol !== 'https:' || !['pinterest.com', 'www.pinterest.com'].includes(link.hostname)
      || link.username || link.password) return null;
    const match = link.pathname.match(/^\/pin\/([^/]+)\/?$/);
    return match && validId.test(match[1]) ? match[1] : null;
  } catch { return null; }
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new PinterestError('PINTEREST_RESPONSE');
  const pins = new Map();
  const failures = [];
  let malformed = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') { malformed = true; continue; }
    if (row.found === false || (typeof row.status === 'string' && row.status !== 'OK')) {
      if (row.status !== 'NOT_FOUND') failures.push(row.status || 'UNKNOWN');
      continue;
    }
    // Missing status metadata is allowed, but explicit failures and malformed
    // metadata must never be treated as a successful search result.
    if ((row.found !== undefined && row.found !== true)
      || (row.status !== undefined && row.status !== 'OK')) {
      malformed = true;
      continue;
    }
    const pinId = pinIdFromRow(row);
    if (!pinId) { malformed = true; continue; }
    let image;
    try { image = new URL(row.imageUrl); } catch { malformed = true; continue; }
    if (image.protocol !== 'https:' || image.hostname !== 'i.pinimg.com' || image.username || image.password) {
      malformed = true;
      continue;
    }
    pins.set(pinId, {
      id: pinId,
      title: typeof row.title === 'string' ? row.title : '',
      description: typeof row.description === 'string' ? row.description : '',
      image_url: image.href,
    });
  }
  if (pins.size) return [...pins.values()];
  if (failures.includes('BLOCKED')) throw new PinterestError('PINTEREST_BLOCKED');
  if (failures.length) throw new PinterestError('PINTEREST_UPSTREAM');
  if (malformed) throw new PinterestError('PINTEREST_RESPONSE');
  return [];
}

async function searchPinterest(query) {
  const token = String(process.env.APIFY_TOKEN || '').trim();
  if (!token) throw new PinterestError('APIFY_TOKEN_MISSING');
  const maxPins = setting('APIFY_PINTEREST_MAX_PINS', 25, 1, 50);
  const cacheMinutes = setting('APIFY_PINTEREST_CACHE_MINUTES', 30, 0, 1440);
  const tokenKey = createHash('sha256').update(token).digest('hex');
  const key = JSON.stringify([tokenKey, maxPins, cacheMinutes, query.trim().toLowerCase()]);
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(entryKey);
  const hit = cache.get(key);
  if (hit && cacheMinutes > 0) {
    cache.delete(key);
    cache.set(key, hit);
    console.log(`[pinterest] Apify cache hit: ${hit.pins.length} pin(s)`);
    return hit.pins;
  }
  if (pending.has(key)) return pending.get(key);

  const request = (async () => {
    // No retries: repeating a timed-out POST could start and bill a second run.
    const response = await axios.post(ENDPOINT, {
      queries: [query], maxPins, maxResults: maxPins,
      expandRows: true, skipDuplicatePins: true, maxConcurrency: 1,
      columns: ['pinId', 'url', 'title', 'description', 'imageUrl'],
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      params: { format: 'json', timeout: 60, restartOnError: false },
      timeout: 90000,
      maxContentLength: 2 * 1024 * 1024,
    });
    const pins = normalizeRows(response.data).slice(0, maxPins);
    console.log(`[pinterest] Apify search complete: ${pins.length} pin(s)`);
    if (cacheMinutes > 0) {
      cache.set(key, { pins, expiresAt: Date.now() + cacheMinutes * 60000 });
      while (cache.size > CACHE_MAX_QUERIES) cache.delete(cache.keys().next().value);
    }
    return pins;
  })();
  pending.set(key, request);
  try { return await request; } finally { pending.delete(key); }
}

function pinterestErrorMessage(err) {
  const status = err.response?.status;
  if (err.code === 'APIFY_TOKEN_MISSING') return '❌ Pinterest is not configured. The bot owner needs to set APIFY_TOKEN.';
  if (err.code === 'PINTEREST_CONFIG') return '❌ Pinterest settings are invalid. Ask the bot owner to check the Apify result/cache limits.';
  if (status === 401 || status === 403) return '❌ Pinterest search failed: Apify rejected the token or actor access. Ask the bot owner to check Apify.';
  if (status === 402) return '❌ Pinterest search is unavailable: check Apify credits and spending limits.';
  if (status === 429) return '❌ Pinterest search has reached an Apify rate or quota limit. Please wait before trying again.';
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code) || status === 408 || status === 504) {
    return '❌ Pinterest search timed out or lost its connection. It may still be running; please wait and check the Apify run before repeating it.';
  }
  if (err.code === 'PINTEREST_BLOCKED') return '❌ Pinterest temporarily blocked this search. Please wait before trying again.';
  return '❌ Pinterest search failed. The bot owner can check PM2 logs for the error code.';
}

module.exports = { searchPinterest, pinterestErrorMessage };
