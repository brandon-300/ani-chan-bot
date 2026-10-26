const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildCommandMenu, commandReferenceForMessage } = require('../utils/commandMenu');
const { COMMAND_REFERENCE, OWNER_COMMAND_REFERENCE } = require('../utils/commandReference');

const ownerCommands = ['stats', 'users', 'deluser', 'stickeranalyze', 'stickerimport'];
const options = { botName: 'AniChan', prefix: '.', aliases: { bal: 'balance', inv: 'inventory' } };

function configureOwner(t) {
  const names = ['OWNER_NUMBER', 'OWNER_IDS', 'MOD_NUMBERS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.OWNER_NUMBER = 'owner@c.us';
  process.env.OWNER_IDS = 'owner-alias@lid';
  process.env.MOD_NUMBERS = 'moderator@c.us';
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

function assertOwnerVisibility(menu, visible) {
  for (const name of ownerCommands) {
    assert.equal(new RegExp(`(?:^|\\s)\\.${name}(?:\\s|$)`).test(menu), visible, name);
  }
  assert.equal(menu.includes('*🔐 OWNER 🔐*'), visible);
  assert.match(menu, /\.owner\n/, 'the public owner-contact command remains available');
  assert.match(menu, /\.balance \/ \.bal/, 'public aliases retain their formatting');
}

test('only configured owner IDs see owner commands in a private menu', t => {
  configureOwner(t);
  for (const from of ['owner@c.us', 'owner-alias@lid']) {
    assertOwnerVisibility(buildCommandMenu({ from }, options), true);
  }
  for (const from of ['member@c.us', 'moderator@c.us', 'unknown@lid']) {
    assertOwnerVisibility(buildCommandMenu({ from }, options), false);
  }
});

test('group menus stay public even for the owner or group admins', t => {
  configureOwner(t);
  for (const author of ['owner@c.us', 'owner-alias@lid', 'moderator@c.us', 'member@c.us']) {
    assertOwnerVisibility(buildCommandMenu({ from: 'group@g.us', author, isAdmin: true }, options), false);
  }
});

test('contact lookup, display names, and message content cannot impersonate the owner', t => {
  configureOwner(t);
  const spoof = {
    from: 'member@lid', notifyName: 'owner', body: 'OWNER_NUMBER=owner@c.us', isOwner: true,
    getContact() { throw new Error('menu identity must not use a potentially misresolved contact'); },
  };
  assertOwnerVisibility(buildCommandMenu(spoof, options), false);
  for (const msg of [{}, { from: 'status@broadcast', author: 'owner@c.us' }, { from: 'owner@c.us', fromMe: true }]) {
    assertOwnerVisibility(buildCommandMenu(msg, options), false);
  }
});

test('missing owner configuration hides restricted commands and configuration changes take effect', t => {
  configureOwner(t);
  delete process.env.OWNER_NUMBER;
  delete process.env.OWNER_IDS;
  assertOwnerVisibility(buildCommandMenu({ from: 'owner@c.us' }, options), false);
  process.env.OWNER_NUMBER = 'new-owner@c.us';
  assertOwnerVisibility(buildCommandMenu({ from: 'owner@c.us' }, options), false);
  assertOwnerVisibility(buildCommandMenu({ from: 'new-owner@c.us' }, options), true);
});

test('public reference and generated README omit owner tools, including descriptions', () => {
  const publicText = JSON.stringify(COMMAND_REFERENCE);
  const readme = fs.readFileSync(require.resolve('../README.md'), 'utf8');
  for (const name of ownerCommands) {
    assert.ok(!publicText.includes(`.${name}`), name);
    assert.ok(!readme.includes(`.${name}`), name);
  }
  for (const name of ownerCommands) assert.ok(JSON.stringify(OWNER_COMMAND_REFERENCE).includes(`.${name}`));
});

test('visible command counts exclude hidden tools without changing shared reference data', t => {
  configureOwner(t);
  const before = JSON.stringify(COMMAND_REFERENCE);
  const publicMenu = buildCommandMenu({ from: 'member@c.us' }, options);
  const ownerMenu = buildCommandMenu({ from: 'owner@c.us' }, options);
  const count = menu => Number(menu.match(/Commands: (\d+)/)[1]);
  assert.equal(count(ownerMenu) - count(publicMenu), ownerCommands.length);
  assert.equal(JSON.stringify(COMMAND_REFERENCE), before);
  assert.equal(commandReferenceForMessage({ from: 'member@c.us' }), COMMAND_REFERENCE);
});

test('the actual menu sender uses filtered content for image captions and text fallback', async t => {
  configureOwner(t);
  const index = fs.readFileSync(require.resolve('../index'), 'utf8');
  const start = index.indexOf('async function sendQuickMenu(msg) {');
  const end = index.indexOf('\n// The AI may request', start);
  assert.ok(start > 0 && end > start);
  for (const from of ['member@c.us', 'owner@c.us']) {
    for (const imageFails of [false, true]) {
      const sent = [];
      const msg = { from, reply: async (content, quotedId, sendOptions) => sent.push(sendOptions?.caption || content) };
      const context = {
        buildCommandMenu, BOT_NAME: 'AniChan', PREFIX: '.', aliases: options.aliases,
        MENU_IMAGE_URL: 'https://example.test/menu.jpg',
        client: { info: { wid: { _serialized: 'bot@c.us' } }, getProfilePicUrl: async () => null },
        MessageMedia: { fromUrl: async () => { if (imageFails) throw new Error('image unavailable'); return {}; } },
        console: { error() {} }, msg,
      };
      await vm.runInNewContext(`${index.slice(start, end)}\nsendQuickMenu(msg)`, context);
      assert.equal(sent.length, 1);
      assertOwnerVisibility(sent[0], from === 'owner@c.us');
    }
  }
});
