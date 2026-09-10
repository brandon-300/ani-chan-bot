const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./connect4Engine');
const { BOT_NAME } = require('../../utils/config');
const { isChatBusy, claim, release } = require('./activeGame');
const Guild = require('../../models/Guild');
const { _formatQuestCompletionNote } = require('../guilds');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, mode: 'pvp' | 'bot', turn, players, difficulty,
//             lastMove, turnTimer }
// `players` is [{ id, name, piece }, { id, name, piece }] — same shape as
// before. Same conventions as chessGames/tttGames: in bot mode the human is
// always players[0] (🔴) and players[1].id is the literal string 'BOT' —
// never a real WhatsApp id, so it can never accidentally match one.
// `turnTimer` (PvP only — see scheduleTurnTimeout()) holds the pending
// setTimeout handle for the current player's 30-second move window.
const c4Games = new Map();

// ─── Pending Lobbies (.c4 start / .c4 join) ─────────────────────────────────
// chatId -> { players: [{ id, name, piece }], timer }
// A lobby is a separate, earlier phase from an actual game — it holds the
// chat's activeGame.js claim (so nothing else can start while people are
// still joining) but has no board yet. It resolves into a real c4Games
// entry the moment a 2nd player joins, or is torn down if LOBBY_WINDOW_MS
// passes with fewer than 2 joiners.
const c4Lobbies = new Map();
const LOBBY_WINDOW_MS = 60000;

// Real, enforced per-turn timeout for PvP games (bot mode has no timer —
// there's no urgency waiting on a bot, and its captions never showed a
// timer to begin with). Skips the current player's turn only — the game
// keeps going, nobody forfeits, same board, just passed to the other
// player. See scheduleTurnTimeout() below.
const TURN_TIMEOUT_MS = 30000;

const DIFFICULTY_KEYS = ['easy', 'medium', 'hard'];
// Same reasoning as chess.js's DIFFICULTIES: more search depth + time per
// tier, all capped so a slow search can never stall the shared command
// queue for longer than its budget — see connect4Engine.js for why Connect
// 4 needs a real depth-limited search (unlike tic-tac-toe, which doesn't).
const DIFFICULTIES = {
  easy:   { maxDepth: 2, timeLimitMs: 1000 },
  medium: { maxDepth: 4, timeLimitMs: 2000 },
  hard:   { maxDepth: 6, timeLimitMs: 4000 },
};

const EMPTY = '⚪';
// Keycap-style digit emoji, matching the board Brandon asked this to be
// replaced with exactly — see renderC4Text() below.
const COLUMN_LABELS = '1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣';

// ─── Helpers ───────────────────────────────────────────────────────────────────

// The board is now ALWAYS plain text/emoji — the PNG renderer
// (connect4BoardImage.js) is retired for Connect 4 specifically, per
// Brandon's request. That file is left in place, just unused, in case this
// ever needs to be reverted; nothing else imports it.
function renderC4Text(board) {
  return board.map(row => row.join('')).join('\n') + '\n' + COLUMN_LABELS;
}

function dropC4(board, col, piece) {
  for (let r = 5; r >= 0; r--) {
    if (board[r][col] === EMPTY) { board[r][col] = piece; return r; }
  }
  return -1;
}

function checkC4Win(board, piece) {
  // Horizontal, vertical, diagonal checks
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (c + 3 < 7 && [0,1,2,3].every(i => board[r][c+i] === piece)) return true;
      if (r + 3 < 6 && [0,1,2,3].every(i => board[r+i][c] === piece)) return true;
      if (r + 3 < 6 && c + 3 < 7 && [0,1,2,3].every(i => board[r+i][c+i] === piece)) return true;
      if (r + 3 < 6 && c - 3 >= 0 && [0,1,2,3].every(i => board[r+i][c-i] === piece)) return true;
    }
  }
  return false;
}

// BUGFIX (Aug 2026): the original .drop handler had no draw detection at
// all — if the board filled up with nobody connecting 4, dropC4() would
// just return -1 forever (every column full) and the game could never end,
// permanently holding the chat's one-game-at-a-time lock (see
// activeGame.js) with no way out except .quitgame. Added alongside the
// image-rendering/bot-mode rewrite since chess.js and tictactoe.js both
// already handle this case for their own draw conditions.
function isBoardFull(board) {
  return board.every(row => row.every(cell => cell !== EMPTY));
}

// The digits WhatsApp needs, straight from a stored player id, without a
// fresh contact lookup — see mentionTag()'s comment in utils/helpers.js for
// why this has to be the actual JID digits and not just a display name.
function idDigits(id) {
  return id.split('@')[0];
}

// PvP turn prompt — the "🎯 @user to move 🔴. ⏱️ 30s" format Brandon's
// screenshots show. The 30s is now a real, enforced timeout — see
// scheduleTurnTimeout() below — not just display text.
function turnPrompt(player) {
  return `🎯 @${idDigits(player.id)} to move ${player.piece}.\n⏱️ 30s`;
}

function boardText(game, caption) {
  return `${caption}\n\n${renderC4Text(game.board)}`;
}

// .drop-triggered board updates reply to the .drop command itself (a real
// quoted reply bubble) — unchanged from before, just text instead of a PNG
// now. `mentions` is optional — only PvP turn prompts need it.
async function sendBoard(msg, game, caption, mentions) {
  await msg.reply(boardText(game, caption), undefined, mentions ? { mentions } : undefined);
}

// Used only for the lobby -> game transition, which isn't a reply to any
// one specific command (two different people's messages led here) — a
// plain chat message, same as the "Players: ... Game start!" announcement
// right before it.
async function announceBoard(chat, game, caption, mentions) {
  await chat.sendMessage(boardText(game, caption), mentions ? { mentions } : undefined);
}

// Real, enforced 30-second-per-turn timeout for PvP games. Per Brandon:
// this must only SKIP the current player's turn, never forfeit/end the
// game — so when it fires, it just flips game.turn to the other player
// (board untouched, nobody's placed a piece) and reschedules itself for
// whoever's turn it becomes next. Call this every time a PvP turn starts —
// right after the lobby fills (startC4Game) and after every non-ending
// .drop (the "vs person" branch below) — it clears out the PREVIOUS
// pending timer first, so a real move always cancels the timeout that
// would've skipped the player who just moved.
//
// NOTE: if both players go silent, this will keep skipping back and forth
// and messaging the chat every 30s forever — nothing here auto-forfeits an
// abandoned game, since Brandon was explicit this shouldn't forfeit.
// .quitgame is still the only way out of a truly abandoned PvP game. Flag
// if you want a cap (e.g. auto-forfeit after N consecutive skips) added on
// top of this later.
function scheduleTurnTimeout(chat, chatId, game) {
  if (game.mode !== 'pvp') return; // bot mode has no turn timer
  if (game.turnTimer) clearTimeout(game.turnTimer);

  const skippedPlayer = game.players[game.turn];
  game.turnTimer = setTimeout(async () => {
    // Guards against a stale timer firing after the game already moved on
    // some other way (shouldn't happen — clearTimeout above already
    // prevents it in every normal path — but cheap insurance against a
    // reference/timing edge case rather than skipping/mis-skipping a live
    // game).
    if (c4Games.get(chatId) !== game) return;
    if (game.players[game.turn] !== skippedPlayer) return;

    game.turn = game.turn === 0 ? 1 : 0;
    const next = game.players[game.turn];

    try {
      await chat.sendMessage(
        `⏭️ @${idDigits(skippedPlayer.id)} took too long — turn skipped!\n\n${turnPrompt(next)}\n\n${renderC4Text(game.board)}`,
        { mentions: [skippedPlayer.id, next.id] }
      );
    } catch (err) {
      console.error('Connect 4 turn-timeout message failed:', err.message);
    }

    scheduleTurnTimeout(chat, chatId, game);
  }, TURN_TIMEOUT_MS);
}

// Builds the board + claims the chat + starts a PvP game for two already-
// resolved players (piece/name already assigned), sends "Players: ...
// Game start!" (with real @mentions), then the first turn's board.
//
// UNCERTAINTY FLAGGED: in Brandon's reference screenshots, the player who
// joined SECOND (Player 2 / 🟡) moved first, not Player 1 — join order
// clearly isn't what decides who goes first there. Rather than guess a
// rule that might be wrong, this picks the starting player at random,
// independent of join order/piece — fair either way, but if there's a
// specific rule Miyabi actually uses (e.g. always Player 2, or a coin flip
// shown some other way), tell me and I'll match it exactly instead.
async function startC4Game(chat, chatId, players) {
  const board = Array.from({ length: 6 }, () => Array(7).fill(EMPTY));
  const turn = Math.random() < 0.5 ? 0 : 1;
  const game = { board, turn, mode: 'pvp', players, lastMove: null };
  c4Games.set(chatId, game);
  // Lobby already held the activeGame.js claim from .c4 start — the game
  // reuses it, no re-claim needed here.

  const lines = players.map((p, i) => `${i + 1}) @${idDigits(p.id)} ${p.piece}`);
  await chat.sendMessage(`Players:\n${lines.join('\n')}\n\nGame start!`, {
    mentions: players.map(p => p.id),
  });

  const first = players[turn];
  await announceBoard(chat, game, turnPrompt(first), [first.id]);
  scheduleTurnTimeout(chat, chatId, game);
}

module.exports = {
  c4Games,
  c4Lobbies,

  // .c4 start — opens a PvP lobby. Anyone (including whoever opened it)
  //   then uses .c4 join to take a slot; the game starts automatically the
  //   moment a 2nd player joins, or the lobby auto-closes after
  //   LOBBY_WINDOW_MS if it never fills.
  // .c4 startbot [easy|medium|hard] — play the bot directly (defaults to
  //   medium). Replaces the old "no mention = bot" behavior with an
  //   explicit keyword.
  // .c4 join — take a slot in an already-open lobby.
  //
  // The old ".c4 @user" immediate-start (manually mentioning an opponent)
  // is retired — that's exactly what the lobby/join flow above replaces.
  async c4(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const sub = (args[0] || '').toLowerCase();

    // ── .c4 start — open a lobby ───────────────────────────────────────
    if (sub === 'start') {
      if (c4Games.has(chatId) || c4Lobbies.has(chatId)) return msg.reply('❌ A game or lobby is already active!');
      const busy = isChatBusy(chatId);
      if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

      claim(chatId, 'c4');
      const lobby = { players: [], timer: null };
      c4Lobbies.set(chatId, lobby);
      lobby.timer = setTimeout(() => {
        // Still here means it never filled — someone joining in between
        // clears this same timer before deleting the lobby, so by the
        // time this fires, finding it still present means "fewer than 2
        // people ever joined."
        if (!c4Lobbies.has(chatId)) return;
        c4Lobbies.delete(chatId);
        release(chatId, 'c4');
        chat.sendMessage('❌ Connect 4 lobby closed — not enough players joined.').catch(err => {
          console.error('Connect 4 lobby-timeout message failed:', err.message);
        });
      }, LOBBY_WINDOW_MS);

      return msg.reply(`🎮 *Connect 4* lobby opened. Use *.c4 join* (${LOBBY_WINDOW_MS / 1000}s).`);
    }

    // ── .c4 startbot [difficulty] — play the bot ───────────────────────
    if (sub === 'startbot') {
      if (c4Games.has(chatId) || c4Lobbies.has(chatId)) return msg.reply('❌ A game or lobby is already active!');
      const busy = isChatBusy(chatId);
      if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

      const playerId = contact.id._serialized;
      const playerName = await resolveNameById(client, playerId);
      const board = Array.from({ length: 6 }, () => Array(7).fill(EMPTY));
      const difficultyLabel = DIFFICULTY_KEYS.includes((args[1] || '').toLowerCase()) ? args[1].toLowerCase() : 'medium';
      const players = [
        { id: playerId, name: playerName, piece: '🔴' },
        { id: 'BOT', name: `🤖 ${BOT_NAME}`, piece: '🟡' },
      ];

      const game = { board, turn: 0, mode: 'bot', difficulty: difficultyLabel, players, lastMove: null };
      c4Games.set(chatId, game);
      claim(chatId, 'c4');

      return sendBoard(
        msg, game,
        `🎮 *Connect 4 vs ${BOT_NAME}* (${difficultyLabel})\n\n🔴 You: ${playerName}\n🟡 🤖 ${BOT_NAME}\n\nYou're 🔴 — type *.drop [1-7]* to play!`
      );
    }

    // ── .c4 join — take a slot in an open lobby ────────────────────────
    if (sub === 'join') {
      const lobby = c4Lobbies.get(chatId);
      if (!lobby) return msg.reply('❌ No open Connect 4 lobby. Use *.c4 start* to open one.');

      const playerId = contact.id._serialized;
      if (lobby.players.some(p => p.id === playerId)) return msg.reply('❌ You already joined this lobby!');
      if (lobby.players.length >= 2) return msg.reply('❌ This lobby is already full.');

      // Reserve the slot SYNCHRONOUSLY — no `await` between this length
      // check and the push below — so two .c4 join messages landing back
      // to back can't both read the same pre-push length and collide on
      // the same player slot/piece. The name is filled in right after;
      // that part being async is harmless since the slot itself is already
      // locked in by index.
      const slotIndex = lobby.players.length;
      const piece = slotIndex === 0 ? '🔴' : '🟡';
      lobby.players.push({ id: playerId, name: null, piece });

      lobby.players[slotIndex].name = await resolveNameById(client, playerId);

      await msg.reply(`Joined as Player ${slotIndex + 1}: ${piece}`);

      if (lobby.players.length >= 2) {
        clearTimeout(lobby.timer);
        c4Lobbies.delete(chatId);
        await startC4Game(chat, chatId, lobby.players);
      }
      return;
    }

    return msg.reply('❌ Usage:\n*.c4 start* — open a lobby for another person\n*.c4 startbot [easy|medium|hard]* — play the bot');
  },

  // .drop [col] — shared by both PvP and vs-bot games
  async drop(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const game = c4Games.get(chatId);
    if (!game) return msg.reply('❌ No active Connect 4 game.');

    // BUGFIX (Aug 2026): same bug found and fixed in battle.js's .attack/
    // .defend — this used to skip straight to the turn check below, so a
    // bystander typing .drop while two other people played got told
    // "❌ Not your turn!", which reads as if they were actually in the
    // game. Chess and Tic Tac Toe already checked participation first;
    // Connect 4 and Battle's .attack/.defend didn't.
    const playerId = contact.id._serialized;
    if (!game.players.some(p => p.id === playerId)) {
      return msg.reply("❌ You're not part of this game!");
    }

    const current = game.players[game.turn];
    if (current.id !== playerId) return msg.reply('❌ Not your turn!');

    const col = parseInt(args[0]) - 1;
    if (isNaN(col) || col < 0 || col > 6) return msg.reply('❌ Choose a column 1-7.');

    const row = dropC4(game.board, col, current.piece);
    if (row === -1) return msg.reply('❌ Column full! Choose another.');
    game.lastMove = { row, col };

    if (checkC4Win(game.board, current.piece)) {
      if (game.turnTimer) clearTimeout(game.turnTimer);
      c4Games.delete(chatId);
      release(chatId, 'c4');
      // current.id is always a real WhatsApp id here — never the literal
      // 'BOT' string — since this check only ever fires right after a
      // human's own move (the bot's own win is a separate block below,
      // deliberately not hooked into guild quests).
      const questNote = _formatQuestCompletionNote(await Guild.addQuestProgress(current.id, 'games', 1));
      return sendBoard(msg, game, `🏆 *${current.name} wins Connect 4!*` + questNote);
    }

    if (isBoardFull(game.board)) {
      if (game.turnTimer) clearTimeout(game.turnTimer);
      c4Games.delete(chatId);
      release(chatId, 'c4');
      return sendBoard(msg, game, "🤝 *It's a draw!*");
    }

    game.turn = game.turn === 0 ? 1 : 0;

    // ── vs bot: it replies with its own move in this same message ────────
    if (game.mode === 'bot' && game.turn === 1) {
      const botPlayer = game.players[1];
      const botCol = getBestMove(game.board, botPlayer.piece, current.piece, DIFFICULTIES[game.difficulty]);

      if (botCol === null) {
        // Shouldn't happen — isBoardFull() above already ruled out "board full".
        c4Games.delete(chatId);
        release(chatId, 'c4');
        return sendBoard(msg, game, `❌ ${BOT_NAME} couldn't find a move — ending the game.`);
      }

      const botRow = dropC4(game.board, botCol, botPlayer.piece);
      game.lastMove = { row: botRow, col: botCol };

      if (checkC4Win(game.board, botPlayer.piece)) {
        c4Games.delete(chatId);
        release(chatId, 'c4');
        return sendBoard(msg, game, `🤖 ${BOT_NAME} played column ${botCol + 1}\n\n🏆 *${botPlayer.name} wins Connect 4!*`);
      }

      if (isBoardFull(game.board)) {
        c4Games.delete(chatId);
        release(chatId, 'c4');
        return sendBoard(msg, game, `🤖 ${BOT_NAME} played column ${botCol + 1}\n\n🤝 *It's a draw!*`);
      }

      game.turn = 0; // back to the human
      c4Games.set(chatId, game);
      return sendBoard(msg, game, `🤖 ${BOT_NAME} played column ${botCol + 1}\n\nYour turn! Type *.drop [1-7]* to play.`);
    }

    // ── vs person ─────────────────────────────────────────────────────────
    c4Games.set(chatId, game);
    const next = game.players[game.turn];
    await sendBoard(msg, game, turnPrompt(next), [next.id]);
    scheduleTurnTimeout(chat, chatId, game);
  },

  // Ends an in-progress game as a forfeit by `playerId` in `chatId`, if
  // they're in one. Returns null when there's no c4 game for them here, so
  // the shared .quitgame command can fall through and try other game types.
  // NOTE: this only covers an already-STARTED game, not an open lobby — an
  // open lobby with fewer than 2 joiners already resolves itself via
  // LOBBY_WINDOW_MS, so there was no forfeit-style exit to wire up here.
  // If you want .quitgame (or a dedicated command) to be able to cancel an
  // open lobby early too, say so.
  quitC4(chatId, playerId) {
    const game = c4Games.get(chatId);
    if (!game || !game.players.some(p => p.id === playerId)) return null;

    if (game.turnTimer) clearTimeout(game.turnTimer);
    const quitter = game.players.find(p => p.id === playerId);
    const winner = game.players.find(p => p.id !== playerId);
    c4Games.delete(chatId);
    release(chatId, 'c4');
    return { quitterName: quitter.name, winnerName: winner.name };
  },
};
