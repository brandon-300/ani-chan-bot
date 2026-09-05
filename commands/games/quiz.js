const { MessageMedia } = require('whatsapp-web.js');
const { CardCatalogue } = require('../../models/Card');
const { safeGetChat, safeGetQuotedMessage, safeGetContact, resolveNameById } = require('../../utils/helpers');
const { isChatBusy, claim, release } = require('./activeGame');
const Guild = require('../../models/Guild');
const { _formatQuestCompletionNote } = require('../guilds');

// ─── Active Quiz Sessions ───────────────────────────────────────────────────
// chatId -> {
//   chatId, client, origMsg,        // origMsg is the '.quiz start' message —
//                                    // kept so the final scoreboard can reply
//                                    // to it (matches the reference bot).
//   difficulty, timeSeconds,
//   fullPool,                       // deduped CardCatalogue entries available
//                                    // this round (used for decoys too)
//   questions,                      // the entries that will each be one
//                                    // question's correct answer, in order
//   questionIndex,                  // -1 until advanceQuestion() sends Q1
//   current: {
//     correct, options, correctPos, // options is an array of catalogue
//                                    // entries; correctPos is its 0-based
//                                    // index into options
//     answered,                     // Set of playerIds who already guessed
//                                    // (right or wrong) on THIS question —
//                                    // one guess per person per question
//     resolved,                     // true once someone's answered it
//                                    // correctly or time's run out
//     timer,                        // setTimeout handle for this question
//   } | null,
//   scores,                         // Map playerId -> { name, points, wrong }
//   eliminated,                     // Set of playerIds who hit
//                                    // MAX_WRONG_LIVES total wrong guesses
//                                    // this quiz and are sitting out the rest
// }
const quizGames = new Map();

const DIFFICULTY_KEYS = ['easy', 'normal', 'hard'];
const TOTAL_QUESTIONS = 10;
const NUM_OPTIONS = 4;
const MAX_WRONG_LIVES = 3;
const NEXT_QUESTION_DELAY_MS = 2000; // short pause so the reveal is readable before the next image lands
// A genuine answer to a BRAND NEW question can't physically arrive faster
// than this — reading an image plus four titled options, deciding, and
// typing/tapping a reply all take real time. Used as a floor in
// tryHandleQuizAnswer: a reply that shows up sooner than this after the
// current question started is almost certainly a delayed answer to the
// PREVIOUS question, not a superhuman-fast one to this one.
const MIN_HUMAN_REACTION_MS = 3000;
// How long after a new question starts we keep logging diagnostics for
// answers we can't positively confirm are fresh (no quote match, no usable
// timestamp) — see the comment on that logging below. Purely observational;
// does not change what gets accepted.
const STALE_ANSWER_WATCH_WINDOW_MS = 8000;

// easy: correct-answer pool is preferentially drawn from the catalogue's
// higher tiers (assumed to skew toward more recognizable/major characters —
// there's no separate "popularity" field to go on, so this is a reasonable
// stand-in rather than a guaranteed signal).
// hard: no tier preference for which characters get asked, but decoys are
// preferentially drawn from the SAME anime as the correct answer, which is
// what actually makes a multiple-choice quiz harder to guess by elimination.
const DIFFICULTY_SETTINGS = {
  easy: { timeSeconds: 25, tierPool: ['S', 'SS', 'SSS'], hardDecoys: false },
  normal: { timeSeconds: 20, tierPool: null, hardDecoys: false },
  hard: { timeSeconds: 15, tierPool: null, hardDecoys: true },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks which catalogue entries will each be one question's correct answer,
// preferring `settings.tierPool` (easy mode) when there are enough of them,
// and topping up with the rest of the pool otherwise so a quiz never comes
// up short just because the catalogue doesn't have many high-tier cards yet.
function pickQuestionEntries(fullPool, settings, count) {
  if (!settings.tierPool) return shuffle(fullPool).slice(0, count);

  const preferred = fullPool.filter(c => settings.tierPool.includes(c.tier));
  if (preferred.length >= count) return shuffle(preferred).slice(0, count);

  const rest = fullPool.filter(c => !settings.tierPool.includes(c.tier));
  return [...shuffle(preferred), ...shuffle(rest)].slice(0, count);
}

// Picks NUM_OPTIONS-1 wrong answers for `correctEntry`. In hard mode, prefers
// other characters from the same anime (falls back to the wider pool if that
// anime doesn't have enough other catalogued characters yet).
function pickDecoys(fullPool, correctEntry, settings) {
  const correctKey = correctEntry.name.trim().toLowerCase();
  const candidates = fullPool.filter(c => c.name.trim().toLowerCase() !== correctKey);

  if (settings.hardDecoys) {
    const sameSeries = candidates.filter(c => c.series === correctEntry.series);
    if (sameSeries.length >= NUM_OPTIONS - 1) {
      return shuffle(sameSeries).slice(0, NUM_OPTIONS - 1);
    }
    const rest = candidates.filter(c => c.series !== correctEntry.series);
    return [...shuffle(sameSeries), ...shuffle(rest)].slice(0, NUM_OPTIONS - 1);
  }

  return shuffle(candidates).slice(0, NUM_OPTIONS - 1);
}

// Turns option count N into "1, 2, 3, or 4" (matches the reference bot's
// wording) without hardcoding NUM_OPTIONS into the prose.
function formatReplyPrompt(n) {
  const nums = Array.from({ length: n }, (_, i) => String(i + 1));
  if (nums.length <= 1) return nums.join('');
  return `${nums.slice(0, -1).join(', ')}, or ${nums[nums.length - 1]}`;
}

function formatScoreboard(scores) {
  const ranked = [...scores.values()].sort((a, b) => b.points - a.points);
  if (!ranked.length) return 'Nobody scored any points.';
  return ranked
    .map((p, i) => `${i + 1}. ${p.name}\n   └ ${p.points} pts | ❌ ${p.wrong}/${MAX_WRONG_LIVES}`)
    .join('\n');
}

// Ends the session bookkeeping shared by a normal finish, `.quiz stop`, and
// `.quitgame` — clears the pending question timer (if any) so it can never
// fire after the session is gone, deletes the session, and releases the
// shared cross-game lock.
function teardown(session) {
  if (session.current?.timer) clearTimeout(session.current.timer);
  quizGames.delete(session.chatId);
  release(session.chatId, 'quiz');
}

// Sends question `session.questionIndex + 1`, or finishes the quiz if that
// was the last one. Q1 is sent as a reply to the '.quiz start' message
// (matches the reference bot quoting the starting command); every question
// after that is a fresh message to the chat, same as the reference bot.
async function advanceQuestion(session) {
  if (!quizGames.has(session.chatId)) return; // stopped/quit while the delay above was pending

  session.questionIndex++;
  if (session.questionIndex >= session.questions.length) {
    return finishQuiz(session);
  }

  const correct = session.questions[session.questionIndex];
  const decoys = pickDecoys(session.fullPool, correct, DIFFICULTY_SETTINGS[session.difficulty]);
  const options = shuffle([correct, ...decoys]);
  const correctPos = options.findIndex(o => o === correct);

  session.current = {
    correct,
    options,
    correctPos,
    answered: new Set(),
    resolved: false,
    timer: null,
    // Set now, before this question is even sent — see the comment on the
    // matching check in tryHandleQuizAnswer for why this exists.
    startedAt: Date.now(),
  };

  // Each option shows its anime as a sub-line (matches the reference bot,
  // which is also what makes hard mode's same-series decoys legible instead
  // of just four bare names with no way to reason about them).
  const optionLines = options
    .map((o, i) => `${i + 1}. ${o.name}\n   └ ${o.series}`)
    .join('\n');
  const replyPrompt = formatReplyPrompt(options.length);
  const caption =
    `🎭 *Anime Character Quiz*\n\n` +
    `Question ${session.questionIndex + 1}/${session.questions.length}\n\n` +
    `Who is this character?\n\n${optionLines}\n\n` +
    `Reply to this message with ${replyPrompt}.\n` +
    `⏱️ Time: ${session.timeSeconds}s`;

  let media = null;
  try {
    media = await MessageMedia.fromUrl(correct.imageUrl, { unsafeMime: true });
  } catch (err) {
    console.error('Quiz: character image fetch failed, sending text-only question:', err.message);
  }

  let sentMsg;
  try {
    if (session.questionIndex === 0) {
      sentMsg = await (media ? session.origMsg.reply(media, undefined, { caption }) : session.origMsg.reply(caption));
    } else {
      sentMsg = await (media
        ? session.client.sendMessage(session.chatId, media, { caption })
        : session.client.sendMessage(session.chatId, caption));
    }
  } catch (err) {
    console.error('Quiz: failed to send question, ending quiz early:', err.message);
    return teardown(session);
  }
  // Used in tryHandleQuizAnswer to recognize a reply that's quoting an
  // OLDER question message specifically (as opposed to one that just
  // happens to be processed late) — see the comment there.
  session.current.messageId = sentMsg?.id?._serialized || null;

  session.current.timer = setTimeout(() => handleTimeout(session), session.timeSeconds * 1000);
}

async function handleTimeout(session) {
  if (!session.current || session.current.resolved) return;
  session.current.resolved = true;

  const { name, series } = session.current.correct;
  try {
    await session.client.sendMessage(
      session.chatId,
      `⏰ *Time's up!*\n\nNobody got it in time.\nAnswer: *${name}*\nAnime: *${series}*`
    );
  } catch (err) {
    console.error('Quiz: timeout announcement failed:', err.message);
  }

  setTimeout(() => advanceQuestion(session), NEXT_QUESTION_DELAY_MS);
}

async function finishQuiz(session) {
  teardown(session);
  const board = formatScoreboard(session.scores);

  // Award a guild "games" win to the outright top scorer, if there is one —
  // a tie for first (including everyone sitting on 0 points) doesn't count
  // as anyone "winning". `.quiz stop` (an early, incomplete round) is a
  // separate function and deliberately isn't hooked into this — only a
  // full completed round counts as a win, same policy as every other game
  // in this bot not counting a quit/forfeit as a real win.
  let questNote = '';
  const ranked = [...session.scores.entries()].sort((a, b) => b[1].points - a[1].points);
  if (ranked.length && ranked[0][1].points > 0 && (ranked.length === 1 || ranked[1][1].points < ranked[0][1].points)) {
    const [winnerId] = ranked[0];
    questNote = _formatQuestCompletionNote(await Guild.addQuestProgress(winnerId, 'games', 1));
  }

  try {
    await session.origMsg.reply(`🏁 Quiz finished.\n\n🏆 *Final Scoreboard*\n\n${board}` + questNote);
  } catch (err) {
    console.error('Quiz: failed to send final scoreboard:', err.message);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
async function startQuiz(client, msg, difficultyArg) {
  const chat = await safeGetChat(msg);
  if (!chat) return;
  const chatId = chat.id._serialized;

  if (quizGames.has(chatId)) {
    return msg.reply('❌ A quiz is already in progress in this chat! Use *.quiz stop* to end it early.');
  }

  const busy = isChatBusy(chatId);
  if (busy) {
    return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);
  }

  const difficulty = DIFFICULTY_KEYS.includes(difficultyArg) ? difficultyArg : 'normal';
  const settings = DIFFICULTY_SETTINGS[difficulty];

  let rawPool;
  try {
    rawPool = await CardCatalogue.find({
      imageUrl: { $exists: true, $ne: '' },
      name: { $exists: true, $ne: '' },
      series: { $exists: true, $ne: '' },
    })
      .select('name series imageUrl tier')
      .lean();
  } catch (err) {
    console.error('Quiz: catalogue fetch failed:', err.message);
    return msg.reply('❌ Could not load the card catalogue right now — try again in a moment.');
  }

  // Dedupe by name (case-insensitive) so the same character under two
  // catalogue entries never ends up as both the answer and its own decoy.
  const seen = new Set();
  const fullPool = [];
  for (const c of rawPool) {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fullPool.push(c);
  }

  if (fullPool.length < NUM_OPTIONS + 1) {
    return msg.reply(
      `❌ Not enough cards in the catalogue yet to run a quiz (need at least ${NUM_OPTIONS + 1} distinct characters with art).`
    );
  }

  const questionCount = Math.min(TOTAL_QUESTIONS, fullPool.length);
  const questions = pickQuestionEntries(fullPool, settings, questionCount);

  const session = {
    chatId,
    client,
    origMsg: msg,
    difficulty,
    timeSeconds: settings.timeSeconds,
    fullPool,
    questions,
    questionIndex: -1,
    current: null,
    scores: new Map(),
    eliminated: new Set(),
  };

  quizGames.set(chatId, session);
  claim(chatId, 'quiz');

  await advanceQuestion(session);
}

async function stopQuiz(client, msg) {
  const chat = await safeGetChat(msg);
  if (!chat) return;
  const chatId = chat.id._serialized;

  const session = quizGames.get(chatId);
  if (!session) return msg.reply('❌ No quiz is currently active in this chat.');

  const askedSoFar = Math.max(session.questionIndex + 1, 0);
  const total = session.questions.length;
  teardown(session);

  return msg.reply(
    `🛑 Quiz stopped early (${askedSoFar}/${total} questions asked).\n\n🏆 *Scoreboard*\n\n${formatScoreboard(session.scores)}`
  );
}

// Called from '.quitgame' in commands/games.js, same contract as
// quitTTT/quitC4/quitChess/quitBattle — returns null if there's no quiz
// here (so quitgame can fall through to check other game types), or a
// result object to report if there was.
function quitQuiz(chatId) {
  const session = quizGames.get(chatId);
  if (!session) return null;

  const askedSoFar = Math.max(session.questionIndex + 1, 0);
  const total = session.questions.length;
  teardown(session);

  return { askedSoFar, total, board: formatScoreboard(session.scores) };
}

// ─── Command entry point ────────────────────────────────────────────────────
// .quiz / .quiz [easy|normal|hard] / .quiz start [easy|normal|hard] — starts
// .quiz stop / .quiz end — ends the current quiz early
// ─── Help text ───────────────────────────────────────────────────────────────
// Shown for a bare ".quiz" (and any unrecognized subcommand) instead of
// silently starting a game — starting now requires the explicit "start".
async function sendQuizHelp(msg) {
  const text =
    `🎭 *Anime Character Quiz*\n\n` +
    `I show a character's picture — first person to reply with the right number wins the point. ${TOTAL_QUESTIONS} questions per round.\n\n` +
    `*Start a round:*\n` +
    `.quiz start — normal difficulty (${DIFFICULTY_SETTINGS.normal.timeSeconds}s per question)\n` +
    `.quiz start easy — easier, more recognizable characters (${DIFFICULTY_SETTINGS.easy.timeSeconds}s per question)\n` +
    `.quiz start hard — decoys from the same anime (${DIFFICULTY_SETTINGS.hard.timeSeconds}s per question)\n\n` +
    `*Answering:*\n` +
    `Just reply with 1, 2, 3, or 4 — no prefix needed.\n` +
    `${MAX_WRONG_LIVES} wrong answers and you're out for the rest of that round.\n\n` +
    `*Stop early:*\n` +
    `.quiz stop (or .quitgame)`;
  return msg.reply(text);
}

async function quiz(client, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'stop' || sub === 'end') {
    return stopQuiz(client, msg);
  }

  if (sub === 'start') {
    const difficultyArg = (args[1] || '').toLowerCase();
    return startQuiz(client, msg, difficultyArg);
  }

  // Bare ".quiz", or anything else unrecognized (typo'd difficulty,
  // stray args, etc.) — show usage instead of guessing what they meant.
  return sendQuizHelp(msg);
}

// ─── Answer interception ─────────────────────────────────────────────────────
// Called from index.js's main message listener for EVERY incoming message,
// before any command/prefix routing. Returns true if the message was
// consumed as a quiz answer — including a "too late" one that doesn't score
// (see the comment further down for why those still return true) — and the
// caller should stop processing it any further; false otherwise, meaning
// there was no active quiz here at all or this clearly wasn't meant as an
// answer. Deliberately accepts a bare "1"-"4" with no command prefix and no
// requirement that it's a quoted reply to the question — on an unstable
// connection a WhatsApp "reply" quote can fail to attach even when the tap
// registered, and requiring it would silently drop valid answers.
async function tryHandleQuizAnswer(client, msg) {
  // Captured immediately, before anything else in this function — including
  // the retry-with-backoff calls below (safeGetChat/safeGetQuotedMessage/
  // safeGetContact), which on a shaky connection can each take a couple of
  // seconds of their own retry delay. The "arrived implausibly fast" check
  // further down needs to know how long it's ACTUALLY been since this
  // message came in, not how long it's been since we finally got around to
  // checking it — using a fresh Date.now() there instead would let exactly
  // that retry delay quietly age a genuinely-stale reply past the
  // threshold, which is the leading suspect for how a reply meant for an
  // expired question was still slipping through and getting graded against
  // whatever question replaced it.
  const receivedAt = Date.now();

  // WhatsApp Web's DOM can inject invisible formatting/direction marks —
  // U+200B-U+200F (zero-width space/joiner/LRM/RLM), U+202A-U+202E
  // (directional overrides), U+2060 (word joiner), U+FEFF (BOM), U+00A0
  // (NBSP) — into a message's body, most commonly seen on quoted replies.
  // A plain .trim() does NOT strip these (they aren't in Unicode's
  // whitespace category), so a reply that LOOKS like a bare "3" could
  // silently fail the digit check below and fall through to the
  // AI-copilot reply-to-bot handler instead of ever reaching the quiz —
  // which is exactly the "could not download media" symptom this fixes.
  const rawBody = msg.body || '';
  const body = rawBody
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00A0]/g, '')
    .trim();

  if (!/^[1-9][0-9]?$/.test(body)) {
    // Diagnostic only, and deliberately narrow (only logs for something
    // that's ALMOST a bare digit) so normal chatter doesn't spam the log.
    // If this still fires after the strip above, it means the real
    // culprit is a different character than the ones handled here —
    // check `pm2 logs` for the exact escaped bytes next time it happens.
    if (/^[^0-9]{0,3}[0-9][^0-9]{0,3}$/.test(rawBody) && rawBody !== body) {
      console.log('Quiz: near-miss answer body did not match after sanitizing, raw =', JSON.stringify(rawBody));
    }
    return false;
  }

  let chat;
  try {
    chat = await safeGetChat(msg);
  } catch (err) {
    console.error('Quiz: chat lookup failed while checking answer:', err.message);
    return false;
  }
  if (!chat) return false;
  const chatId = chat.id._serialized;

  const session = quizGames.get(chatId);
  // No quiz running at all in this chat — this bare number was never
  // ours to begin with, let it fall through to normal message handling.
  if (!session) return false;

  const question = session.current;
  const choice = parseInt(body, 10);
  if (!question || choice < 1 || choice > question.options.length) return false;

  // Shared "too late" reply used by every staleness check below, so a
  // player who replies to an expired question is told plainly what
  // happened instead of just being silently ignored.
  const sayTooLate = async () => {
    try {
      await msg.reply("⏰ *Time's up for that question!* It's already been answered or moved on — check the current question instead.");
    } catch (err) {
      console.error("Quiz: \"time's up\" notice failed to send:", err.message);
    }
    return true;
  };

  // If this reply explicitly quotes a SPECIFIC bot message and that
  // message isn't the currently active question, that's ground truth —
  // it's answering a question that has already moved on, no guessing
  // needed. Checked ahead of the timing heuristics below because a
  // confirmed quote mismatch is more reliable than inferring staleness
  // from timing.
  let quoteConfirmedFresh = false;
  if (msg.hasQuotedMsg) {
    try {
      const quoted = await safeGetQuotedMessage(msg);
      if (quoted?.id?._serialized && question.messageId) {
        if (quoted.id._serialized !== question.messageId) {
          return sayTooLate();
        }
        quoteConfirmedFresh = true;
      }
    } catch (err) {
      console.error('Quiz: quoted-message lookup failed while checking answer:', err.message);
      // Fall through to the timing checks below rather than failing the
      // whole answer over a lookup glitch.
    }
  }

  // Quoting a message can silently fail to attach even when the tap
  // registered (the reason this function accepts a bare number at all —
  // see the function comment above), so the check above only catches a
  // stale reply when quoting DID work. These two catch it either way:
  //
  // 1) WhatsApp's own server-assigned send time (seconds since epoch) for
  // this reply, compared against when the CURRENT question was posted —
  // sent before that, it can't possibly be answering it. The 2s grace
  // period absorbs WhatsApp's whole-second rounding against startedAt's
  // millisecond precision; real staleness here means a whole previous
  // question's worth of lag, not a same-second rounding artifact.
  const sentBeforeCurrentStarted = msg.timestamp && msg.timestamp * 1000 < question.startedAt - 2000;
  // 2) No genuine answer to a BRAND NEW question can physically arrive
  // faster than MIN_HUMAN_REACTION_MS — reading an image plus four titled
  // options, deciding, and typing/tapping a reply all take real time. A
  // reply RECEIVED sooner than that after the current question started is
  // almost certainly a delayed one meant for the PREVIOUS question —
  // caught here using our own clock (captured as receivedAt, at the very
  // top of this function, before any of the retry-wrapped lookups above
  // could add their own delay) rather than trusting msg.timestamp's exact
  // semantics on an unreliable connection.
  const arrivedImplausiblyFast = receivedAt - question.startedAt < MIN_HUMAN_REACTION_MS;
  // Both of these are fallback heuristics for when quoting isn't available
  // or didn't resolve — a confirmed quote match above is ground truth and
  // overrides them; without that fix, a genuinely fast (but confirmed
  // fresh) answer to a quoted question could get wrongly told it's late.
  if (!quoteConfirmedFresh && (sentBeforeCurrentStarted || arrivedImplausiblyFast)) {
    return sayTooLate();
  }

  // Diagnostic only, changes nothing: we're about to accept this as an
  // answer to the CURRENT question, but if the quote didn't positively
  // confirm that and we're still early in this question's life, we don't
  // have real proof either way — we just didn't hit one of the two
  // rejection cases above. If a wrongly-accepted stale answer is ever
  // reported again, this is what tells us why: whether msg.timestamp was
  // even present, and by how much this missed the staleness checks.
  if (!quoteConfirmedFresh && (receivedAt - question.startedAt) < STALE_ANSWER_WATCH_WINDOW_MS) {
    console.log(
      'Quiz: accepting answer without a confirmed-fresh quote —',
      `elapsedSinceQuestionStart=${receivedAt - question.startedAt}ms,`,
      `msg.timestamp=${msg.timestamp ?? 'undefined'},`,
      `hasQuotedMsg=${!!msg.hasQuotedMsg}, questionMessageId=${question.messageId ?? 'null'}`
    );
  }

  // From here on, a quiz IS active in this chat and the reply IS a
  // plausible answer to the CURRENT question specifically — so every
  // path below this point returns true and fully consumes the message,
  // even when it turns out to be "too late" in some other way (this
  // question already resolved — someone else answered first, or its
  // timer already ran out — or this player already used their guess on
  // it, or they're sitting out as eliminated). All of those used to
  // return false here instead, which sent the reply on to the
  // AI-copilot reply-to-bot handler — and since a late answer is still
  // quoting/following the bot's own quiz image, that handler tried to
  // re-analyze it and failed ("could not download the attached/replied-to
  // media" + the generic ⏳ react), which is exactly the symptom this
  // closes. A question that's already over simply doesn't accept answers
  // anymore; it doesn't hand them off elsewhere either.
  if (question.resolved) return sayTooLate();

  let contact;
  try {
    contact = await safeGetContact(msg);
  } catch (err) {
    console.error('Quiz: contact lookup failed while checking answer:', err.message);
    return true;
  }
  const playerId = contact.id._serialized;

  // Re-check after the await above — on a slow connection, enough time
  // could theoretically pass here for the question's own timer to expire
  // and move the quiz on before we're done.
  if (question.resolved) return sayTooLate();
  if (session.eliminated.has(playerId)) return true;
  if (question.answered.has(playerId)) return true;
  question.answered.add(playerId);

  const isCorrect = choice - 1 === question.correctPos;

  // BUGFIX-PRONE SPOT: the question's per-question timer (handleTimeout)
  // runs on a plain setTimeout, completely outside the per-chat message
  // queue that normally serializes everything else here — so it CAN fire
  // in between two `await`s of this same function call (e.g. while
  // resolveNameById below is waiting on a slow/hiccupping Mongo
  // connection) and replace session.current with the next question.
  // Deciding "did they win" and immediately, synchronously, clearing the
  // timer + marking `question.resolved` — with NO await in between — closes
  // that window: nothing else can run until the next await, so once we're
  // past this block a stale timeout can never steal a genuine first-correct
  // answer or double-advance the quiz.
  if (isCorrect) {
    question.resolved = true;
    clearTimeout(question.timer);
  }

  let scoreEntry = session.scores.get(playerId);
  if (!scoreEntry) {
    const name = await resolveNameById(client, playerId);
    scoreEntry = { name, points: 0, wrong: 0 };
    session.scores.set(playerId, scoreEntry);
  }

  if (isCorrect) {
    scoreEntry.points += 1;

    try {
      await msg.react('✅');
    } catch (err) {
      console.error('Quiz: react to correct answer failed:', err.message);
    }

    try {
      await msg.reply(
        `✅ *${scoreEntry.name} got it first!*\n\nAnswer: *${question.correct.name}*\nAnime: *${question.correct.series}*`
      );
    } catch (err) {
      console.error('Quiz: correct-answer reply failed:', err.message);
    }

    setTimeout(() => advanceQuestion(session), NEXT_QUESTION_DELAY_MS);
    return true;
  }

  // The question may have been resolved by someone else (or timed out)
  // while we were awaiting resolveNameById just above — if so, the round
  // has already been publicly revealed, so silently drop this now-moot
  // wrong guess rather than sending a confusing message about a question
  // that's no longer open. Their guess is still not counted against them
  // in this rare case.
  if (question.resolved) return true;

  scoreEntry.wrong += 1;
  const justEliminated = scoreEntry.wrong >= MAX_WRONG_LIVES;
  if (justEliminated) session.eliminated.add(playerId);

  try {
    await msg.react('❌');
  } catch (err) {
    console.error('Quiz: react to wrong answer failed:', err.message);
  }

  const pickedName = question.options[choice - 1]?.name || '?';
  let text =
    `❌ Wrong, *${scoreEntry.name}*! You picked: *${pickedName}*\n` +
    `⏩ Your turn is skipped for this question.\n\n` +
    `Wrong answers: ${scoreEntry.wrong}/${MAX_WRONG_LIVES}`;
  if (justEliminated) text += `\n💔 You're out of guesses for the rest of this quiz!`;

  try {
    await msg.reply(text);
  } catch (err) {
    console.error('Quiz: wrong-answer reply failed:', err.message);
  }

  return true;
}

module.exports = {
  quizGames,
  quiz,
  quitQuiz,
  tryHandleQuizAnswer,
  MIN_HUMAN_REACTION_MS,
};
