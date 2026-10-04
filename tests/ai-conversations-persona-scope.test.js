const test = require('node:test');
const assert = require('node:assert/strict');

// Separate file (separate process) because settings are read once at startup.
process.env.AI_PERSONA = 'marin';
process.env.OWNER_NUMBER = 'owner@c.us';
process.env.AI_HISTORY_EXPIRY_SCOPE = 'persona';
process.env.AI_HISTORY_EXPIRY_DAYS = '3';
process.env.AI_HISTORY_MESSAGES = '6';

const conversations = require('../utils/aiConversations');
const config = require('../utils/config');
const { install } = require('./helpers/fakeConversationStore');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const turn = (personaId, user) => conversations.appendConversationTurn({ chatId: 'u@c.us', senderId: 'u@c.us', personaId, userContent: user, assistantContent: 'ok' });

test('the settings are read from the environment', () => {
  assert.deepEqual([config.AI_HISTORY_EXPIRY_DAYS, config.AI_HISTORY_EXPIRY_SCOPE, config.AI_HISTORY_MESSAGES], [3, 'persona', 6]);
});

test('persona scope: only the persona you talked to is kept alive, and the window is configurable', async () => {
  const store = install();
  let now = T0;
  conversations._setClock(() => now);
  try {
    await turn('marin', 'm');
    await turn('karane', 'k');
    now += 2 * DAY;
    await turn('marin', 'm again');
    const marin = store.find('u@c.us', 'u@c.us', 'marin').expiresAt.getTime();
    const karane = store.find('u@c.us', 'u@c.us', 'karane').expiresAt.getTime();
    assert.equal(marin, T0 + 5 * DAY, 'Marin: 3 days after the latest Marin message');
    assert.equal(karane, T0 + 3 * DAY, 'Karane keeps its own, older deadline');

    now = T0 + 4 * DAY;
    store.sweep(now);
    assert.deepEqual(store.docs.map(d => d.personaId), ['marin'], 'Karane expired on its own schedule, Marin did not');

    for (let i = 0; i < 6; i += 1) await turn('marin', `q${i}`);
    assert.equal(store.find('u@c.us', 'u@c.us', 'marin').messages.length, 6, 'AI_HISTORY_MESSAGES is honoured');
  } finally {
    store.restore();
    conversations._setClock();
  }
});
