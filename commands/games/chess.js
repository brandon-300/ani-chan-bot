const { Chess } = require('chess.js');
const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./chessEngine');
const { renderBoardImage } = require('./chessBoardImage');
const { BOT_NAME } = require('../../utils/config');
const { isChatBusy, claim, release } = require('./activeGame');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { chess, mode: 'pvp' | 'bot', white, black, whiteName, blackName, search }
// In bot mode the human is always White, and `black` is the literal string
// 'BOT' — never a real WhatsApp id, so it can never accidentally match one.
const chessGames = new Map();

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

function describeGameOver(chess, whiteName, blackName) {
  if (chess.isCheckmate()) {
    // chess.turn() is the side with no moves left — they're the one mated.
    const winner = chess.turn() === 'w' ? blackName : whiteName;
    return `♟️ *Checkmate!*\n🏆 Winner: ${winner}`;
  }
  if (chess.isStalemate()) return "♟️ *Draw* — stalemate (no legal moves, but not in check).";
  if (chess.isThreefoldRepetition()) return '♟️ *Draw* — the same position occurred three times.';
  if (chess.isInsufficientMaterial()) return '♟️ *Draw* — neither side has enough material to checkmate.';
  return '♟️ *Draw* — the 50-move rule.'; // last remaining isDraw() case
}

// Sends the current position as a board image with `caption`. The board is
// always oriented to whoever needs to move next — this is a WhatsApp group
// chat, so there's no way to show two different people two different
// images of the same message; flipping to the mover's side each turn is
// the closest equivalent of "each player sees their own perspective" that
// a single shared message can actually deliver. Falls back to the existing
// plain-text ASCII board (with the same caption appended) if image
// rendering fails for any reason, so the game is never blocked by it.
//
// BUGFIX (Aug 2026): was using chat.sendMessage(), which sends a fresh,
// unquoted message — same bug already found and fixed in interaction.js's
// sendGif(). msg.reply() sends the board as a real quoted reply bubble
// under the .move/.chess command that triggered it, matching every other
// command in the bot.
async function sendBoard(msg, chat, chess, { lastMove, caption } = {}) {
  try {
    const perspective = chess.turn();
    const png = renderBoardImage(chess, { perspective, lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'chess-board.png');
    await msg.reply(media, undefined, { caption });
  } catch (err) {
    console.error('Chess board image render failed, falling back to text board:', err.message);
    await msg.reply(`${chess.ascii()}\n\n${caption}`);
  }
}

module.exports = {
  chessGames,

  // .chess @user — play another person
  // .chess [easy|medium|hard] — play the bot (defaults to medium)
  async chess(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const chatId = chat.id._serialized;

    if (chessGames.has(chatId)) return msg.reply('❌ A game is already active!');

    const busy = isChatBusy(chatId);
    if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

    const playerId = contact.id._serialized;
    const playerName = await resolveNameById(client, playerId);

    if (mentioned.length) {
      // ── vs person ────────────────────────────────────────────────────────
      const opponentId = mentioned[0].id._serialized;
      const opponentName = await resolveNameById(client, opponentId);

      const chess = new Chess();
      chessGames.set(chatId, {
        chess,
        mode: 'pvp',
        white: playerId,
        black: opponentId,
        whiteName: playerName,
        blackName: opponentName,
      });
      claim(chatId, 'chess');

      return sendBoard(msg, chat, chess, {
        caption: `♟️ *Chess*\n\n♔ White: ${playerName}\n♚ Black: ${opponentName}\n\nWhite goes first! Use *.move [e2e4]* (from-to format).`,
      });
    }

    // ── vs bot ────────────────────────────────────────────────────────────
    const difficultyLabel = DIFFICULTIES[(args[0] || '').toLowerCase()] ? args[0].toLowerCase() : 'medium';
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

    return sendBoard(msg, chat, chess, {
      caption: `♟️ *Chess vs ${BOT_NAME}* (${difficultyLabel})\n\n♔ White: ${playerName}\n♚ Black: 🤖 ${BOT_NAME}\n\nYou're White — use *.move [e2e4]* (from-to format) to play! Mention someone instead (.chess @user) to play a person.${slowWarning}`,
    });
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
      chessGames.delete(chatId);
      release(chatId, 'chess');
      return sendBoard(msg, chat, game.chess, {
        lastMove: { from: humanResult.from, to: humanResult.to },
        caption: `${moverName} played *${humanResult.san}*\n\n${describeGameOver(game.chess, game.whiteName, game.blackName)}`,
      });
    }

    // ── vs bot: it replies with its own move in this same message ─────────
    if (game.mode === 'bot') {
      const aiMove = getBestMove(game.chess, game.search);
      if (!aiMove) {
        // Shouldn't happen — isGameOver() above already ruled out "no moves".
        chessGames.delete(chatId);
        release(chatId, 'chess');
        return sendBoard(msg, chat, game.chess, {
          lastMove: { from: humanResult.from, to: humanResult.to },
          caption: `❌ ${BOT_NAME} couldn't find a move — ending the game.`,
        });
      }
      game.chess.move(aiMove);
      const aiLastMove = { from: aiMove.from, to: aiMove.to };

      if (game.chess.isGameOver()) {
        chessGames.delete(chatId);
        release(chatId, 'chess');
        return sendBoard(msg, chat, game.chess, {
          lastMove: aiLastMove,
          caption: `${moverName} played *${humanResult.san}*\n🤖 ${BOT_NAME} played *${aiMove.san}*\n\n${describeGameOver(game.chess, game.whiteName, game.blackName)}`,
        });
      }

      return sendBoard(msg, chat, game.chess, {
        lastMove: aiLastMove,
        caption: `${moverName} played *${humanResult.san}*\n🤖 ${BOT_NAME} played *${aiMove.san}*\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}Your turn, ${game.whiteName}! Use *.move [e2e4]*.`,
      });
    }

    // ── vs person ───────────────────────────────────────────────────────
    const nextName = game.chess.turn() === 'w' ? game.whiteName : game.blackName;
    return sendBoard(msg, chat, game.chess, {
      lastMove: { from: humanResult.from, to: humanResult.to },
      caption: `${moverName} played *${humanResult.san}*\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}*${nextName}'s* turn! Use *.move [e2e4]*.`,
    });
  },

  // Ends an in-progress game as a forfeit/resignation by `playerId` in
  // `chatId`, if they're in one. Returns null when there's no chess game for
  // them here, so the shared .quitgame command can fall through and try
  // other game types.
  quitChess(chatId, playerId) {
    const game = chessGames.get(chatId);
    if (!game || (game.white !== playerId && game.black !== playerId)) return null;

    const quitterName = game.white === playerId ? game.whiteName : game.blackName;
    const winnerName = game.white === playerId ? game.blackName : game.whiteName;
    chessGames.delete(chatId);
    release(chatId, 'chess');
    return { quitterName, winnerName };
  },
};
