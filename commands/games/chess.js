const { Chess } = require('chess.js');
const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./chessEngine');
const { renderBoardImage } = require('./chessBoardImage');
const { BOT_NAME } = require('../../utils/config');
const { isChatBusy, claim, release } = require('./activeGame');
const Guild = require('../../models/Guild');
const { _formatQuestCompletionNote } = require('../guilds');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { chess, mode: 'pvp' | 'bot', white, black, whiteName, blackName,
//             search, turnTimer }
// In bot mode the human is always White, and `black` is the literal string
// 'BOT' — never a real WhatsApp id, so it can never accidentally match one.
// `turnTimer` (PvP only — see scheduleTurnTimeout()) holds the pending
// setTimeout handle for the current player's 30-second move window — same
// mechanism as connect4.js's and tictactoe.js's redesigns.
const chessGames = new Map();

// ─── Pending Lobbies (.chess start / .chess join) ───────────────────────────
// chatId -> { players: [{ id, name }], timer }
// Same shape/purpose as connect4.js's c4Lobbies and tictactoe.js's
// tttLobbies — a separate, earlier phase from an actual game. Holds the
// chat's activeGame.js claim (so nothing else can start while people are
// still joining) but no board yet. Starts automatically the moment a 2nd
// player joins, or auto-closes after LOBBY_WINDOW_MS if it doesn't fill.
// The old ".chess @user" immediate-start (manually mentioning an opponent)
// is retired — this lobby/join flow replaces it, the same change already
// made to Connect 4 and Tic Tac Toe.
const chessLobbies = new Map();
const LOBBY_WINDOW_MS = 60000;

// Real, enforced per-turn timeout for PvP games — same reasoning and same
// mechanism as connect4.js's/tictactoe.js's TURN_TIMEOUT_MS. Bot mode has
// no timer (no urgency waiting on a bot, and its captions never showed one).
const TURN_TIMEOUT_MS = 30000;

// Difficulty = search depth + a wall-clock time budget. This bot is
// single-threaded and processes commands from one shared queue, so an
// unbounded-depth search would stall every other command in every chat for
// as long as it runs — not just this game. Each level gets more thinking
// time, but even 'hard' is capped so it can never hang the bot; on a slow
// connection or an old phone it'll just play a bit weaker than its ceiling
// once time runs out, rather than freezing anything.
const DIFFICULTIES = {
  easy:   { maxDepth: 1, timeLimitMs: 1000 },
  medium: { maxDepth: 2, timeLimitMs: 2000 },
  hard:   { maxDepth: 3, timeLimitMs: 4000 },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
// The digits WhatsApp needs for an @mention, straight from a stored player
// id — same helper as connect4.js's/tictactoe.js's idDigits.
function idDigits(id) {
  return id.split('@')[0];
}

// PvP turn prompt — same "🎯 @user to move ♔. ⏱️ 30s" format connect4.js
// and tictactoe.js use, for the same reason (a real, enforced timeout —
// see scheduleTurnTimeout below, not just display text).
function turnPrompt(playerId, roleSymbol) {
  return `🎯 @${idDigits(playerId)} to move ${roleSymbol}.\n⏱️ 30s`;
}

// Returns { text, winnerColor } instead of a plain string — winnerColor is
// 'w'/'b' on checkmate, or null on any of the draw outcomes. Both .move
// call sites below need to know WHO (if anyone) actually won, not just the
// display text, to award guild quest progress to the right real user id
// (and never to 'BOT').
function describeGameOver(chess, whiteName, blackName) {
  if (chess.isCheckmate()) {
    // chess.turn() is the side with no moves left — they're the one mated.
    const winnerColor = chess.turn() === 'w' ? 'b' : 'w';
    const winnerName = winnerColor === 'w' ? whiteName : blackName;
    return { text: `♟️ *Checkmate!*\n🏆 Winner: ${winnerName}`, winnerColor };
  }
  if (chess.isStalemate()) return { text: "♟️ *Draw* — stalemate (no legal moves, but not in check).", winnerColor: null };
  if (chess.isThreefoldRepetition()) return { text: '♟️ *Draw* — the same position occurred three times.', winnerColor: null };
  if (chess.isInsufficientMaterial()) return { text: '♟️ *Draw* — neither side has enough material to checkmate.', winnerColor: null };
  return { text: '♟️ *Draw* — the 50-move rule.', winnerColor: null }; // last remaining isDraw() case
}

// Sends the current position as a board image with `caption`, as a reply to
// whichever command triggered it (msg.reply — a real quoted reply bubble).
// The board is always oriented to whoever needs to move next — this is a
// WhatsApp group chat, so there's no way to show two different people two
// different images of the same message; flipping to the mover's side each
// turn is the closest equivalent of "each player sees their own
// perspective" that a single shared message can actually deliver. Falls
// back to the existing plain-text ASCII board (with the same caption
// appended) if image rendering fails for any reason, so the game is never
// blocked by it. `mentions` is optional — only PvP turn prompts need it.
//
// This is the piece of the Connect 4 redesign NOT carried over here — per
// Brandon, same as Tic Tac Toe, Chess keeps its PNG board image.
// Everything else (lobby, join, startbot, the real turn timer) matches
// Connect 4 and Tic Tac Toe exactly.
async function sendBoard(msg, chess, { lastMove, caption, mentions } = {}) {
  const opts = mentions ? { caption, mentions } : { caption };
  try {
    const perspective = chess.turn();
    const png = renderBoardImage(chess, { perspective, lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'chess-board.png');
    await msg.reply(media, undefined, opts);
  } catch (err) {
    console.error('Chess board image render failed, falling back to text board:', err.message);
    await msg.reply(`${chess.ascii()}\n\n${caption}`, undefined, mentions ? { mentions } : undefined);
  }
}

// Used only for the lobby -> game transition and turn-timeout skips —
// neither is a reply to any one specific command (the transition follows
// whichever of two people's .chess join filled the lobby; a skip isn't
// triggered by any message at all) — a plain chat message, same reasoning
// as connect4.js's/tictactoe.js's announceBoard.
async function announceBoard(chat, chess, { lastMove, caption, mentions } = {}) {
  const opts = mentions ? { caption, mentions } : { caption };
  try {
    const perspective = chess.turn();
    const png = renderBoardImage(chess, { perspective, lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'chess-board.png');
    await chat.sendMessage(media, opts);
  } catch (err) {
    console.error('Chess board image render failed, falling back to text board:', err.message);
    await chat.sendMessage(`${chess.ascii()}\n\n${caption}`, mentions ? { mentions } : undefined);
  }
}

// Real, enforced 30-second-per-turn timeout for PvP games — identical
// mechanism to connect4.js's/tictactoe.js's scheduleTurnTimeout. Only SKIPS
// the current player's turn (board untouched, nobody forfeits/resigns) and
// reschedules itself for whoever's turn it becomes next. A real move
// always cancels the pending timeout for whoever just played.
//
// Skipping a chess turn just means passing the move without making one —
// chess.js has no formal "pass" for this. Flipping which WhatsApp id owns
// White/Black to fake it would be wrong: game.white/game.black are each
// player's PERMANENT color for the whole game, not just "whoever moves
// next" — swapping them would silently hand a player the other side's
// pieces after a single skip. Instead this edits the position's FEN
// directly, flipping only its side-to-move field (and clearing any pending
// en passant target, which would otherwise describe a capture opportunity
// against a move that never happened) — verified this leaves the board and
// every piece exactly where it was, only whose turn it is changes.
// game.white/game.black are never touched.
//
// NOTE: same caveat as connect4.js/tictactoe.js — if both players go
// silent, this keeps skipping and messaging the chat every 30s forever;
// nothing here auto-forfeits. .quitgame is still the only way out of a
// truly abandoned game. Flag if you want a cap on consecutive skips added
// later.
function scheduleTurnTimeout(chat, chatId, game) {
  if (game.mode !== 'pvp') return;
  if (game.turnTimer) clearTimeout(game.turnTimer);

  const skippedColor = game.chess.turn();
  game.turnTimer = setTimeout(async () => {
    if (chessGames.get(chatId) !== game) return;
    if (game.chess.turn() !== skippedColor) return;

    const skippedId = skippedColor === 'w' ? game.white : game.black;

    const fenParts = game.chess.fen().split(' ');
    fenParts[1] = fenParts[1] === 'w' ? 'b' : 'w'; // side to move
    fenParts[3] = '-'; // clear en passant target
    game.chess.load(fenParts.join(' '));

    const nextColor = game.chess.turn();
    const nextId = nextColor === 'w' ? game.white : game.black;
    const nextSymbol = nextColor === 'w' ? '♔' : '♚';

    await announceBoard(chat, game.chess, {
      lastMove: null,
      caption: `⏭️ @${idDigits(skippedId)} took too long — turn skipped!\n\n${turnPrompt(nextId, nextSymbol)}`,
      mentions: [skippedId, nextId],
    }).catch(err => console.error('Chess turn-timeout message failed:', err.message));

    scheduleTurnTimeout(chat, chatId, game);
  }, TURN_TIMEOUT_MS);
}

// Builds the game + starts a PvP match for two already-resolved lobby
// players, sends "Players: ... Game start!" (with real @mentions), then
// the first turn's board. Not triggered by any single command message (two
// different people's .chess join led here), so everything from here on is
// a plain chat.sendMessage, never msg.reply — same as connect4.js's
// startC4Game and tictactoe.js's startTTTGame.
//
// UNCERTAINTY FLAGGED: same as connect4.js/tictactoe.js — which of the two
// joiners gets White (and so moves first) is picked at random rather than
// always the lobby's first joiner, for consistency with those two games'
// redesigns (Connect 4's screenshot evidence showed the 2nd joiner moving
// first, not join order). There's no equivalent screenshot for Chess
// specifically, so this is an assumption carried over for consistency
// between the three games rather than evidence for THIS game — tell me if
// you want Chess to always give the lobby's first joiner White instead.
async function startChessGame(chat, chatId, players) {
  const whiteFirst = Math.random() < 0.5;
  const white = whiteFirst ? players[0] : players[1];
  const black = whiteFirst ? players[1] : players[0];

  const chess = new Chess();
  const game = {
    chess, mode: 'pvp',
    white: white.id, black: black.id,
    whiteName: white.name, blackName: black.name,
  };
  chessGames.set(chatId, game);
  // Lobby already held the activeGame.js claim from .chess start — the
  // game reuses it, no re-claim needed here.

  await chat.sendMessage(
    `Players:\n1) @${idDigits(white.id)} ♔ White\n2) @${idDigits(black.id)} ♚ Black\n\nGame start!`,
    { mentions: [white.id, black.id] }
  );

  await announceBoard(chat, chess, {
    caption: turnPrompt(white.id, '♔'),
    mentions: [white.id],
  });
  scheduleTurnTimeout(chat, chatId, game);
}

module.exports = {
  chessGames,
  chessLobbies,

  // .chess start — opens a PvP lobby. Anyone (including whoever opened it)
  //   then uses .chess join to take a slot; the game starts automatically
  //   the moment a 2nd player joins, or the lobby auto-closes after
  //   LOBBY_WINDOW_MS if it doesn't fill.
  // .chess startbot [easy|medium|hard] — play the bot directly (defaults
  //   to medium). Replaces the old "no mention = bot" behavior with an
  //   explicit keyword.
  // .chess join — take a slot in an open lobby.
  //
  // The old ".chess @user" immediate-start (manually mentioning an
  // opponent) is retired — that's exactly what the lobby/join flow above
  // replaces. Same redesign as Connect 4 and Tic Tac Toe (see connect4.js,
  // tictactoe.js), except the board stays a rendered PNG image here — same
  // as Tic Tac Toe, Chess's image is NOT being retired.
  async chess(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const sub = (args[0] || '').toLowerCase();

    // ── .chess start — open a lobby ─────────────────────────────────────
    if (sub === 'start') {
      if (chessGames.has(chatId) || chessLobbies.has(chatId)) return msg.reply('❌ A game or lobby is already active!');
      const busy = isChatBusy(chatId);
      if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

      claim(chatId, 'chess');
      const lobby = { players: [], timer: null };
      chessLobbies.set(chatId, lobby);
      lobby.timer = setTimeout(() => {
        // Still here means it never filled — see connect4.js's identical
        // comment on its own lobby timeout for why this check is enough.
        if (!chessLobbies.has(chatId)) return;
        chessLobbies.delete(chatId);
        release(chatId, 'chess');
        chat.sendMessage('❌ Chess lobby closed — not enough players joined.').catch(err => {
          console.error('Chess lobby-timeout message failed:', err.message);
        });
      }, LOBBY_WINDOW_MS);

      return msg.reply(`🎮 *Chess* lobby opened. Use *.chess join* (${LOBBY_WINDOW_MS / 1000}s).`);
    }

    // ── .chess startbot [difficulty] — play the bot ─────────────────────
    if (sub === 'startbot') {
      if (chessGames.has(chatId) || chessLobbies.has(chatId)) return msg.reply('❌ A game or lobby is already active!');
      const busy = isChatBusy(chatId);
      if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

      const playerId = contact.id._serialized;
      const playerName = await resolveNameById(client, playerId);
      const difficultyLabel = DIFFICULTIES[(args[1] || '').toLowerCase()] ? args[1].toLowerCase() : 'medium';
      const search = DIFFICULTIES[difficultyLabel];
      const slowWarning = difficultyLabel === 'hard'
        ? '\n⚠️ Hard mode can take a few seconds to think on a slow connection.'
        : '';

      const chess = new Chess();
      chessGames.set(chatId, {
        chess,
        mode: 'bot',
        white: playerId,
        black: 'BOT',
        whiteName: playerName,
        blackName: `🤖 ${BOT_NAME}`,
        search,
      });
      claim(chatId, 'chess');

      return sendBoard(msg, chess, {
        caption: `♟️ *Chess vs ${BOT_NAME}* (${difficultyLabel})\n\n♔ White: ${playerName}\n♚ Black: 🤖 ${BOT_NAME}\n\nYou're White — use *.move [e2e4]* (from-to format) to play!${slowWarning}`,
      });
    }

    // ── .chess join — take a slot in an open lobby ──────────────────────
    if (sub === 'join') {
      const lobby = chessLobbies.get(chatId);
      if (!lobby) return msg.reply('❌ No open Chess lobby. Use *.chess start* to open one.');

      const playerId = contact.id._serialized;
      if (lobby.players.some(p => p.id === playerId)) return msg.reply('❌ You already joined this lobby!');
      if (lobby.players.length >= 2) return msg.reply('❌ This lobby is already full.');

      // Reserve the slot SYNCHRONOUSLY — no `await` between this length
      // check and the push below — so two .chess join messages landing
      // back to back can't both read the same pre-push length and collide
      // on the same slot. Same race fixed the same way in connect4.js's
      // .c4 join and tictactoe.js's .ttt join.
      const slotIndex = lobby.players.length;
      lobby.players.push({ id: playerId, name: null });

      lobby.players[slotIndex].name = await resolveNameById(client, playerId);

      await msg.reply(`Joined as Player ${slotIndex + 1}!`);

      if (lobby.players.length >= 2) {
        clearTimeout(lobby.timer);
        chessLobbies.delete(chatId);
        await startChessGame(chat, chatId, lobby.players);
      }
      return;
    }

    if (chessGames.has(chatId)) return msg.reply('❌ A game is already active!');

    return msg.reply('❌ Usage:\n*.chess start* — open a lobby for another person\n*.chess startbot [easy|medium|hard]* — play the bot');
  },

  // .move [e2e4] — shared by both PvP and vs-bot games
  async move(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;
    const game = chessGames.get(chatId);
    if (!game) return msg.reply('❌ No chess game active.');

    const playerId = contact.id._serialized;
    if (game.white !== playerId && game.black !== playerId) {
      return msg.reply('❌ You are not in this game.');
    }

    const turnPlayerId = game.chess.turn() === 'w' ? game.white : game.black;
    if (playerId !== turnPlayerId) return msg.reply('❌ Not your turn!');

    const moveStr = args[0];
    if (!moveStr) return msg.reply('❌ Usage: .move [e2e4]');

    const moverName = game.chess.turn() === 'w' ? game.whiteName : game.blackName;

    // BUGFIX (Aug 2026): chess.js v1.4.0 (the version actually installed —
    // confirmed via node_modules/chess.js/package.json) throws an Error on
    // an illegal move instead of returning null/false. This code was
    // originally written against the older pre-1.0 chess.js API, where
    // `.move()` returning a falsy value was how an invalid move was
    // reported — the `if (!humanResult)` check right below used to be
    // reachable, but with the throwing behavior it never was: the
    // exception propagated straight past this whole command handler and
    // was only caught by index.js's generic top-level error handler, which
    // logged "Failed to execute command: Invalid move: {...}" and replied
    // with a generic "An error occurred" message instead of the intended
    // "❌ Invalid move!" — confirmed by reproducing the exact thrown
    // message format from the reported pm2 log.
    let humanResult;
    try {
      humanResult = game.chess.move({ from: moveStr.slice(0, 2), to: moveStr.slice(2, 4), promotion: 'q' });
    } catch (err) {
      humanResult = null;
    }
    if (!humanResult) return msg.reply('❌ Invalid move!');

    // Human move resolved. If the game's over now, report it and stop.
    if (game.chess.isGameOver()) {
      if (game.turnTimer) clearTimeout(game.turnTimer);
      chessGames.delete(chatId);
      release(chatId, 'chess');
      const gameOver = describeGameOver(game.chess, game.whiteName, game.blackName);
      // A player's own move can only end in their own win or a draw, never
      // the opponent's win — so winnerColor here always resolves to the
      // human who just moved (or null on a draw). The winnerId !== 'BOT'
      // check is purely defensive, not because 'BOT' can actually appear
      // here.
      const winnerId = gameOver.winnerColor === 'w' ? game.white : gameOver.winnerColor === 'b' ? game.black : null;
      const questNote = winnerId && winnerId !== 'BOT'
        ? _formatQuestCompletionNote(await Guild.addQuestProgress(winnerId, 'games', 1))
        : '';
      return sendBoard(msg, game.chess, {
        lastMove: { from: humanResult.from, to: humanResult.to },
        caption: `${moverName} played *${humanResult.san}*\n\n${gameOver.text}` + questNote,
      });
    }

    // ── vs bot: it replies with its own move in this same message ─────────
    if (game.mode === 'bot') {
      const aiMove = getBestMove(game.chess, game.search);
      if (!aiMove) {
        // Shouldn't happen — isGameOver() above already ruled out "no moves".
        chessGames.delete(chatId);
        release(chatId, 'chess');
        return sendBoard(msg, game.chess, {
          lastMove: { from: humanResult.from, to: humanResult.to },
          caption: `❌ ${BOT_NAME} couldn't find a move — ending the game.`,
        });
      }
      game.chess.move(aiMove);
      const aiLastMove = { from: aiMove.from, to: aiMove.to };

      if (game.chess.isGameOver()) {
        chessGames.delete(chatId);
        release(chatId, 'chess');
        const gameOver = describeGameOver(game.chess, game.whiteName, game.blackName);
        // Unlike the human-move branch above, this one genuinely can
        // resolve to 'BOT' (the bot's own move just delivered checkmate) —
        // that must NOT be treated as a guild win.
        const winnerId = gameOver.winnerColor === 'w' ? game.white : gameOver.winnerColor === 'b' ? game.black : null;
        const questNote = winnerId && winnerId !== 'BOT'
          ? _formatQuestCompletionNote(await Guild.addQuestProgress(winnerId, 'games', 1))
          : '';
        return sendBoard(msg, game.chess, {
          lastMove: aiLastMove,
          caption: `${moverName} played *${humanResult.san}*\n🤖 ${BOT_NAME} played *${aiMove.san}*\n\n${gameOver.text}` + questNote,
        });
      }

      return sendBoard(msg, game.chess, {
        lastMove: aiLastMove,
        caption: `${moverName} played *${humanResult.san}*\n🤖 ${BOT_NAME} played *${aiMove.san}*\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}Your turn, ${game.whiteName}! Use *.move [e2e4]*.`,
      });
    }

    // ── vs person ───────────────────────────────────────────────────────
    const nextId = game.chess.turn() === 'w' ? game.white : game.black;
    const nextSymbol = game.chess.turn() === 'w' ? '♔' : '♚';
    await sendBoard(msg, game.chess, {
      lastMove: { from: humanResult.from, to: humanResult.to },
      caption: `${moverName} played *${humanResult.san}*\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}${turnPrompt(nextId, nextSymbol)}`,
      mentions: [nextId],
    });
    scheduleTurnTimeout(chat, chatId, game);
  },

  // Ends an in-progress game as a forfeit/resignation by `playerId` in
  // `chatId`, if they're in one. Returns null when there's no chess game for
  // them here, so the shared .quitgame command can fall through and try
  // other game types. NOTE: this only covers an already-STARTED game, not
  // an open lobby — an open lobby with fewer than 2 joiners already
  // resolves itself via LOBBY_WINDOW_MS, so there was no forfeit-style exit
  // to wire up here.
  quitChess(chatId, playerId) {
    const game = chessGames.get(chatId);
    if (!game || (game.white !== playerId && game.black !== playerId)) return null;

    if (game.turnTimer) clearTimeout(game.turnTimer);
    const quitterName = game.white === playerId ? game.whiteName : game.blackName;
    const winnerName = game.white === playerId ? game.blackName : game.whiteName;
    chessGames.delete(chatId);
    release(chatId, 'chess');
    return { quitterName, winnerName };
  },
};
