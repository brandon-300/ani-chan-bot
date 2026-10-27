const test = require('node:test');
const assert = require('node:assert/strict');
const uno = require('../commands/games/unoEngine');
const base = (players = ['a', 'b', 'c']) => ({
  phase: 'playing',
  players: players.map((id) => ({ id, name: id })),
  hands: Object.fromEntries(
    players.map((id) => [
      id,
      [
        { color: 'red', value: '1' },
        { color: 'blue', value: '2' },
      ],
    ])
  ),
  turn: 0,
  direction: 1,
  color: 'red',
  deck: [
    { color: 'blue', value: '4' },
    { color: 'green', value: '5' },
    { color: 'yellow', value: '3' },
    { color: 'blue', value: '1' },
  ],
  discard: [{ color: 'red', value: '5' }],
  drawn: false,
  missedUno: null,
});
test('UNO deck has 108 cards and deals seven privately without losing cards', () => {
  const game = uno.start([{ id: 'a' }, { id: 'b' }], () => 0.5);
  assert.equal(uno.deck().length, 108);
  assert.equal(game.hands.a.length, 7);
  assert.equal(game.hands.b.length, 7);
  assert.equal(
    game.deck.length + game.discard.length + game.hands.a.length + game.hands.b.length,
    108
  );
});
test('UNO draw-two is immediate, skips the victim, and has no stacking window', () => {
  const g = base();
  g.hands.a[0] = { color: 'red', value: '+2' };
  uno.play(g, 'a', 0, null, true);
  assert.equal(g.hands.b.length, 4);
  assert.equal(g.players[g.turn].id, 'c');
  assert.throws(() => uno.play(g, 'b', 0), /not your turn/);
});
test('UNO reverse changes direction; with two players it returns the turn', () => {
  const g = base();
  g.hands.a[0] = { color: 'red', value: 'reverse' };
  uno.play(g, 'a', 0, null, true);
  assert.equal(g.players[g.turn].id, 'c');
  const pair = base(['a', 'b']);
  pair.hands.a[0] = { color: 'red', value: 'reverse' };
  uno.play(pair, 'a', 0, null, true);
  assert.equal(pair.turn, 0);
});
test('UNO wild colors and draw-four legality are enforced before changing state', () => {
  const g = base();
  g.hands.a = [
    { color: 'wild', value: '+4' },
    { color: 'red', value: '3' },
  ];
  assert.throws(() => uno.play(g, 'a', 0, 'blue'), /cannot be played/);
  assert.equal(g.hands.a.length, 2);
  g.hands.a[1] = { color: 'green', value: '3' };
  assert.throws(() => uno.play(g, 'a', 0), /Choose red/);
  uno.play(g, 'a', 0, 'blue', true);
  assert.equal(g.color, 'blue');
  assert.equal(g.hands.b.length, 6);
});
test('UNO drawing allows only the drawn card; pass cannot skip a free turn', () => {
  const g = base();
  assert.throws(() => uno.pass(g, 'a'), /Draw a card first/);
  g.deck = [{ color: 'red', value: '7' }];
  uno.draw(g, 'a');
  assert.equal(g.drawn, true);
  assert.throws(() => uno.play(g, 'a', 0), /only the new card/);
  uno.pass(g, 'a');
  assert.equal(g.turn, 1);
});
test('UNO catch applies two cards only inside the missed-call window', () => {
  const g = base();
  uno.play(g, 'a', 0);
  assert.equal(g.missedUno, 'a');
  uno.catchUno(g, 'b', 'a');
  assert.equal(g.hands.a.length, 3);
  assert.equal(g.missedUno, null);
  assert.throws(() => uno.catchUno(g, 'c', 'a'), /Nobody eligible/);
});
test('UNO final card declares a winner and later moves are rejected', () => {
  const g = base();
  g.hands.a = [{ color: 'red', value: '1' }];
  uno.play(g, 'a', 0);
  assert.equal(g.winner, 'a');
  assert.equal(g.phase, 'finished');
  assert.throws(() => uno.draw(g, 'a'), /not your turn/);
});
test('UNO reshuffles discards while retaining the face-up top card', () => {
  const g = base();
  g.deck = [];
  g.discard = [
    { color: 'green', value: '3' },
    { color: 'red', value: '5' },
  ];
  uno.draw(g, 'a');
  assert.equal(g.discard.length, 1);
  assert.equal(g.discard[0].value, '5');
  assert.equal(g.hands.a.length, 3);
});
test('purge attempts only eligible recent messages and reports partial failures', async () => {
  const { purgeMessages } = require('../utils/purgeMessages');
  let deleted = [];
  const message = (id, time) => ({
    id: { _serialized: id },
    timestamp: time,
    delete: async (everyone) => {
      assert.equal(everyone, true);
      if (id === 'fail') throw Error('offline');
      deleted.push(id);
    },
  });
  const all = [
    message('old', 1),
    message('ineligible', 2),
    message('fail', 3),
    message('ok', 4),
    message('command', 5),
  ];
  const chat = {
    fetchMessages: async (options) => {
      assert.equal(options.limit, 5);
      return all;
    },
  };
  const client = { pupPage: { evaluate: async (fn, id) => id !== 'ineligible' } };
  const result = await purgeMessages(client, chat, { id: { _serialized: 'command' } }, 4);
  assert.deepEqual(deleted, ['ok', 'old']);
  assert.deepEqual(result, { requested: 4, sent: 2, skipped: 1, failed: 1 });
});
test('scheduler lookup failures keep a polling timer and recover on a later tick', async (t) => {
  const scheduler = require('../utils/scheduler');
  const Task = require('../models/ScheduledTask');
  const timers = [];
  let lookups = 0;
  t.mock.method(global, 'setTimeout', (fn, delay) => {
    timers.push({ fn, delay });
    return { unref() {} };
  });
  t.mock.method(Task, 'find', async () => []);
  t.mock.method(Task, 'findOne', () => ({
    sort: async () => {
      if (++lookups === 1) throw Error('injected lookup outage');
      return null;
    },
  }));
  await scheduler.init({});
  assert.equal(timers.at(-1).delay, 30000);
  timers.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 2);
  assert.equal(timers.at(-1).delay, 30000);
  scheduler._stop();
});
test('turn deadlines survive restoring the same turn and change only on a turn change', () => {
  const runtime = require('../utils/gameRuntime');
  const game = { mode: 'pvp', deadlineTurn: 0, turnExpiresAt: 100 };
  runtime.deadline(game, 0);
  assert.equal(game.turnExpiresAt, 100);
  runtime.deadline(game, 1);
  assert.ok(game.turnExpiresAt >= Date.now() + 29000);
});
test('source ZIP exports omit credentials and runtime sessions but include the env template', (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anichan-export-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(
    path.join(dir, '.gitattributes'),
    fs.readFileSync(path.join(__dirname, '../.gitattributes'))
  );
  fs.writeFileSync(path.join(dir, '.env'), 'fixture only');
  fs.writeFileSync(path.join(dir, '.env.example'), 'EXAMPLE=');
  fs.writeFileSync(path.join(dir, 'index.js'), '// fixture');
  fs.mkdirSync(path.join(dir, '.wwebjs_auth'));
  fs.writeFileSync(path.join(dir, '.wwebjs_auth/session'), 'fixture session');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: dir }
  );
  const destination = path.join(dir, 'source.zip');
  require('../scripts/export-source').exportSource(dir, destination);
  const zip = fs.readFileSync(destination);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = zip.readUInt32LE(end + 16);
  const listing = [];
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    listing.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString());
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.ok(listing.includes('index.js'));
  assert.ok(listing.includes('.env.example'));
  assert.ok(!listing.includes('.env'));
  assert.ok(!listing.some((p) => p.startsWith('.wwebjs_auth')));
});
