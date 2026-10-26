const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Receipt = require('../models/EconomyReceipt');
const { CardCatalogue, OwnedCard } = require('../models/Card');
const { parseAmount } = require('../utils/helpers');
const { parseWager, settleWager } = require('../utils/wager');
const { donateCoins, openCardPack } = require('../utils/economyTransactions');
const gamble = require('../commands/gamble');

function patch(t, object, key, value) { t.mock.method(object, key, value); }
function message() {
  const replies = [];
  return { replies, getContact: async () => ({ id: { _serialized: 'sender' } }), reply: async value => replies.push(value) };
}
function wallet(t, coins = 1000) {
  const state = { coins, writes: 0 };
  patch(t, User, 'findOrCreate', async () => ({ coins: state.coins }));
  patch(t, User, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.id, 'sender');
    if (state.coins < filter.coins.$gte || state.coins > filter.coins.$lte) return null;
    state.coins += update.$inc.coins;
    state.writes++;
    return { coins: state.coins };
  });
  return state;
}

test('money parsers reject overflow, non-finite input, negatives and partial wager parses', () => {
  for (const input of ['-1000', '0', 'Infinity', 'NaN', '100x', '1.5', '', '9007199254740992']) assert.equal(parseWager(input), null, input);
  assert.equal(parseWager(undefined, 100), 100);
  assert.equal(parseWager('100'), 100);
  assert.equal(parseWager('180143985094820', undefined, 1, 50), null);
  assert.equal(parseAmount('9007199254740992'), null);
  assert.equal(parseAmount('9007199254740991.1'), null);
  assert.equal(parseAmount('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseAmount('9007199254b'), null);
  assert.equal(parseAmount('0.1'), null);
  assert.equal(parseAmount('1.2m'), 1200000);
});

for (const command of ['slots', 'cf', 'dice', 'db', 'dp', 'roulette', 'horse']) {
  test(`${command}: malformed/negative wagers cannot roll or change the wallet`, async t => {
    const state = wallet(t);
    patch(t, Math, 'random', () => { throw new Error('invalid input rolled'); });
    for (const input of ['-1000', '0', '1.5', '100junk', 'Infinity', '9007199254740992']) {
      const msg = message();
      await gamble[command]({}, msg, command === 'horse' ? ['1', input] : [input]);
      assert.equal(msg.replies.length, 1);
    }
    assert.equal(state.coins, 1000);
    assert.equal(state.writes, 0);
  });
}

test('dice losses debit a positive stake; draws preserve the balance', async t => {
  const state = wallet(t);
  let rolls = [0, 0.99];
  patch(t, Math, 'random', () => rolls.shift());
  await gamble.dice({}, message(), ['100']);
  assert.equal(state.coins, 900);
  rolls = [0.5, 0.5];
  await gamble.dice({}, message(), ['100']);
  assert.equal(state.coins, 900);
});

test('horse losing and winning stakes settle once with the advertised gross payout', async t => {
  const state = wallet(t);
  let rolls = [0, 0.99, 0, 0, 0];
  patch(t, Math, 'random', () => rolls.shift());
  await gamble.horse({}, message(), ['1', '100']);
  assert.equal(state.coins, 900);
  rolls = [0.99, 0, 0, 0, 0];
  await gamble.horse({}, message(), ['1', '100']);
  assert.equal(state.coins, 1000);
  assert.equal(state.writes, 2);
});

test('roulette pays standard net winnings and handles zero and invalid bets', async t => {
  const state = wallet(t);
  let spin = 7;
  patch(t, Math, 'random', () => (spin + 0.1) / 37);
  for (const [bet, number, gain] of [['red', 7, 100], ['black', 2, 100], ['even', 2, 100], ['odd', 7, 100], ['red', 0, -100], ['even', 0, -100], ['0', 0, 3500], ['36', 36, 3500]]) {
    spin = number;
    const before = state.coins;
    await gamble.roulette({}, message(), ['100', bet]);
    assert.equal(state.coins, before + gain, `${bet} on ${number}`);
  }
  const before = state.coins;
  for (const bet of ['37', '-1', '7oops']) await gamble.roulette({}, message(), ['100', bet]);
  assert.equal(state.coins, before);
});

test('simultaneous settlements cannot spend the same funds or overflow a wallet', async t => {
  const state = wallet(t, 100);
  const results = await Promise.all([settleWager('sender', 100, -100), settleWager('sender', 100, -100)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(state.coins, 0);
  state.coins = Number.MAX_SAFE_INTEGER;
  assert.equal(await settleWager('sender', 1, 1), null);
  await assert.rejects(settleWager('sender', -1, 100));
});

// A transaction adapter with rollback lets command tests inject failures at
// individual writes. This checks application failure handling, not a live DB.
function transactionStore(t) {
  const state = { users: { sender: { coins: 1000 }, receiver: { coins: 100 } }, receipts: {}, cards: [], packs: 1, failCredit: false, failCardAt: 0 };
  const session = {
    async withTransaction(fn) {
      const before = structuredClone(state);
      try { await fn(); } catch (err) { Object.assign(state, before); throw err; }
    }, async endSession() {},
  };
  patch(t, mongoose, 'startSession', async () => session);
  patch(t, Receipt, 'init', async () => {});
  patch(t, Receipt, 'findById', id => ({ session: async s => { assert.equal(s, session); return state.receipts[id] || null; } }));
  patch(t, Receipt, 'create', async ([doc], options) => { assert.equal(options.session, session); state.receipts[doc._id] = doc; return [doc]; });
  patch(t, User, 'updateOne', async (filter, update, options) => {
    assert.equal(options.session, session);
    if (filter.id === 'receiver' && state.failCredit) throw new Error('injected credit failure');
    const user = state.users[filter.id];
    if (!user || user.coins < (filter.coins.$gte ?? 0) || user.coins > (filter.coins.$lte ?? Number.MAX_SAFE_INTEGER)) return { matchedCount: 0 };
    user.coins += update.$inc.coins;
    return { matchedCount: 1 };
  });
  patch(t, User, 'findOne', () => ({ session: async () => ({ inventory: Array(state.packs).fill('Card Pack'), async save(options) { assert.equal(options.session, session); state.packs = this.inventory.length; } }) }));
  patch(t, CardCatalogue, 'aggregate', () => ({ session: async () => state.picks || [1, 2, 3].map(i => ({ cardId: `CARD0${i}`, name: `Card ${i}`, tier: 'C', series: 'Test' })) }));
  patch(t, OwnedCard, 'findOne', async () => null);
  patch(t, OwnedCard, 'create', async ([doc], options) => {
    assert.equal(options.session, session);
    if (state.failCardAt === state.cards.length + 1) throw new Error('injected card failure');
    assert.ok(doc.code);
    assert.equal(doc.firstOwner, 'sender');
    state.cards.push(doc);
    return [doc];
  });
  return state;
}

const donation = { senderId: 'sender', receiverId: 'receiver', amount: 100, messageId: 'm1' };

test('donations reject self-transfers, roll back credit failure, and commit exactly once per message', async t => {
  const state = transactionStore(t);
  await assert.rejects(donateCoins({ ...donation, receiverId: 'sender' }), /yourself/);
  state.failCredit = true;
  await assert.rejects(donateCoins(donation), /injected credit failure/);
  assert.equal(state.users.sender.coins, 1000);
  assert.deepEqual(state.receipts, {});
  state.failCredit = false;
  await donateCoins(donation);
  await donateCoins(donation);
  assert.deepEqual(state.users, { sender: { coins: 900 }, receiver: { coins: 200 } });
  await assert.rejects(donateCoins({ ...donation, amount: 200 }), /different transfer/);
});

test('donations roll back an unaffordable or overflowing transfer', async t => {
  const state = transactionStore(t);
  await assert.rejects(donateCoins({ ...donation, amount: 1001 }), /Not enough/);
  state.users.receiver.coins = Number.MAX_SAFE_INTEGER;
  await assert.rejects(donateCoins(donation), /wallet limit/);
  assert.equal(state.users.sender.coins, 1000);
  assert.deepEqual(state.receipts, {});
});

test('Card Packs grant three coded cards and consume exactly one pack', async t => {
  const state = transactionStore(t);
  const gained = await openCardPack('sender');
  assert.equal(gained.length, 3);
  assert.equal(state.cards.length, 3);
  assert.equal(state.packs, 0);
  await assert.rejects(openCardPack('sender'), /not in inventory/);
});

test('Card Packs retain the pack and roll back all grants on shortage or a mid-grant failure', async t => {
  const state = transactionStore(t);
  state.picks = [];
  await assert.rejects(openCardPack('sender'), /Fewer than 3/);
  delete state.picks;
  state.failCardAt = 2;
  await assert.rejects(openCardPack('sender'), /injected card failure/);
  assert.equal(state.packs, 1);
  assert.deepEqual(state.cards, []);
});
