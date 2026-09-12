const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./tictactoeEngine');
const { renderBoardImage } = require('./tictactoeBoardImage');
const { BOT_NAME } = require('../../utils/config');
const { isChatBusy, claim, release } = require('./activeGame');
const Guild = require('../../models/Guild');
const { _formatQuestCompletionNote } = require('../guilds');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, mode: 'pvp' | 'bot', turn, players, names, symbols,
//             difficulty, lastMove, turnTimer }
// Same shape/conventions as before: in bot mode the human is always
// players[0] (symbols[0], '❌') and players[1] is the literal string 'BOT'
// — never a real WhatsApp id, so it can never accidentally match one.
// `names` is resolved once at game start and cached here — see the comment
// in the .ttt command below for why we don't just re-derive it from
// WhatsApp Contact objects every time we need to display it. `turnTimer`
// (PvP only — see scheduleTurnTimeout()) holds the pending setTimeout
// handle for the current player's 30-second move window — same mechanism
// as connect4.js's Connect 4 redesign.
const tttGames = new Map();

// ─── Pending Lobbies (.ttt start / .ttt join) ───────────────────────────────
// chatId -> { players: [{ id, name }], timer }
// Same shape/purpose as connect4.js's c4Lobbies — a separate, earlier phase
// from an actual game. Holds the chat's activeGame.js claim (so nothing
// else can start while people are still joining) but no board yet. Starts
// automatically the moment a 2nd player joins, or auto-closes after
// LOBBY_WINDOW_MS if it doesn't fill. The old ".ttt @user" immediate-start
// (manually mentioning an opponent) is retired — this lobby/join flow
// replaces it, exactly the same change made to Connect 4.
const tttLobbies = new Map();
const LOBBY_WINDOW_MS = 60000;

// Real, enforced per-turn timeout for PvP games — same reasoning and same
// mechanism as connect4.js's TURN_TIMEOUT_MS. Bot mode has no timer (no
// urgency waiting on a bot, and its captions never showed one).
const TURN_TIMEOUT_MS = 30000;

const DIFFICULTY_KEYS = ['easy', 'medium', 'hard'];

// ─── Helpers ───────────────────────────────────────────────────────────────────
// The digits WhatsApp needs for an @mention, straight from a stored player
// id — same helper as connect4.js's idDigits.
function idDigits(id) {
  return id.split('@')[0];
}

function renderTTTText(board) {
  return board.map(r => r.join(' | ')).join('\n─────────\n') + '\n\nPositions:\n1|2|3\n─────────\n4|5|6\n─────────\n7|8|9';
}

function checkTTTWin(board) {
  const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const flat = board.flat();
  for (const [a, b, c] of wins) {
    // '·' (the empty-cell placeholder) is a non-empty string, so it's
    // truthy — without excluding it here, three still-empty cells in a
    // win-line (very common early in the game) get read as a match and
    // the game ends after a single move with '·' reported as the winner.
    if (flat[a] !== '·' && flat[a] === flat[b] && flat[b] === flat[c]) return flat[a];
  }
  if (flat.every(cell => cell !== '·')) return 'draw';
  return null;
}

// The board/win-check logic above works in terms of the display symbols
// ('❌'/'⭕'/'·') so the text fallback and win-check stay unchanged from
// before. tictactoeEngine.js works in plain 'X'/'O'/null terms instead
// (it has no reason to know which emoji is in use) — this converts between
// the two right before/after calling it, rather than changing the engine
// or the rest of this file's board representation.
function toEngineCells(board, symbols) {
  return board.flat().map(cell => {
    if (cell === symbols[0]) return 'X';
    if (cell === symbols[1]) return 'O';
    return null;
  });
}

// PvP turn prompt — same "🎯 @user to move ❌. ⏱️ 30s" format connect4.js
// uses, for the same reason (a real, enforced timeout — see
// scheduleTurnTimeout below, not just display text).
function turnPrompt(symbol, playerId) {
  return `🎯 @${idDigits(playerId)} to move ${symbol}.\n⏱️ 30s`;
}

// Sends the current board as an image with `caption`, as a reply to
// whichever command triggered it (msg.reply — a real quoted reply bubble).
// Falls back to the existing plain-text board (with the same caption
// appended) if image rendering fails for any reason, so the game is never
// blocked by it. `mentions` is optional — only PvP turn prompts need it.
//
// This is the ONE piece of the Connect 4 redesign NOT carried over here —
// per Brandon, Tic Tac Toe keeps its PNG board image. Everything else
// (lobby, join, startbot, the real turn timer) matches Connect 4 exactly.
async function sendBoard(msg, game, caption, mentions) {
  const opts = mentions ? { caption, mentions } : { caption };
  try {
    const png = renderBoardImage(game.board, { symbols: game.symbols, lastMove: game.lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'ttt-board.png');
    await msg.reply(media, undefined, opts);
  } catch (err) {
    console.error('Tic Tac Toe board image render failed, falling back to text board:', err.message);
    await msg.reply(`${renderTTTText(game.board)}\n\n${caption}`, undefined, mentions ? { mentions } : undefined);
  }
}

// Used only for the lobby -> game transition and turn-timeout skips —
// neither is a reply to any one specific command (the transition follows
// whichever of two people's .ttt join filled the lobby; a skip isn't
// triggered by any message at all) — a plain chat message, same reasoning
// as connect4.js's announceBoard.
async function announceBoard(chat, game, caption, mentions) {
  const opts = mentions ? { caption, mentions } : { caption };
  try {
    const png = renderBoardImage(game.board, { symbols: game.symbols, lastMove: game.lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'ttt-board.png');
    await chat.sendMessage(media, opts);
  } catch (err) {
    console.error('Tic Tac Toe board image render failed, falling back to text board:', err.message);
    await chat.sendMessage(`${renderTTTText(game.board)}\n\n${caption}`, mentions ? { mentions } : undefined);
  }
}

// Real, enforced 30-second-per-turn timeout for PvP games — identical
// mechanism to connect4.js's scheduleTurnTimeout. Only SKIPS the current
// player's turn (board untouched, nobody forfeits) and reschedules itself
// for whoever's turn it becomes next. A real move always cancels the
// pending timeout for whoever just played (call this every time a PvP turn
// starts — it clears out the previous timer first).
//
// NOTE: same caveat as connect4.js — if both players go silent, this keeps
// skipping and messaging the chat every 30s forever; nothing here
// auto-forfeits. .quitgame is still the only way out of a truly abandoned
// game. Flag if you want a cap on consecutive skips added later.
function scheduleTurnTimeout(chat, chatId, game) {
  if (game.mode !== 'pvp') return;
  if (game.turnTimer) clearTimeout(game.turnTimer);

  const skippedIdx = game.turn;
  const skippedId = game.players[skippedIdx];
  game.turnTimer = setTimeout(async () => {
    if (tttGames.get(chatId) !== game) return;
    if (game.turn !== skippedIdx) return;

    game.turn = game.turn === 0 ? 1 : 0;
    const nextIdx = game.turn;
    const nextId = game.players[nextIdx];

    await announceBoard(
      chat, game,
      `⏭️ @${idDigits(skippedId)} took too long — turn skipped!\n\n${turnPrompt(game.symbols[nextIdx], nextId)}`,
      [skippedId, nextId]
    ).catch(err => console.error('Tic Tac Toe turn-timeout message failed:', err.message));

    scheduleTurnTimeout(chat, chatId, game);
  }, TURN_TIMEOUT_MS);
}

// Builds the board + starts a PvP game for two already-resolved lobby
// players, sends "Players: ... Game start!" (with real @mentions), then
// the first turn's board. Not triggered by any single command message (two
// different people's .ttt join led here), so everything from here on is a
// plain chat.sendMessage, never msg.reply — same as connect4.js's
// startC4Game.
//
// UNCERTAINTY FLAGGED: same as connect4.js — who moves first is picked at
// random rather than always Player 1, for consistency with Connect 4
// (where screenshot evidence showed the 2nd joiner moving first, not join
// order). There's no equivalent screenshot for Tic Tac Toe specifically,
// so this is an assumption carried over for consistency between the two
// games rather than evidence for THIS game — tell me if you want Tic Tac
// Toe to always start with Player 1 (❌) instead.
async function startTTTGame(chat, chatId, players) {
  const board = Array.from({ length: 3 }, () => ['·', '·', '·']);
  const symbols = ['❌', '⭕'];
  const turn = Math.random() < 0.5 ? 0 : 1;

  const game = {
    board, turn, symbols, mode: 'pvp',
    players: players.map(p => p.id),
    names: players.map(p => p.name),
    lastMove: null,
  };
  tttGames.set(chatId, game);
  // Lobby already held the activeGame.js claim from .ttt start — the game
  // reuses it, no re-claim needed here.

  const lines = players.map((p, i) => `${i + 1}) @${idDigits(p.id)} ${symbols[i]}`);
  await chat.sendMessage(`Players:\n${lines.join('\n')}\n\nGame start!`, {
    mentions: players.map(p => p.id),
  });

  const firstId = game.players[turn];
  await announceBoard(chat, game, turnPrompt(symbols[turn], firstId), [firstId]);
  scheduleTurnTimeout(chat, chatId, game);
}

module.exports = {
  tttGames,
  tttLobbies,

  // .ttt start — opens a PvP lobby. Anyone (including whoever opened it)
  //   then uses .ttt join to take a slot; the game starts automatically the
  //   moment a 2nd player joins, or the lobby auto-closes after
  //   LOBBY_WINDOW_MS if it doesn't fill.
  // .ttt startbot [easy|medium|hard] — play the bot directly (defaults to
  //   medium). Replaces the old "no mention = bot" behavior with an
  //   explicit keyword.
  // .ttt join — take a slot in an open lobby.
  // .ttt [1-9] — make a move in whichever game is active (shared by both modes)
  //
  // The old ".ttt @user" immediate-start (manually mentioning an opponent)
  // is retired — that's exactly what the lobby/join flow above replaces.
  // Same redesign as Connect 4 (see connect4.js), except the board stays a
  // rendered PNG image here — Tic Tac Toe's image is NOT being retired.
  async ttt(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const sub = (args[0] || '').toLowerCase();

    const game = tttGames.get(chatId);
    const movePos = parseInt(args[0]);

    // ── Active game + numeric arg = this is a move ──────────────────────────
    if (game && !isNaN(movePos)) {
      if (movePos < 1 || movePos > 9) return msg.reply('❌ Choose a position 1-9.');

      const playerIndex = game.players.indexOf(contact.id._serialized);
      if (playerIndex === -1) {
        return msg.reply("❌ You're not part of this game!");
      }

      if (playerIndex !== game.turn) {
        return msg.reply(`❌ Not your turn! Waiting on ${game.names[game.turn]}.`);
      }

      const row = Math.floor((movePos - 1) / 3);
      const col = (movePos - 1) % 3;

      if (game.board[row][col] !== '·') {
        return msg.reply('❌ That spot is already taken! Choose another.');
      }

      const moverName = game.names[game.turn];
      game.board[row][col] = game.symbols[game.turn];
      game.lastMove = { row, col };

      let result = checkTTTWin(game.board);
      if (result) {
        if (game.turnTimer) clearTimeout(game.turnTimer);
        tttGames.delete(chatId);
        release(chatId, 'ttt');
        const outcome = result === 'draw' ? "🤝 *It's a draw!*" : `🏆 *${moverName} wins!*`;
        // game.players[game.turn] is whoever just moved (the turn index isn't
        // flipped until after this win-check, in both pvp and bot mode) — a
        // real WhatsApp id here in both modes, never the literal 'BOT'
        // string, since only the human's own move reaches this check.
        // Draws don't count. Forfeits via .quitgame are intentionally NOT
        // hooked here — only an actual completed win counts toward a guild's
        // "win N games" quest.
        const questNote = result !== 'draw'
          ? _formatQuestCompletionNote(await Guild.addQuestProgress(game.players[game.turn], 'games', 1))
          : '';
        return sendBoard(msg, game, `${moverName} played position ${movePos}\n\n${outcome}` + questNote);
      }

      // ── vs bot: it replies with its own move in this same message ────────
      if (game.mode === 'bot') {
        const engineCells = toEngineCells(game.board, game.symbols);
        const botIndex = getBestMove(engineCells, 'O', 'X', game.difficulty);

        if (botIndex === null) {
          // Shouldn't happen — checkTTTWin() above already ruled out "board full".
          tttGames.delete(chatId);
          release(chatId, 'ttt');
          return sendBoard(msg, game, `❌ ${BOT_NAME} couldn't find a move — ending the game.`);
        }

        const botRow = Math.floor(botIndex / 3);
        const botCol = botIndex % 3;
        game.board[botRow][botCol] = game.symbols[1];
        game.lastMove = { row: botRow, col: botCol };

        result = checkTTTWin(game.board);
        if (result) {
          tttGames.delete(chatId);
          release(chatId, 'ttt');
          const outcome = result === 'draw' ? "🤝 *It's a draw!*" : `🏆 *${game.names[1]} wins!*`;
          return sendBoard(
            msg, game,
            `${moverName} played position ${movePos}\n🤖 ${BOT_NAME} played position ${botIndex + 1}\n\n${outcome}`
          );
        }

        tttGames.set(chatId, game); // game.turn stays 0 — it's the human's turn again
        return sendBoard(
          msg, game,
          `${moverName} played position ${movePos}\n🤖 ${BOT_NAME} played position ${botIndex + 1}\n\nYour turn! Type *.ttt [1-9]* to play.`
        );
      }

      // ── vs person ─────────────────────────────────────────────────────────
      game.turn = game.turn === 0 ? 1 : 0;
      tttGames.set(chatId, game);
      const nextId = game.players[game.turn];
      await sendBoard(msg, game, turnPrompt(game.symbols[game.turn], nextId), [nextId]);
      scheduleTurnTimeout(chat, chatId, game);
      return;
    }

    // ── A stray move number with no active game ─────────────────────────────
    if (!game && !isNaN(movePos)) {
      return msg.reply('❌ No Tic Tac Toe game active. Start one with *.ttt start* (vs a person) or *.ttt startbot* (vs the bot).');
    }

    // ── .ttt start — open a lobby ───────────────────────────────────────
    if (sub === 'start') {
      if (tttGames.has(chatId) || tttLobbies.has(chatId)) return msg.reply('❌ A game or lobby is already active!');
      const busy = isChatBusy(chatId);
      if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

      claim(chatId, 'ttt');
      const lobby = { players: [], timer: null };
      tttLobbies.set(chatId, lobby);
      lobby.timer = setTimeout(() => {
        // Still here means it never filled — see connect4.js's identical
        // comment on its own lobby timeout for why this check is enough.
        if (!tttLobbies.has(chatId)) return;
        tttLobbies.delete(chatId);
        release(chatId, 'ttt');
        chat.sendMessage('❌ Tic Tac Toe lobby closed — not enough players joined.').catch(err => {
          console.error('Tic Tac Toe lobby-timeout message failed:', err.message);
        });
      }, LOBBY_WINDOW_MS);

      return msg.reply(`🎮 *Tic Tac Toe* lobby opened. Use *.ttt join* (${LOBBY_WINDOW_MS / 1000}s).`);
    }

    // ── .ttt startbot [difficulty] — play the bot ───────────────────────
    if (sub === 'startbot') {
      if (tttGames.has(chatId) || tttLobbies.has(chatId)) return msg.reply('❌ A game or lobby is already active!');
      const busy = isChatBusy(chatId);
      if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

      const playerId = contact.id._serialized;
      const playerName = await resolveNameById(client, playerId);
      const board = Array.from({ length: 3 }, () => ['·', '·', '·']);
      const symbols = ['❌', '⭕'];
      const difficultyLabel = DIFFICULTY_KEYS.includes((args[1] || '').toLowerCase()) ? args[1].toLowerCase() : 'medium';

      const newGame = {
        board, turn: 0, symbols, mode: 'bot', difficulty: difficultyLabel,
        players: [playerId, 'BOT'],
        names: [playerName, `🤖 ${BOT_NAME}`],
        lastMove: null,
      };
      tttGames.set(chatId, newGame);
      claim(chatId, 'ttt');

      return sendBoard(
        msg, newGame,
        `🎮 *Tic Tac Toe vs ${BOT_NAME}* (${difficultyLabel})\n\n❌ You: ${playerName}\n⭕ 🤖 ${BOT_NAME}\n\nYou're ❌ — type *.ttt [1-9]* to play!`
      );
    }

    // ── .ttt join — take a slot in an open lobby ────────────────────────
    if (sub === 'join') {
      const lobby = tttLobbies.get(chatId);
      if (!lobby) return msg.reply('❌ No open Tic Tac Toe lobby. Use *.ttt start* to open one.');

      const playerId = contact.id._serialized;
      if (lobby.players.some(p => p.id === playerId)) return msg.reply('❌ You already joined this lobby!');
      if (lobby.players.length >= 2) return msg.reply('❌ This lobby is already full.');

      // Reserve the slot SYNCHRONOUSLY — no `await` between this length
      // check and the push below — so two .ttt join messages landing back
      // to back can't both read the same pre-push length and collide on
      // the same player slot. Same race fixed the same way in
      // connect4.js's .c4 join.
      const slotIndex = lobby.players.length;
      lobby.players.push({ id: playerId, name: null });

      lobby.players[slotIndex].name = await resolveNameById(client, playerId);

      await msg.reply(`Joined as Player ${slotIndex + 1}!`);

      if (lobby.players.length >= 2) {
        clearTimeout(lobby.timer);
        tttLobbies.delete(chatId);
        await startTTTGame(chat, chatId, lobby.players);
      }
      return;
    }

    if (game) return msg.reply('❌ A game is already in progress!');

    return msg.reply('❌ Usage:\n*.ttt start* — open a lobby for another person\n*.ttt startbot [easy|medium|hard]* — play the bot');
  },

  // Ends an in-progress game as a forfeit by `playerId` in `chatId`, if
  // they're in one. Returns null when there's no ttt game for them here, so
  // a shared .quitgame command can fall through and try other game types.
  // NOTE: this only covers an already-STARTED game, not an open lobby — an
  // open lobby with fewer than 2 joiners already resolves itself via
  // LOBBY_WINDOW_MS, so there was no forfeit-style exit to wire up here.
  quitTTT(chatId, playerId) {
    const game = tttGames.get(chatId);
    if (!game || !game.players.includes(playerId)) return null;

    if (game.turnTimer) clearTimeout(game.turnTimer);
    const idx = game.players.indexOf(playerId);
    const winnerIdx = idx === 0 ? 1 : 0;
    tttGames.delete(chatId);
    release(chatId, 'ttt');
    return { quitterName: game.names[idx], winnerName: game.names[winnerIdx] };
  },
};
