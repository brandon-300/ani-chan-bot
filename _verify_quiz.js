const assert = require('assert');

// ── Mock CardCatalogue.find(...).select(...).lean() ─────────────────────────
const { CardCatalogue } = require('./models/Card');
const FAKE_POOL = [
  { name: 'Tsubaki Sawabe', series: 'Shigatsu wa Kimi no Uso', imageUrl: 'https://example.com/1.jpg', tier: 'S' },
  { name: 'Meliodas', series: 'Nanatsu no Taizai', imageUrl: 'https://example.com/2.jpg', tier: 'SS' },
  { name: 'Sakamoto', series: 'Sakamoto Desu ga?', imageUrl: 'https://example.com/3.jpg', tier: 'A' },
  { name: 'Ganta Igarashi', series: 'Deadman Wonderland', imageUrl: 'https://example.com/4.jpg', tier: 'B' },
  { name: 'Kousei Arima', series: 'Shigatsu wa Kimi no Uso', imageUrl: 'https://example.com/5.jpg', tier: 'S' },
  { name: 'Elizabeth Liones', series: 'Nanatsu no Taizai', imageUrl: 'https://example.com/6.jpg', tier: 'SS' },
  { name: 'Duplicate Name', series: 'Some Anime', imageUrl: 'https://example.com/7.jpg', tier: 'C' },
  { name: 'duplicate name', series: 'Some Other Anime', imageUrl: 'https://example.com/8.jpg', tier: 'C' }, // should be deduped (case-insensitive)
];
CardCatalogue.find = () => ({
  select: () => ({
    lean: async () => FAKE_POOL,
  }),
});

// ── Mock MessageMedia.fromUrl so no real network call is attempted ──────────
const { MessageMedia } = require('whatsapp-web.js');
MessageMedia.fromUrl = async () => ({ mimetype: 'image/jpeg', data: 'FAKE', filename: 'x.jpg' });

// ── Mock resolveNameById so a new player's first guess doesn't hit the real
// (unreachable, in this offline test) MongoDB — quiz.js destructures this
// out of utils/helpers at require time, so the mock MUST be installed
// before requiring quiz.js below, or it'll capture the real function instead.
const helpers = require('./utils/helpers');
helpers.resolveNameById = async (client, id) => id.split('@')[0];

const { quizGames, quiz, quitQuiz, tryHandleQuizAnswer } = require('./commands/games/quiz');

const CHAT_ID = 'chat1@g.us';
const sentToChat = [];
const fakeClient = {
  sendMessage: async (chatId, content, opts) => {
    sentToChat.push({ chatId, content, opts });
    return { id: { _serialized: 'sent' + sentToChat.length } };
  },
};

function makeReplyCapture() {
  const replies = [];
  return {
    replies,
    reply: async (content, chatId, opts) => {
      replies.push({ content, opts });
      return { id: { _serialized: 'reply' + replies.length } };
    },
  };
}

function makeStartMsg(bodyArgs) {
  const cap = makeReplyCapture();
  return {
    body: '.quiz ' + bodyArgs.join(' '),
    reply: cap.reply,
    getChat: async () => ({ id: { _serialized: CHAT_ID } }),
    getContact: async () => ({ id: { _serialized: 'starter@c.us' } }),
    _replies: cap.replies,
  };
}

function makeAnswerMsg(playerId, body) {
  const cap = makeReplyCapture();
  const reacts = [];
  return {
    body,
    reply: cap.reply,
    react: async (emoji) => { reacts.push(emoji); },
    getChat: async () => ({ id: { _serialized: CHAT_ID } }),
    getContact: async () => ({ id: { _serialized: playerId } }),
    _replies: cap.replies,
    _reacts: reacts,
  };
}

async function main() {
  // ── 1. Start a hard-difficulty quiz ────────────────────────────────────
  const startMsg = makeStartMsg(['start', 'hard']);
  await quiz(fakeClient, startMsg, ['start', 'hard']);

  const session = quizGames.get(CHAT_ID);
  assert.ok(session, 'session should exist after starting');
  // FAKE_POOL has 7 distinct names after case-insensitive dedup (8 entries, 1 dup)
  assert.strictEqual(session.fullPool.length, 7, 'pool should be deduped to 7 distinct names');
  assert.strictEqual(session.questions.length, 7, 'question count should be min(10, poolSize) = 7');
  assert.strictEqual(session.questionIndex, 0, 'first question should be sent (index 0)');
  assert.ok(session.current, 'current question should be set');
  assert.strictEqual(session.current.options.length, 4, 'should have 4 options');
  assert.ok(session.current.correctPos >= 0 && session.current.correctPos < 4, 'correctPos should be a valid index');
  assert.strictEqual(startMsg._replies.length, 1, 'Q1 should be sent as a reply to the start message');
  console.log('✅ 1. Quiz starts correctly, Q1 sent as reply to .quiz start');

  // Hard mode: if the correct answer has a same-series sibling in the pool,
  // decoys should prefer it. Tsubaki/Kousei share a series, as do
  // Meliodas/Elizabeth — just sanity check decoys are drawn from the pool
  // and never equal the correct answer.
  const optNames = session.current.options.map(o => o.name.toLowerCase());
  const uniqueOptNames = new Set(optNames);
  assert.strictEqual(uniqueOptNames.size, 4, 'no duplicate option names in one question');
  console.log('✅ 2. No duplicate names among the 4 options');

  // ── 2. Second quiz-start attempt should be rejected (already active) ────
  const secondStart = makeStartMsg(['start']);
  await quiz(fakeClient, secondStart, ['start']);
  assert.strictEqual(secondStart._replies.length, 1);
  assert.ok(/already in progress/i.test(secondStart._replies[0].content));
  console.log('✅ 3. Second .quiz start while active is rejected');

  // ── 3. Bogus / out-of-range answers are ignored, not consumed ───────────
  const bogus1 = makeAnswerMsg('bob@c.us', 'hello');
  assert.strictEqual(await tryHandleQuizAnswer(fakeClient, bogus1), false, 'non-numeric body must not be consumed');

  const bogus2 = makeAnswerMsg('bob@c.us', '99');
  assert.strictEqual(await tryHandleQuizAnswer(fakeClient, bogus2), false, 'out-of-range option must not be consumed');
  console.log('✅ 4. Non-numeric / out-of-range messages are correctly ignored');

  // ── 4. A wrong guess ──────────────────────────────────────────────────
  const wrongPos = (session.current.correctPos + 1) % 4; // guaranteed wrong
  const bob = makeAnswerMsg('bob@c.us', String(wrongPos + 1));
  const consumed = await tryHandleQuizAnswer(fakeClient, bob);
  assert.strictEqual(consumed, true, 'a valid-range guess must be consumed');
  assert.strictEqual(bob._reacts[0], '❌', 'wrong guess should react ❌');
  assert.ok(/Wrong, \*bob@c.us\*/.test(bob._replies[0].content) === false); // name resolution fallback check below
  assert.ok(/Wrong answers: 1\/3/.test(bob._replies[0].content), 'wrong counter should read 1/3');
  assert.strictEqual(session.scores.get('bob@c.us').wrong, 1);
  assert.strictEqual(session.scores.get('bob@c.us').points, 0);
  assert.strictEqual(session.current.resolved, false, 'a wrong guess must NOT resolve the question');
  console.log('✅ 5. Wrong guess: reacts ❌, increments wrong count, question stays open');

  // Same player guessing again on the SAME question must be ignored (one guess/question)
  const bobAgain = makeAnswerMsg('bob@c.us', String(session.current.correctPos + 1));
  const consumedAgain = await tryHandleQuizAnswer(fakeClient, bobAgain);
  assert.strictEqual(consumedAgain, false, 'a second guess on the same question by the same player must be ignored');
  assert.strictEqual(session.scores.get('bob@c.us').points, 0, 'ignored second guess must not award points');
  console.log('✅ 6. Second guess by the same player on the same question is ignored');

  // ── 5. A correct guess from a different player wins the question ────────
  const correctBody = String(session.current.correctPos + 1);
  const alice = makeAnswerMsg('alice@c.us', correctBody);
  const questionIndexBefore = session.questionIndex;
  const consumedCorrect = await tryHandleQuizAnswer(fakeClient, alice);
  assert.strictEqual(consumedCorrect, true);
  assert.strictEqual(alice._reacts[0], '✅', 'correct guess should react ✅');
  assert.ok(/got it first/.test(alice._replies[0].content));
  assert.strictEqual(session.scores.get('alice@c.us').points, 1);
  assert.strictEqual(session.current.resolved, true, 'question should now be resolved');
  console.log('✅ 7. Correct guess: reacts ✅, awards a point, resolves the question');

  // Next question is scheduled via setTimeout(2000ms) — wait for it.
  await new Promise(r => setTimeout(r, 2300));
  assert.strictEqual(session.questionIndex, questionIndexBefore + 1, 'quiz should have advanced to the next question');
  assert.strictEqual(sentToChat.length, 1, 'Q2 should be sent as a fresh chat message (not a reply)');
  console.log('✅ 8. Quiz auto-advances to Q2 as a fresh message after a correct answer');

  // ── 6. .quiz stop ends early and reports the scoreboard ─────────────────
  const stopMsg = makeAnswerMsg('starter@c.us', ''); // reuse shape, body irrelevant for stop
  stopMsg.body = '.quiz stop';
  await quiz(fakeClient, stopMsg, ['stop']);
  assert.ok(!quizGames.has(CHAT_ID), 'session should be gone after .quiz stop');
  assert.ok(/Quiz stopped early/.test(stopMsg._replies[0].content));
  assert.ok(/alice@c\.us/.test(stopMsg._replies[0].content) === false); // name should resolve via resolveNameById fallback (raw id minus domain)
  console.log('✅ 9. .quiz stop tears down the session and reports a scoreboard');

  // ── 7. quitQuiz() returns null when there's nothing to quit ─────────────
  assert.strictEqual(quitQuiz(CHAT_ID), null, 'quitQuiz should return null with no active quiz');
  console.log('✅ 10. quitQuiz() no-ops cleanly when nothing is active');

  // ── 8. Elimination after 3 wrong guesses (fresh quiz) ────────────────────
  // A wrong guess does NOT resolve its question (only a correct guess or the
  // timeout does — see quiz.js), so exercising 3 wrong guesses for real means
  // living through 3 separate question timeouts. advanceQuestion/handleTimeout
  // aren't exported, so rather than reimplementing them here, we temporarily
  // swap in a manual timer queue: setTimeout calls made by quiz.js during this
  // block are captured instead of actually scheduled, and flushOne() runs the
  // single oldest one — letting the real handleTimeout -> advanceQuestion
  // chain play out one deterministic step at a time instead of racing a
  // shortened real clock (which previously let a whole quiz's worth of
  // questions cascade past before a single answer could be sent).
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const pending = [];
  global.setTimeout = (fn, ms, ...args) => { const t = { fn, args }; pending.push(t); return t; };
  global.clearTimeout = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  async function flushOne() {
    const t = pending.shift();
    if (t) await t.fn(...t.args);
  }

  let session2;
  try {
    const start2 = makeStartMsg(['start', 'easy']);
    await quiz(fakeClient, start2, ['start', 'easy']);
    session2 = quizGames.get(CHAT_ID);
    assert.strictEqual(session2.timeSeconds, 25, 'easy difficulty should use a 25s timer');

    for (let i = 0; i < 3; i++) {
      const wp = (session2.current.correctPos + 1) % 4;
      const eve = makeAnswerMsg('eve@c.us', String(wp + 1));
      await tryHandleQuizAnswer(fakeClient, eve);
      if (i < 2) {
        assert.ok(!/out of guesses/.test(eve._replies[0].content), `should not be eliminated yet at wrong #${i + 1}`);
        await flushOne(); // this question's timeout -> handleTimeout
        await flushOne(); // the 2s post-reveal delay -> advanceQuestion (sends the next question)
      } else {
        assert.ok(/out of guesses/.test(eve._replies[0].content), 'should be eliminated on the 3rd wrong guess');
      }
    }
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
  assert.ok(session2.eliminated.has('eve@c.us'), 'eve should be marked eliminated after 3 wrong guesses');

  // Eliminated player's further guesses must be silently ignored.
  const eveAgain = makeAnswerMsg('eve@c.us', String(session2.current.correctPos + 1));
  const eveConsumed = await tryHandleQuizAnswer(fakeClient, eveAgain);
  assert.strictEqual(eveConsumed, false, 'eliminated player guesses must be ignored');
  console.log('✅ 11. Player is eliminated after 3 wrong guesses and ignored afterward');

  // Clean up session2's pending timer so the process can exit.
  quitQuiz(CHAT_ID);

  console.log('\n🎉 All quiz logic checks passed.');
}

main().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
