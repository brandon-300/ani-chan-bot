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

// ── Toggleable safeGetChat wrapper, installed for the same require-time-
// destructuring reason as resolveNameById above — reassigning
// helpers.safeGetChat later (e.g. mid-test) would be a silent no-op, since
// quiz.js's own `safeGetChat` binding is fixed at the moment it requires
// this module, not a live reference to this property. The wrapper itself
// is what gets captured, so its behavior can still be changed at any time
// by setting safeGetChatDelayMs — used by the "slow retry" test below.
let safeGetChatDelayMs = 0;
const realSafeGetChat = helpers.safeGetChat;
helpers.safeGetChat = async (msg, retries) => {
  if (safeGetChatDelayMs > 0) {
    await new Promise(r => setTimeout(r, safeGetChatDelayMs));
  }
  return realSafeGetChat(msg, retries);
};

const { quizGames, quiz, quitQuiz, tryHandleQuizAnswer, MIN_HUMAN_REACTION_MS } = require('./commands/games/quiz');

// Comfortably past MIN_HUMAN_REACTION_MS, used to backdate a question's
// startedAt so a normal/valid answer test doesn't itself get flagged as
// "arrived implausibly fast" — in this test file, with no real elapsed time
// between posting a question and answering it, every answer WOULD be
// implausibly fast unless we simulate a plausible gap having passed.
const PLAUSIBLE_DELAY_MS = MIN_HUMAN_REACTION_MS + 2000;
function age(session, ms = PLAUSIBLE_DELAY_MS) {
  session.current.startedAt -= ms;
}

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

function makeAnswerMsg(playerId, body, timestamp, quotedMessageId) {
  const cap = makeReplyCapture();
  const reacts = [];
  return {
    body,
    timestamp, // seconds since epoch, like a real WhatsApp message — optional, matches real usage
    hasQuotedMsg: quotedMessageId !== undefined,
    getQuotedMessage: async () => ({ id: { _serialized: quotedMessageId } }),
    reply: cap.reply,
    react: async (emoji) => { reacts.push(emoji); },
    getChat: async () => ({ id: { _serialized: CHAT_ID } }),
    getContact: async () => ({ id: { _serialized: playerId } }),
    _replies: cap.replies,
    _reacts: reacts,
  };
}

// Manual timer queue: setTimeout calls made by quiz.js are captured instead
// of actually scheduled, and flushOne() runs the single oldest one — lets
// the real handleTimeout -> advanceQuestion chain play out one deterministic
// step at a time instead of waiting on real 15-25s question timers.
function installFakeTimers() {
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const pending = [];
  global.setTimeout = (fn, ms, ...args) => { const t = { fn, args }; pending.push(t); return t; };
  global.clearTimeout = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  return {
    flushOne: async () => { const t = pending.shift(); if (t) await t.fn(...t.args); },
    restore: () => { global.setTimeout = real.setTimeout; global.clearTimeout = real.clearTimeout; },
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

  // From here on, every answer in this block is meant to look like a normal,
  // plausibly-timed reply, not a "just posted" one — age the question once.
  age(session);

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

  // Same player guessing again on the SAME question must be silently
  // swallowed by the quiz (not scored, not leaked to the AI-copilot
  // reply-to-bot fallback) — consumed=true with no new reaction/reply.
  const bobAgain = makeAnswerMsg('bob@c.us', String(session.current.correctPos + 1));
  const consumedAgain = await tryHandleQuizAnswer(fakeClient, bobAgain);
  assert.strictEqual(consumedAgain, true, 'a second guess on the same question by the same player must still be consumed by the quiz, just silently');
  assert.strictEqual(bobAgain._reacts.length, 0, 'a redundant second guess should get no reaction');
  assert.strictEqual(bobAgain._replies.length, 0, 'a redundant second guess should get no reply');
  assert.strictEqual(session.scores.get('bob@c.us').points, 0, 'ignored second guess must not award points');
  console.log('✅ 6. Second guess by the same player on the same question is silently consumed, not leaked elsewhere');

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
  // aren't exported, so a manual timer queue lets that real chain play out
  // deterministically instead of racing a real clock.
  const timers = installFakeTimers();
  let session2;
  try {
    const start2 = makeStartMsg(['start', 'easy']);
    await quiz(fakeClient, start2, ['start', 'easy']);
    session2 = quizGames.get(CHAT_ID);
    assert.strictEqual(session2.timeSeconds, 25, 'easy difficulty should use a 25s timer');

    for (let i = 0; i < 3; i++) {
      age(session2); // simulate a plausible reaction time to THIS question before answering it
      const wp = (session2.current.correctPos + 1) % 4;
      const eve = makeAnswerMsg('eve@c.us', String(wp + 1));
      await tryHandleQuizAnswer(fakeClient, eve);
      if (i < 2) {
        assert.ok(!/out of guesses/.test(eve._replies[0].content), `should not be eliminated yet at wrong #${i + 1}`);
        await timers.flushOne(); // this question's timeout -> handleTimeout
        await timers.flushOne(); // the 2s post-reveal delay -> advanceQuestion (sends the next question)
      } else {
        assert.ok(/out of guesses/.test(eve._replies[0].content), 'should be eliminated on the 3rd wrong guess');
      }
    }
  } finally {
    timers.restore();
  }
  assert.ok(session2.eliminated.has('eve@c.us'), 'eve should be marked eliminated after 3 wrong guesses');

  // Eliminated player's further guesses must still be consumed by the
  // quiz (not leaked to the AI-copilot fallback), just silently — no
  // reaction, no reply, no scoring. (Question was just aged above, so
  // this isn't also tripping the staleness path for an unrelated reason.)
  const eveAgain = makeAnswerMsg('eve@c.us', String(session2.current.correctPos + 1));
  const eveConsumed = await tryHandleQuizAnswer(fakeClient, eveAgain);
  assert.strictEqual(eveConsumed, true, 'eliminated player guesses must still be consumed by the quiz, just silently');
  assert.strictEqual(eveAgain._reacts.length, 0, 'an eliminated player\'s guess should get no reaction');
  assert.strictEqual(eveAgain._replies.length, 0, 'an eliminated player\'s guess should get no reply');
  console.log('✅ 11. Player is eliminated after 3 wrong guesses and silently consumed afterward, not leaked elsewhere');

  quitQuiz(CHAT_ID);

  // ── 9. A second player answering correctly right after the first ────────
  // must get an explicit "time's up" notice, not be leaked to the
  // AI-copilot fallback (this was the "second user picks the same correct
  // answer and gets treated as an error" symptom) and not silently ignored
  // either — once a question is resolved, replying to it should say so.
  const start3 = makeStartMsg(['start', 'normal']);
  await quiz(fakeClient, start3, ['start', 'normal']);
  const session3 = quizGames.get(CHAT_ID);
  age(session3);
  const correctBody3 = String(session3.current.correctPos + 1);

  const firstWinner = makeAnswerMsg('frank@c.us', correctBody3);
  assert.strictEqual(await tryHandleQuizAnswer(fakeClient, firstWinner), true);
  assert.strictEqual(firstWinner._reacts[0], '✅', 'first correct answer should win normally');
  assert.strictEqual(session3.scores.get('frank@c.us').points, 1);

  const secondSamePick = makeAnswerMsg('grace@c.us', correctBody3);
  const secondConsumed = await tryHandleQuizAnswer(fakeClient, secondSamePick);
  assert.strictEqual(secondConsumed, true, 'a second correct-looking answer after the question already resolved must still be consumed');
  assert.strictEqual(secondSamePick._reacts.length, 0, 'the second (too-late) correct pick should get no ✅/❌ reaction');
  assert.strictEqual(secondSamePick._replies.length, 1, 'the second (too-late) correct pick should get the "time\'s up" notice');
  assert.ok(/already been answered or moved on/.test(secondSamePick._replies[0].content), 'should explain the question is already over');
  assert.ok(!session3.scores.has('grace@c.us'), 'the too-late second answerer should not even get a score entry');
  console.log('✅ 12. A second player answering (even correctly) right after someone already won is told the question is already over, not leaked elsewhere');

  // ── 10. A reply arriving after the question's timer has already fired ───
  // must also get that same explicit notice ("once the time for one
  // question is over the question should not be able to be answered again"
  // — and if someone tries, they should be told why).
  const timers2 = installFakeTimers();
  try {
    await timers2.flushOne(); // the question's own timer fires -> handleTimeout
    assert.strictEqual(session3.current.resolved, true, 'question should be resolved once its timer fires');

    const lateReply = makeAnswerMsg('henry@c.us', correctBody3);
    const lateConsumed = await tryHandleQuizAnswer(fakeClient, lateReply);
    assert.strictEqual(lateConsumed, true, 'a reply after the question timed out must still be consumed, not fall through');
    assert.strictEqual(lateReply._reacts.length, 0, 'a post-timeout reply should get no ✅/❌ reaction');
    assert.strictEqual(lateReply._replies.length, 1, 'a post-timeout reply should get the "time\'s up" notice');
    assert.ok(/already been answered or moved on/.test(lateReply._replies[0].content), 'should explain the question is already over');
  } finally {
    timers2.restore();
  }
  console.log('✅ 13. A reply after the question timer has already fired is told plainly its time has passed, not leaked elsewhere');

  quitQuiz(CHAT_ID);

  // ── 11. A reply timestamped BEFORE the current question was posted ──────
  // must be treated as an answer to whatever OLDER question it actually
  // was sent during, not graded against the question that happens to be
  // showing by the time it's processed (the "bot says I picked a
  // character that wasn't even one of my options" bug — the reply was
  // really meant for the previous question, which had since advanced).
  const timers3 = installFakeTimers();
  let session4;
  try {
    const start4 = makeStartMsg(['start', 'normal']);
    await quiz(fakeClient, start4, ['start', 'normal']);
    session4 = quizGames.get(CHAT_ID);
    const q1StartedAt = session4.current.startedAt;
    assert.ok(typeof q1StartedAt === 'number', 'question should record when it was posted');

    await timers3.flushOne(); // Q1's timer fires -> handleTimeout
    await timers3.flushOne(); // the 2s post-reveal delay -> advanceQuestion (sends Q2)

    assert.strictEqual(session4.questionIndex, 1, 'should now be on Q2');
    assert.ok(session4.current.startedAt >= q1StartedAt, 'Q2 should be timestamped no earlier than Q1');

    // A reply timestamped a few seconds BEFORE Q1 was even posted — clearly
    // sent while some earlier state was showing, not meant for Q2 at all —
    // must be recognized as such rather than graded against Q2's options.
    const staleTimestampSec = Math.floor((q1StartedAt - 5000) / 1000);
    const staleReply = makeAnswerMsg('ivan@c.us', String(session4.current.correctPos + 1), staleTimestampSec);
    const staleConsumed = await tryHandleQuizAnswer(fakeClient, staleReply);
    assert.strictEqual(staleConsumed, true, 'a reply timestamped before the current question was posted must still be consumed');
    assert.strictEqual(staleReply._reacts.length, 0, 'a stale-timestamped reply should get no ✅/❌ reaction');
    assert.strictEqual(staleReply._replies.length, 1, 'a stale-timestamped reply should get the "time\'s up" notice');
    assert.ok(!session4.current.answered.has('ivan@c.us'), 'a stale reply should not mark the player as having answered the current question');
    console.log('✅ 14. A reply timestamped before the current question was posted is told its time has passed, not graded against the wrong question');
  } finally {
    timers3.restore();
  }

  // A reply timestamped normally (now, well after Q2 started, and with Q2
  // aged so it doesn't also trip the "implausibly fast" check) must still
  // work exactly as before — confirms the new checks don't break the
  // ordinary case where every real WhatsApp message has a timestamp.
  age(session4);
  const onTimeTimestampSec = Math.floor(Date.now() / 1000);
  const onTimeCorrectBody = String(session4.current.correctPos + 1);
  const onTimeReply = makeAnswerMsg('julia@c.us', onTimeCorrectBody, onTimeTimestampSec);
  const onTimeConsumed = await tryHandleQuizAnswer(fakeClient, onTimeReply);
  assert.strictEqual(onTimeConsumed, true);
  assert.strictEqual(onTimeReply._reacts[0], '✅', 'a normally-timestamped correct answer should still win as usual');
  console.log('✅ 15. A normally-timestamped reply (the real-world case) still works exactly as before');

  quitQuiz(CHAT_ID);

  // ── 12. A reply that explicitly quotes an OLDER question message ────────
  // must be recognized as such and told plainly that question's time has
  // passed — even when the digit it picked would coincidentally be
  // CORRECT for whatever question is active now (this is exactly the
  // screenshot case: replying "1" to Q3, which times out before it's
  // processed, and "1" happens to also be Q4's correct answer).
  const timers4 = installFakeTimers();
  try {
    const start5 = makeStartMsg(['start', 'normal']);
    await quiz(fakeClient, start5, ['start', 'normal']);
    const session5 = quizGames.get(CHAT_ID);
    const q1MessageId = session5.current.messageId;
    assert.ok(q1MessageId, 'the sent question message id should be recorded');

    await timers4.flushOne(); // Q1 times out
    await timers4.flushOne(); // advances to Q2

    assert.strictEqual(session5.questionIndex, 1, 'should now be on Q2');
    assert.notStrictEqual(session5.current.messageId, q1MessageId, 'Q2 should have a different message id than Q1');

    const q2CorrectBody = String(session5.current.correctPos + 1);
    const lateQuotedReply = makeAnswerMsg('karen@c.us', q2CorrectBody, undefined, q1MessageId);
    const lateQuotedConsumed = await tryHandleQuizAnswer(fakeClient, lateQuotedReply);
    assert.strictEqual(lateQuotedConsumed, true, 'a reply quoting an old question message must be consumed');
    assert.strictEqual(lateQuotedReply._reacts.length, 0, 'should get no ✅/❌ reaction, even if the digit is correct for the current question');
    assert.strictEqual(lateQuotedReply._replies.length, 1, 'should get exactly one reply: the "time\'s up for that question" notice');
    assert.ok(/already been answered or moved on/.test(lateQuotedReply._replies[0].content), 'the reply should explain the question has moved on');
    assert.ok(!session5.current.answered.has('karen@c.us'), 'must not be recorded as having answered the CURRENT question');
    assert.ok(!session5.scores.has('karen@c.us'), 'must not be scored at all');
  } finally {
    timers4.restore();
  }
  console.log('✅ 16. A reply quoting an older question message is told plainly its time has passed, never credited to the wrong question');

  quitQuiz(CHAT_ID);

  // ── 13. A slow chat-lookup retry must not mask a genuinely stale reply ──
  // safeGetChat has a built-in retry-with-backoff (utils/helpers.js) that
  // can itself take a couple of seconds on a shaky connection — if the
  // "arrived implausibly fast" check re-read the clock AFTER that delay
  // instead of using the moment the message actually came in, the delay
  // alone could push a genuinely-stale answer past the threshold and let
  // it slip through against the wrong question. This is the leading
  // suspect for how that kept happening even with the checks above in
  // place, and is what receivedAt (captured at the very top of
  // tryHandleQuizAnswer, before any of these lookups) fixes.
  const start6 = makeStartMsg(['start', 'normal']);
  await quiz(fakeClient, start6, ['start', 'normal']);
  const session6 = quizGames.get(CHAT_ID);
  try {
    safeGetChatDelayMs = MIN_HUMAN_REACTION_MS + 500; // simulate slow retries
    const rushedReply = makeAnswerMsg('leo@c.us', String(session6.current.correctPos + 1));
    const rushedConsumed = await tryHandleQuizAnswer(fakeClient, rushedReply);
    assert.strictEqual(rushedConsumed, true, 'must still be consumed');
    assert.strictEqual(rushedReply._reacts.length, 0, 'a genuinely-too-fast reply must not score just because a slow lookup delayed when we checked it');
    assert.strictEqual(rushedReply._replies.length, 1, 'should get the "time\'s up" notice, not be silently accepted');
  } finally {
    safeGetChatDelayMs = 0;
  }
  console.log('✅ 17. A slow chat-lookup retry does not mask an implausibly-fast (stale) reply as a valid one');

  quitQuiz(CHAT_ID);

  console.log('\n🎉 All quiz logic checks passed.');
}

main()
  .then(() => process.exit(0)) // some mock/helper in here can leave a handle open; exit explicitly once everything above has actually passed
  .catch(err => {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  });
