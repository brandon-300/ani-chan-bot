const { MessageMedia } = require('whatsapp-web.js');
const { CardCatalogue } = require('../../models/Card');
const { safeGetChat, safeGetQuotedMessage, safeGetContact, resolveNameById } = require('../../utils/helpers');
const { isChatBusy, claim, release } = require('./activeGame');
const Guild = require('../../models/Guild');
const { _formatQuestCompletionNote } = require('../guilds');

// ─── Active Quiz Sessions ───────────────────────────────────────────────────
// chatId -> {
//   chatId, client,
//   starterId,                      // whoever ran .quiz start — the only
//                                    // one who can end this match early
//                                    // (see quitQuiz) — carried over as-is
//                                    // from the lobby that became this match
//   players,                        // [{id, name}, ...] — 1 to 5 (see
//                                    // MAX_QUIZ_PLAYERS), fixed once the
//                                    // lobby's countdown ends (see
//                                    // quizLobbies below). players[0] is
//                                    // always the starter — they're added
//                                    // automatically at .quiz start, no
//                                    // separate .quiz join needed for them.
//                                    // Only these registered ids can
//                                    // answer/score this match — see
//                                    // tryHandleQuizAnswer.
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
//                                    // — pre-populated for every registered
//                                    // player at match start, so the final
//                                    // scoreboard always shows everyone
//                                    // even if some never land a correct
//                                    // answer
//   eliminated,                     // Set of playerIds who hit
//                                    // MAX_WRONG_LIVES total wrong guesses
//                                    // this quiz and are sitting out the rest
// }
const quizGames = new Map();

// ─── Pending Lobbies (.quiz start / .quiz join / .quiz leave) ──────────────
// chatId -> { starterId, players: [{ id, name }], timer, difficulty }
// Holds the chat's activeGame.js claim (so nothing else can start while the
// countdown is running) but no questions yet. .quiz start immediately adds
// its own sender as players[0] (the starter) and begins a fixed
// LOBBY_WINDOW_MS countdown; .quiz join adds more people (up to
// MAX_QUIZ_PLAYERS) any time before that countdown ends, and .quiz leave
// removes a non-starter who changes their mind. There's no "starts early
// once full" and no minimum to reach — the match always starts the moment
// the countdown ends, with whoever's in players at that point (worst case,
// just the starter alone) — see openQuizLobby's timer. Once that happens,
// this lobby entry is gone and .quiz join/.quiz leave both correctly stop
// working (there's nothing left to join or leave).
//
// Quiz used to be open to the whole chat at once, with no fixed roster at
// all (anyone could jump in and answer, any time); per Brandon, it's now a
// capped-roster match (1 to 5 people) with a starter/joiner permission
// split (see quitQuiz's comment) — specifically so multiple concurrent
// matches in one group chat are possible later.
const quizLobbies = new Map();
const LOBBY_WINDOW_MS = 30000;
const MAX_QUIZ_PLAYERS = 5;

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
// The digits WhatsApp needs for an @mention, straight from a stored player
// id — same helper as connect4.js's idDigits.
function idDigits(id) {
  return id.split('@')[0];
}

// Matches the reference bot's exact lobby card format — see Brandon's
// screenshot. Rebuilt and resent in full every time the roster changes
// (.quiz join / .quiz leave), rather than trying to edit a previous
// message, same as every other bot message in this codebase.
function buildLobbyCard(lobby) {
  const starter = lobby.players.find(p => p.id === lobby.starterId) || lobby.players[0];
  const lines = lobby.players
    .map((p, i) => `${i + 1}. *${p.name}*\n   └ 0 pts | ❌ 0/${MAX_WRONG_LIVES}`)
    .join('\n');

  return (
    `🎭 *Anime Character Quiz Lobby*\n\n` +
    `Started by: ${starter.name}\n\n` +
    `Players:\n${lines}\n\n` +
    `Use \`.quiz join\` to join.\n` +
    `Starter can use \`.quiz end\` to cancel/end.\n\n` +
    `┃ Starts in *${LOBBY_WINDOW_MS / 1000}s*\n` +
    `┃ Questions: *${TOTAL_QUESTIONS}*`
  );
}

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
    sentMsg = await (media
      ? session.client.sendMessage(session.chatId, media, { caption })
      : session.client.sendMessage(session.chatId, caption));
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
    await session.client.sendMessage(session.chatId, `🏁 Quiz finished.\n\n🏆 *Final Scoreboard*\n\n${board}` + questNote);
  } catch (err) {
    console.error('Quiz: failed to send final scoreboard:', err.message);
  }
}

// ─── Start (lobby) ─────────────────────────────────────────────────────────
// .quiz start [difficulty] — opens a lobby. Whoever runs it is
// automatically players[0] (the starter) — no separate .quiz join needed
// for them. Reacts ✅ on success (lobby opened) or ❌ on failure (already a
// game/lobby active, or the chat's busy with a different game), per
// Brandon's reference screenshot. Anyone (including the starter) can then
// .quiz join up to MAX_QUIZ_PLAYERS before the fixed LOBBY_WINDOW_MS
// countdown ends — the match starts at that point no matter how many
// joined (never earlier, even if it fills up), and no one can join once it
// has (there's nothing left to join — the lobby entry is gone).
async function openQuizLobby(client, msg, difficultyArg) {
  const chat = await safeGetChat(msg);
  if (!chat) return;
  const chatId = chat.id._serialized;

  if (quizGames.has(chatId) || quizLobbies.has(chatId)) {
    await msg.react('❌').catch(() => {});
    return msg.reply('❌ A quiz or lobby is already active in this chat!');
  }
  const busy = isChatBusy(chatId);
  if (busy) {
    await msg.react('❌').catch(() => {});
    return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);
  }

  const contact = await msg.getContact();
  const starterId = contact.id._serialized;
  const starterName = await resolveNameById(client, starterId);
  const difficulty = DIFFICULTY_KEYS.includes(difficultyArg) ? difficultyArg : 'normal';

  claim(chatId, 'quiz');
  const lobby = {
    starterId,
    players: [{ id: starterId, name: starterName }],
    timer: null,
    difficulty,
  };
  quizLobbies.set(chatId, lobby);
  lobby.timer = setTimeout(() => {
    // Still here means .quiz end never cancelled it first — see
    // connect4.js's identical comment on its own lobby timeout for why
    // this presence check is enough. Unlike Connect4 (and unlike this
    // quiz's own earlier design), there's no minimum roster size to reach
    // here — the starter alone is always a valid roster of 1, so this
    // unconditionally starts the match rather than ever cancelling for
    // "not enough players."
    if (!quizLobbies.has(chatId)) return;
    quizLobbies.delete(chatId);
    startQuizMatch(client, chat, chatId, lobby.players, lobby.difficulty, lobby.starterId).catch(err => {
      console.error('Quiz: failed to start match after lobby countdown:', err.message);
    });
  }, LOBBY_WINDOW_MS);

  await msg.react('✅').catch(() => {});
  return msg.reply(buildLobbyCard(lobby));
}

// .quiz join — take a slot in an open lobby (up to MAX_QUIZ_PLAYERS).
async function joinQuizLobby(client, msg) {
  const chat = await safeGetChat(msg);
  if (!chat) return;
  const chatId = chat.id._serialized;

  const lobby = quizLobbies.get(chatId);
  if (!lobby) return msg.reply('❌ No open quiz lobby. Use *.quiz start* to open one.');

  const contact = await msg.getContact();
  const playerId = contact.id._serialized;
  // Also correctly rejects the starter trying to "join" their own lobby —
  // they're already players[0] from the moment .quiz start ran.
  if (lobby.players.some(p => p.id === playerId)) return msg.reply('❌ You already joined this lobby!');
  if (lobby.players.length >= MAX_QUIZ_PLAYERS) {
    return msg.reply('❌ Maximum number of players has been reached.');
  }

  // Reserve the slot SYNCHRONOUSLY — no `await` between this length check
  // and the push below — so two .quiz join messages landing back to back
  // can't both read the same pre-push length and collide on the same slot.
  // Same race fixed the same way in connect4.js's .c4 join.
  const slotIndex = lobby.players.length;
  lobby.players.push({ id: playerId, name: null });
  lobby.players[slotIndex].name = await resolveNameById(client, playerId);

  // Reposts the full lobby card (updated roster) rather than a short
  // "Joined!" confirmation — matches the reference bot showing the whole
  // Players list at a glance after every join.
  return msg.reply(buildLobbyCard(lobby));
}

// .quiz leave — a joiner backs out before the match starts. The starter
// can't use this on themselves (per Brandon: they can only cancel the
// whole lobby, via .quiz end) — leaving is specifically a non-starter
// action. Once the match has actually started there's no lobby left to
// leave at all (see quizLobbies' own comment), so this naturally stops
// applying then too.
async function leaveQuizLobby(client, msg) {
  const chat = await safeGetChat(msg);
  if (!chat) return;
  const chatId = chat.id._serialized;

  const lobby = quizLobbies.get(chatId);
  if (!lobby) return msg.reply('❌ No open quiz lobby to leave.');

  const contact = await msg.getContact();
  const playerId = contact.id._serialized;

  if (playerId === lobby.starterId) {
    return msg.reply('❌ You started this lobby — use *.quiz end* to cancel it instead.');
  }

  const idx = lobby.players.findIndex(p => p.id === playerId);
  if (idx === -1) return msg.reply("❌ You're not in this lobby.");

  lobby.players.splice(idx, 1);
  return msg.reply(`👋 Left the lobby.\n\n${buildLobbyCard(lobby)}`);
}

// Builds the question pool and kicks off the actual match once a lobby's
// countdown ends. Not triggered by any command message (the countdown
// firing on its own led here), so — same as connect4.js's startC4Game —
// everything from here on is a plain chat.sendMessage, never msg.reply.
async function startQuizMatch(client, chat, chatId, players, difficulty, starterId) {
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
    release(chatId, 'quiz');
    return chat.sendMessage('❌ Could not load the card catalogue right now — the match has been cancelled.');
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
    release(chatId, 'quiz');
    return chat.sendMessage(
      `❌ Not enough cards in the catalogue yet to run a quiz (need at least ${NUM_OPTIONS + 1} distinct characters with art) — the match has been cancelled.`
    );
  }

  const questionCount = Math.min(TOTAL_QUESTIONS, fullPool.length);
  const questions = pickQuestionEntries(fullPool, settings, questionCount);

  // Pre-populated for every registered player (rather than lazily created
  // the first time each one answers, like before) so the final scoreboard
  // always shows everyone — even someone who never lands a single correct
  // answer — now that the roster (1 to MAX_QUIZ_PLAYERS) is fixed and known
  // from the start.
  const scores = new Map();
  for (const p of players) scores.set(p.id, { name: p.name, points: 0, wrong: 0 });

  const session = {
    chatId,
    client,
    starterId,
    players,
    difficulty,
    timeSeconds: settings.timeSeconds,
    fullPool,
    questions,
    questionIndex: -1,
    current: null,
    scores,
    eliminated: new Set(),
  };

  quizGames.set(chatId, session);
  // Lobby already held the activeGame.js claim from .quiz start — the
  // match reuses it, no re-claim needed here.

  const lines = players.map((p, i) => `${i + 1}) @${idDigits(p.id)}`);
  await chat.sendMessage(`Players:\n${lines.join('\n')}\n\nGame start!`, { mentions: players.map(p => p.id) });

  await advanceQuestion(session);
}

// .quiz end — the starter cancels a pending lobby OR ends an active match
// early. Per Brandon: this is starter-only in BOTH cases — a joiner who
// wants out of a pending lobby uses .quiz leave instead (see
// leaveQuizLobby above), and a joiner has no way to end an active match at
// all (only to have started it). Just translates quitQuiz's result into a
// reply — see quitQuiz below for the actual logic, shared with
// '.quitgame' in commands/games.js so the two can never drift apart on
// who's allowed to do what.
async function endQuiz(client, msg) {
  const chat = await safeGetChat(msg);
  if (!chat) return;
  const chatId = chat.id._serialized;
  const contact = await msg.getContact();

  const result = quitQuiz(chatId, contact.id._serialized);
  if (!result) return msg.reply('❌ No quiz is currently active in this chat.');

  if (!result.ended) {
    return msg.reply(
      result.reason === 'joiner-in-lobby'
        ? '❌ Only the person who started this lobby can cancel it — use *.quiz leave* to leave it yourself.'
        : '❌ Only the quiz starter can end this match.'
    );
  }

  if (result.lobby) return msg.reply('🛑 Quiz lobby cancelled.');

  return msg.reply(
    `🛑 Quiz stopped early (${result.askedSoFar}/${result.total} questions asked).\n\n🏆 *Scoreboard*\n\n${result.board}`
  );
}

// Called from both .quiz end (above) and '.quitgame' in commands/games.js
// (same contract as quitTTT/quitC4/quitChess/quitBattle) — single source
// of truth for who's allowed to end what:
//   - Not part of any lobby OR match here at all -> null (quitgame can
//     fall through to check other game types; .quiz end reports "no quiz
//     active").
//   - Part of a pending LOBBY, and IS the starter -> cancels it,
//     { ended: true, lobby: true }.
//   - Part of a pending LOBBY, but ISN'T the starter -> refused,
//     { ended: false, reason: 'joiner-in-lobby' } — they can only
//     .quiz leave, not cancel the whole thing.
//   - Part of an active MATCH, and IS the starter -> ends it early,
//     { ended: true, askedSoFar, total, board }.
//   - Part of an active MATCH, but ISN'T the starter -> refused,
//     { ended: false, reason: 'not-starter' } — only the starter can end
//     an in-progress match; a joiner has no individual "quit just for me"
//     option here (unlike Connect4, quiz has no single 1-for-1 opponent to
//     hand a win to when one player drops).
function quitQuiz(chatId, playerId) {
  const lobby = quizLobbies.get(chatId);
  if (lobby && lobby.players.some(p => p.id === playerId)) {
    if (playerId !== lobby.starterId) return { ended: false, reason: 'joiner-in-lobby' };

    clearTimeout(lobby.timer);
    quizLobbies.delete(chatId);
    release(chatId, 'quiz');
    return { ended: true, lobby: true };
  }

  const session = quizGames.get(chatId);
  if (!session || !session.players.some(p => p.id === playerId)) return null;
  if (playerId !== session.starterId) return { ended: false, reason: 'not-starter' };

  const askedSoFar = Math.max(session.questionIndex + 1, 0);
  const total = session.questions.length;
  teardown(session);

  return { ended: true, askedSoFar, total, board: formatScoreboard(session.scores) };
}

// ─── Command entry point ────────────────────────────────────────────────────
// .quiz start [easy|normal|hard] — opens a lobby, starter auto-joins as
//   Player 1, reacts ✅/❌
// .quiz join — take a slot (up to MAX_QUIZ_PLAYERS) before the countdown ends
// .quiz leave — a joiner (not the starter) backs out of a pending lobby
// .quiz end — starter-only: cancel a pending lobby, or end an active match early
// ─── Help text ───────────────────────────────────────────────────────────────
// Shown for a bare ".quiz" (and any unrecognized subcommand) instead of
// silently starting a game — starting now requires the explicit "start".
async function sendQuizHelp(msg) {
  const text =
    `🎭 *Anime Character Quiz*\n\n` +
    `Up to ${MAX_QUIZ_PLAYERS} players — I show a character's picture, first matched player to reply with the right number wins the point. ${TOTAL_QUESTIONS} questions per match.\n\n` +
    `*Start a match:*\n` +
    `.quiz start — opens a lobby, normal difficulty (${DIFFICULTY_SETTINGS.normal.timeSeconds}s per question)\n` +
    `.quiz start easy — easier, more recognizable characters (${DIFFICULTY_SETTINGS.easy.timeSeconds}s per question)\n` +
    `.quiz start hard — decoys from the same anime (${DIFFICULTY_SETTINGS.hard.timeSeconds}s per question)\n` +
    `You're automatically Player 1 — the match begins ${LOBBY_WINDOW_MS / 1000}s later with whoever's joined by then.\n\n` +
    `*Joining/leaving before it starts:*\n` +
    `.quiz join — take a slot (up to ${MAX_QUIZ_PLAYERS} players)\n` +
    `.quiz leave — back out (joiners only, not the starter)\n\n` +
    `*Answering:*\n` +
    `Just reply with 1, 2, 3, or 4 — no prefix needed. Only matched players' answers count.\n` +
    `${MAX_WRONG_LIVES} wrong answers and you're out for the rest of that match.\n\n` +
    `*Ending early:*\n` +
    `.quiz end (or .quitgame) — starter only, cancels a pending lobby or ends an active match`;
  return msg.reply(text);
}

async function quiz(client, msg, args) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'end') {
    return endQuiz(client, msg);
  }

  if (sub === 'start') {
    const difficultyArg = (args[1] || '').toLowerCase();
    return openQuizLobby(client, msg, difficultyArg);
  }

  if (sub === 'join') {
    return joinQuizLobby(client, msg);
  }

  if (sub === 'leave') {
    return leaveQuizLobby(client, msg);
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

  // Only registered players (see .quiz join) can answer — since a match is
  // now a capped roster of up to MAX_QUIZ_PLAYERS people (not the whole
  // chat), anyone else's bare digit here is just normal chat, not an
  // attempted answer, so it's let through rather than intercepted-and-
  // rejected. Checked via msg.author/msg.from directly (same fallback
  // index.js itself uses) rather than the full safeGetContact retry-with-
  // backoff machinery further down — this is meant to be a cheap early
  // exit for the common case of other people in the group just talking,
  // not the authoritative identity check (that still happens properly,
  // below, for whoever IS accepted here).
  const earlySenderId = msg.author || msg.from;
  if (!session.players.some(p => p.id === earlySenderId)) return false;

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
  quizLobbies,
  quiz,
  quitQuiz,
  tryHandleQuizAnswer,
  MIN_HUMAN_REACTION_MS,
};
