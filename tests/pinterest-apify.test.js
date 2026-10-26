const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');
const SentPin = require('../models/SentPin');
const { searchPinterest, pinterestErrorMessage } = require('../utils/pinterest');
const search = require('../commands/search');

// Documented flat output from the chosen actor's README/build 1.0.8,
// inspected 2026-10-26. Pin IDs must remain strings beyond MAX_SAFE_INTEGER.
const pin = (id = '309763280644328288', title = '') => ({
  found: true, status: 'OK', pinId: id,
  title, description: null,
  imageUrl: 'https://i.pinimg.com/originals/ad/0d/91/ad0d91719df46be4eaa9f22f773f7fdd.png',
});

function settings(t) {
  const names = ['APIFY_TOKEN', 'APIFY_PINTEREST_MAX_PINS', 'APIFY_PINTEREST_CACHE_MINUTES'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.APIFY_TOKEN = 'apify_api_test_only';
  delete process.env.APIFY_PINTEREST_MAX_PINS;
  delete process.env.APIFY_PINTEREST_CACHE_MINUTES;
  t.after(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });
}

test('Apify request uses the selected actor, Bearer auth, capped input, and documented flat fields', async t => {
  settings(t);
  t.mock.method(axios, 'post', async (url, body, options) => {
    assert.equal(url, 'https://api.apify.com/v2/acts/accountable_eel~pinterest-search-lookup/run-sync-get-dataset-items');
    assert.ok(!url.includes(process.env.APIFY_TOKEN));
    assert.deepEqual(body, {
      queries: ['kitchen ideas'], maxPins: 25, maxResults: 25,
      expandRows: true, skipDuplicatePins: true, maxConcurrency: 1,
      columns: ['pinId', 'title', 'description', 'imageUrl'],
    });
    assert.equal(options.headers.Authorization, 'Bearer apify_api_test_only');
    assert.equal(options.headers['X-RapidAPI-Key'], undefined);
    assert.equal(options.params.timeout, 60);
    assert.equal(options.params.restartOnError, false);
    assert.equal(options.timeout, 90000);
    return { data: [pin(undefined, 'Cozy Kitchen Ideas'), pin(undefined, 'Duplicate')] };
  });
  const result = await searchPinterest('kitchen ideas');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '309763280644328288');
  assert.equal(result[0].description, '');
  assert.equal(result[0].image_url, pin().imageUrl);
});

test('missing credentials and invalid settings never start an actor run', async t => {
  settings(t);
  t.mock.method(axios, 'post', async () => { throw new Error('must not make a request'); });
  delete process.env.APIFY_TOKEN;
  await assert.rejects(searchPinterest('missing token'), { code: 'APIFY_TOKEN_MISSING' });
  process.env.APIFY_TOKEN = 'apify_api_test_only';
  for (const value of ['0', '-1', '51', '1.5', 'NaN', '10junk']) {
    process.env.APIFY_PINTEREST_MAX_PINS = value;
    await assert.rejects(searchPinterest('invalid pin cap'), { code: 'PINTEREST_CONFIG' });
  }
});

test('NOT_FOUND is empty; blocked, failed and malformed rows remain distinguishable errors', async t => {
  settings(t);
  process.env.APIFY_PINTEREST_CACHE_MINUTES = '0';
  let rows;
  t.mock.method(axios, 'post', async () => ({ data: rows }));
  rows = [{ found: false, status: 'NOT_FOUND' }];
  assert.deepEqual(await searchPinterest('actor statuses'), []);
  for (const [data, code] of [
    [[{ found: false, status: 'BLOCKED' }], 'PINTEREST_BLOCKED'],
    [[{ found: false, status: 'REQUEST_FAILED' }], 'PINTEREST_UPSTREAM'],
    [[{ found: false, status: 'BAD_FORMAT' }], 'PINTEREST_UPSTREAM'],
    [{ result: { results: [pin()] } }, 'PINTEREST_RESPONSE'],
    [[{ ...pin(), imageUrl: 'https://i.pinimg.com.attacker.test/image.jpg' }], 'PINTEREST_RESPONSE'],
    [[{ ...pin(), imageUrl: 'file:///etc/passwd' }], 'PINTEREST_RESPONSE'],
    [[{ ...pin(), pinId: Number.MAX_SAFE_INTEGER + 1 }], 'PINTEREST_RESPONSE'],
  ]) {
    rows = data;
    await assert.rejects(searchPinterest('actor statuses'), { code });
  }
});

test('recent searches reuse results and combine concurrent identical requests; expiry starts a fresh run', async t => {
  settings(t);
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(axios, 'post', async () => { calls++; return { data: [pin()] }; });
  const [a, b] = await Promise.all([searchPinterest('Cache Test'), searchPinterest('cache test')]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await searchPinterest('cache test');
  assert.equal(calls, 1);
  now += 30 * 60000;
  await searchPinterest('cache test');
  assert.equal(calls, 2);
});

test('disabled caching makes fresh requests, caps output, and token changes do not reuse old results', async t => {
  settings(t);
  process.env.APIFY_PINTEREST_MAX_PINS = '1';
  process.env.APIFY_PINTEREST_CACHE_MINUTES = '0';
  let calls = 0;
  t.mock.method(axios, 'post', async (url, body) => {
    assert.equal(body.maxResults, 1);
    calls++;
    return { data: [pin('101'), pin('102')] };
  });
  assert.equal((await searchPinterest('uncached query')).length, 1);
  await searchPinterest('uncached query');
  assert.equal(calls, 2);
  process.env.APIFY_PINTEREST_CACHE_MINUTES = '30';
  await searchPinterest('new credentials');
  process.env.APIFY_TOKEN = 'apify_api_other_test_only';
  await searchPinterest('new credentials');
  assert.equal(calls, 4);
});

test('cache size is bounded; the oldest query is evicted', async t => {
  settings(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => { calls++; return { data: [pin()] }; });
  for (let i = 0; i <= 50; i++) await searchPinterest(`evict-${i}`);
  await searchPinterest('evict-0');
  assert.equal(calls, 52);
});

test('timeouts do not automatically repeat a billable POST and errors have useful Apify guidance', async t => {
  settings(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); });
  await assert.rejects(searchPinterest('timeout query'), { code: 'ECONNABORTED' });
  assert.equal(calls, 1);
  assert.match(pinterestErrorMessage({ code: 'ECONNABORTED' }), /may still be running/);
  for (const [status, text] of [[401, /token/], [403, /actor access/], [402, /credits/], [429, /quota/]]) {
    assert.match(pinterestErrorMessage({ response: { status } }), text);
  }
});

function commandStore(t, failSend = false) {
  const records = [];
  const replies = [];
  t.mock.method(SentPin, 'find', filter => ({ select: async () => records.filter(doc => doc.chatId === filter.chatId && filter.pinId.$in.includes(doc.pinId)) }));
  t.mock.method(SentPin, 'create', async doc => { records.push(doc); });
  t.mock.method(MessageMedia, 'fromUrl', async url => ({ image: url }));
  const msg = (chatId = 'group@g.us') => ({
    getChat: async () => ({ id: { _serialized: chatId } }),
    reply: async (value, quote, options) => {
      if (failSend && (typeof value !== 'string' || value.startsWith('📌'))) throw new Error('send failed');
      replies.push({ value, options });
    },
  });
  return { records, replies, msg };
}

test('the Pinterest command sends one unseen image, reuses cached results, and deduplicates separately per chat', async t => {
  settings(t);
  const state = commandStore(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => { calls++; return { data: [pin('201'), pin('202')] }; });
  const args = ['command', 'test'];
  await search.pinterest({}, state.msg(), args);
  await search.pinterest({}, state.msg(), args);
  await search.pinterest({}, state.msg(), args);
  assert.equal(calls, 1);
  assert.equal(state.records.length, 2);
  assert.equal(new Set(state.records.map(doc => doc.pinId)).size, 2);
  assert.equal(state.replies.filter(item => item.options?.caption).length, 2);
  assert.match(state.replies.at(-1).value, /seen all recent/);
  await search.pinterest({}, state.msg('another-group@g.us'), args);
  assert.equal(state.records.length, 3);
  assert.equal(calls, 1);
});

test('failed media and link sends do not mark a pin as delivered', async t => {
  settings(t);
  const state = commandStore(t, true);
  t.mock.method(axios, 'post', async () => ({ data: [pin()] }));
  await search.pinterest({}, state.msg(), ['failed', 'delivery']);
  assert.equal(state.records.length, 0);
  assert.match(state.replies.at(-1).value, /search failed/);
});

test('provider failures log only status/code and never echo the token or response body', async t => {
  settings(t);
  const state = commandStore(t);
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  t.mock.method(axios, 'post', async () => { throw Object.assign(new Error('do not log this secret'), { response: { status: 403, data: process.env.APIFY_TOKEN } }); });
  await search.pinterest({}, state.msg(), ['provider', 'failure']);
  assert.match(logs.join('\n'), /status: 403/);
  assert.ok(!logs.join('\n').includes(process.env.APIFY_TOKEN));
  assert.ok(!logs.join('\n').includes('do not log this secret'));
});
