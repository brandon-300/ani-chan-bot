const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../models/User');
const Group = require('../models/Group');
const Guild = require('../models/Guild');
const { CardCatalogue, OwnedCard } = require('../models/Card');

// Prevent post-claim rewards from accessing Mongo in isolated command tests.
require('../utils/helpers').addXP = async () => ({ levelUp: false });
require('../utils/achievements').checkAchievements = async () => [];
require('../utils/titles').checkTitle = async () => null;
const cards = require('../commands/cards');
const loan = require('../commands/loan');

function setup(t) {
  const state = {
    group: { id: 'group@g.us', cardsEnabled: true, activeCardCode: 'DROP01', activeCardId: 'CAT001', activeCardExpiresAt: new Date(Date.now() + 60000) },
    grants: [], transactions: 0, rejectConsume: false, failGrant: false,
  };
  const session = {
    async withTransaction(fn) {
      state.transactions++;
      const before = structuredClone({ group: state.group, grants: state.grants });
      try { await fn(); } catch (err) { Object.assign(state, before); throw err; }
    }, async endSession() {},
  };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(User, 'findOrCreate', async () => ({}));
  t.mock.method(Group, 'findOne', async () => structuredClone(state.group));
  t.mock.method(Group, 'updateOne', async (filter, update, options) => {
    assert.equal(options.session, session);
    assert.equal(filter.cardsEnabled, true);
    assert.equal(filter.activeCardId, 'CAT001');
    assert.equal(filter.activeCardCode, 'DROP01');
    assert.ok(filter.activeCardExpiresAt.$gt instanceof Date);
    if (state.rejectConsume) return { matchedCount: 0 };
    for (const key of Object.keys(update.$unset)) delete state.group[key];
    return { matchedCount: 1 };
  });
  const queryNull = () => ({ then(resolve, reject) { return Promise.resolve(null).then(resolve, reject); }, catch(fn) { return Promise.resolve(null).catch(fn); }, session: async () => null });
  t.mock.method(OwnedCard, 'findOne', queryNull);
  t.mock.method(CardCatalogue, 'findOne', async filter => {
    assert.equal(filter.cardId, 'CAT001');
    return { cardId: 'CAT001', name: 'Test Card', series: 'Test', tier: 'C' };
  });
  t.mock.method(OwnedCard, 'create', async ([doc], options) => {
    assert.equal(options.session, session);
    if (state.failGrant) throw new Error('injected grant failure');
    state.grants.push(doc);
    return [doc];
  });
  t.mock.method(Guild, 'addQuestProgress', async () => null);
  const replies = [];
  const msg = { getChat: async () => ({ id: { _serialized: 'group@g.us' }, isGroup: true }), getContact: async () => ({ id: { _serialized: 'user' }, pushname: 'User' }), reply: async text => replies.push(text) };
  return { state, msg, replies };
}

test('catalogue codes, disabled drops, expired drops, and missing drops cannot grant free cards', async t => {
  const { state, msg, replies } = setup(t);
  await cards.claim({}, msg, ['CAT001']);
  state.group.cardsEnabled = false;
  await cards.claim({}, msg, ['DROP01']);
  state.group.cardsEnabled = true;
  state.group.activeCardExpiresAt = new Date(Date.now() - 1);
  await cards.claim({}, msg, ['DROP01']);
  state.group = null;
  await cards.claim({}, msg, ['DROP01']);
  assert.equal(state.grants.length, 0);
  assert.equal(state.transactions, 0);
  assert.equal(replies.length, 4);
  assert.ok(replies.every(reply => /Invalid or expired/.test(reply)));
});

test('a replaced, disabled or expired drop inside the transaction cannot grant a card', async t => {
  const { state, msg, replies } = setup(t);
  state.rejectConsume = true;
  await cards.claim({}, msg, ['DROP01']);
  assert.equal(state.transactions, 1);
  assert.equal(state.grants.length, 0);
  assert.equal(state.group.activeCardCode, 'DROP01');
  assert.match(replies[0], /claimed, disabled, replaced, or expired/);
});

test('a failed grant rolls back drop consumption; a valid claim consumes the drop and grants one coded card', async t => {
  const { state, msg, replies } = setup(t);
  state.failGrant = true;
  await cards.claim({}, msg, ['DROP01']);
  assert.equal(state.group.activeCardCode, 'DROP01');
  assert.equal(state.grants.length, 0);
  state.failGrant = false;
  await cards.claim({}, msg, ['drop01']);
  assert.equal(state.group.activeCardCode, undefined);
  assert.equal(state.grants.length, 1);
  assert.equal(state.grants[0].firstOwner, 'user');
  assert.ok(state.grants[0].code);
  assert.match(replies.at(-1), /claimed/);
});

test('series searches treat regex operators literally and reject oversized input before querying', async t => {
  let searches = 0;
  t.mock.method(CardCatalogue, 'find', filter => {
    searches++;
    assert.ok(filter.series.test('(a+)+['));
    assert.ok(!filter.series.test('aaaaa'));
    return { sort: async () => [] };
  });
  const replies = [];
  const msg = { reply: async text => replies.push(text) };
  await cards.si({}, msg, ['(a+)+[']);
  await cards.si({}, msg, ['a'.repeat(101)]);
  assert.equal(searches, 1);
  assert.match(replies.at(-1), /100 characters/);
});

test('lent cards cannot be listed, including a lending race after the initial lookup', async t => {
  const { msg, replies } = setup(t);
  const card = { _id: 'card', ownerId: 'user', tier: 'C', name: 'Test', isLent: true };
  t.mock.method(OwnedCard, 'find', async () => [card]);
  let writes = 0;
  t.mock.method(OwnedCard, 'updateOne', async filter => {
    writes++;
    assert.equal(filter.ownerId, 'user');
    assert.deepEqual(filter.isLent, { $ne: true });
    assert.deepEqual(filter.isStaked, { $ne: true });
    return { matchedCount: 0 };
  });
  await cards.sellc({}, msg, ['1', '100']);
  assert.equal(writes, 0);
  assert.match(replies.at(-1), /currently lent/);
  card.isLent = false;
  await cards.sellc({}, msg, ['1', '100']);
  assert.equal(writes, 1);
  assert.match(replies.at(-1), /availability changed/);
});

test('loan requests cannot stake a card transferred to another user during the transaction', async t => {
  const { msg, replies } = setup(t);
  const card = { _id: 'card', ownerId: 'user', name: 'Test', tier: 'C' };
  t.mock.method(User, 'findOrCreate', async () => ({ loan: { active: false } }));
  t.mock.method(OwnedCard, 'find', async () => [card]);
  t.mock.method(OwnedCard, 'findById', () => ({ session: async () => ({ ...card, ownerId: 'other-user' }) }));
  t.mock.method(User, 'findOne', () => ({ session: async () => ({ _id: 'user', loan: { active: false } }) }));
  t.mock.method(OwnedCard, 'updateOne', async () => { throw new Error('must not stake another owner’s card'); });
  t.mock.method(User, 'updateOne', async () => { throw new Error('must not issue the loan'); });
  await loan.loan({}, msg, ['request', '100', '1']);
  assert.match(replies.at(-1), /no longer available to stake/);
});
