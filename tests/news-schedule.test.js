const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const BotState = require('../models/BotState');
const SentNews = require('../models/SentNews');
const delivery = require('../utils/newsDelivery');
const config = require('../utils/config');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function setup(t, at) {
  let now = Date.parse(at);
  // Scope the clock to this module; leave Node's test-runner clock untouched.
  class FixtureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const originalDelay = config.NEWS_SEND_DELAY_MS;
  config.NEWS_SEND_DELAY_MS = 0;
  const modulePath = require.resolve('../commands/news');
  t.after(() => {
    config.NEWS_SEND_DELAY_MS = originalDelay;
  });
  const state = {
    hour: null,
    feedCalls: 0,
    dbReads: 0,
    chatReads: 0,
    attempts: 0,
    sent: [],
    seen: [],
    claimed: new Set(),
    fail: false,
  };
  t.mock.method(BotState, 'findOne', async () => {
    state.dbReads++;
    return { value: state.hour };
  });
  t.mock.method(BotState, 'findOneAndUpdate', async (filter, update) => {
    state.hour = update.value;
  });
  t.mock.method(SentNews, 'find', () => ({ select: async () => state.seen }));
  t.mock.method(SentNews, 'create', async (row) => {
    state.seen.push(row);
  });
  t.mock.method(delivery, 'deliverOnce', async (key, send) => {
    if (state.claimed.has(key)) return false;
    await send();
    state.claimed.add(key);
    return true;
  });
  t.mock.method(require('../utils/helpers'), 'isAdmin', async () => true);
  t.mock.method(axios, 'get', async () => {
    state.feedCalls++;
    return {
      data: '<rss><channel><item><title>Anime season announced</title><link>https://example.test/one</link></item><item><title>Anime movie announced</title><link>https://example.test/two</link></item></channel></rss>',
    };
  });
  const chat = {
    isGroup: true,
    id: { _serialized: 'news@g.us' },
    sendMessage: async (text) => {
      state.attempts++;
      if (state.fail) throw Error('injected WhatsApp failure');
      state.sent.push(text);
    },
  };
  const client = {
    getChats: async () => {
      state.chatReads++;
      return [chat];
    },
  };
  const source = fs.readFileSync(modulePath, 'utf8');
  const compile = vm.compileFunction(
    source,
    ['exports', 'require', 'module', '__filename', '__dirname', 'Date'],
    { filename: modulePath }
  );
  const load = () => {
    const mod = { exports: {} };
    compile(
      mod.exports,
      createRequire(modulePath),
      mod,
      modulePath,
      path.dirname(modulePath),
      FixtureDate
    );
    return mod.exports;
  };
  return {
    state,
    client,
    chat,
    load,
    setTime: (at) => {
      now = Date.parse(at);
    },
  };
}

test('6:30 PM WAT startup and later minute ticks perform no automatic news work', async (t) => {
  const fixture = setup(t, '2026-10-27T17:30:00Z');
  for (const at of ['17:30:00', '17:31:00', '17:59:59', '18:01:00']) {
    fixture.setTime(`2026-10-27T${at}Z`);
    await fixture.load()._maybeSendDailyNews(fixture.client); // fresh module simulates restart
  }
  assert.equal(fixture.state.feedCalls, 0);
  assert.equal(fixture.state.dbReads, 0);
  assert.equal(fixture.state.chatReads, 0);
  assert.equal(fixture.state.attempts, 0);
});

test('automatic news sends on the hour and stays deduplicated after restart', async (t) => {
  const { state, client, load, setTime } = setup(t, '2026-10-27T18:00:00Z'); // 7 PM WAT
  await load()._maybeSendDailyNews(client);
  assert.equal(state.sent.length, 1);
  assert.equal(state.hour, '2026-10-27T18');
  const reads = state.feedCalls;
  setTime('2026-10-27T18:00:40Z');
  await load()._maybeSendDailyNews(client);
  assert.equal(state.sent.length, 1);
  assert.equal(state.feedCalls, reads);
  setTime('2026-10-27T18:30:00Z');
  await load()._maybeSendDailyNews(client);
  assert.equal(state.sent.length, 1);
  setTime('2026-10-27T19:00:00Z'); // 8 PM WAT
  await load()._maybeSendDailyNews(client);
  assert.equal(state.sent.length, 2);
  assert.notEqual(state.sent[0], state.sent[1]);
});

test('failed automatic sends wait until the next hour instead of retrying each minute', async (t) => {
  const { state, client, load, setTime } = setup(t, '2026-10-27T18:00:00Z');
  state.fail = true;
  await load()._maybeSendDailyNews(client);
  assert.equal(state.attempts, 1);
  const reads = state.feedCalls;
  for (const minute of ['01', '02', '30', '59']) {
    setTime(`2026-10-27T18:${minute}:00Z`);
    await load()._maybeSendDailyNews(client);
  }
  assert.equal(state.attempts, 1);
  assert.equal(state.feedCalls, reads);
  state.fail = false;
  setTime('2026-10-27T19:00:00Z');
  await load()._maybeSendDailyNews(client);
  assert.equal(state.sent.length, 1);
});

test('an admin can still request manual news at 6:30 PM WAT', async (t) => {
  const { state, client, chat, load } = setup(t, '2026-10-27T17:30:00Z');
  const replies = [];
  await load().news(
    client,
    {
      getChat: async () => chat,
      getContact: async () => ({ id: { _serialized: 'admin-fixture' } }),
      react: async () => {},
      reply: async (text) => replies.push(text),
    },
    []
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0], /ANIME NEWS UPDATE/);
  assert.equal(state.seen.length, 1);
  assert.equal(state.hour, null);
});
