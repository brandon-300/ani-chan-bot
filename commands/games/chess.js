const { Chess } = require('chess.js');
const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./chessEngine');

const BOT_NAME = process.env.BOT_NAME || 'Ani-Chan Bot';

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

      return msg.reply(
        `♟️ *Chess*\n\n♔ White: ${playerName}\n♚ Black: ${opponentName}\n\n${chess.ascii()}\n\nWhite goes first! Use *.move [e2e4]* (from-to format).`
      );
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

    return msg.reply(
      `♟️ *Chess vs ${BOT_NAME}* (${difficultyLabel})\n\n♔ White: ${playerName}\n♚ Black: 🤖 ${BOT_NAME}\n\n${chess.ascii()}\n\nYou're White — use *.move [e2e4]* (from-to format) to play! Mention someone instead (.chess @user) to play a person.${slowWarning}`
    );
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

    const result = game.chess.move({ from: moveStr.slice(0, 2), to: moveStr.slice(2, 4), promotion: 'q' });
    if (!result) return msg.reply('❌ Invalid move!');

    // Human move resolved. If the game's over now, report it and stop.
    if (game.chess.isGameOver()) {
      chessGames.delete(chatId);
      return msg.reply(`${game.chess.ascii()}\n\n${describeGameOver(game.chess, game.whiteName, game.blackName)}`);
    }

    // ── vs bot: it replies with its own move in this same message ─────────
    if (game.mode === 'bot') {
      const aiMove = getBestMove(game.chess, game.search);
      if (!aiMove) {
        // Shouldn't happen — isGameOver() above already ruled out "no moves".
        chessGames.delete(chatId);
        return msg.reply(`${game.chess.ascii()}\n\n❌ ${BOT_NAME} couldn't find a move — ending the game.`);
      }
      game.chess.move(aiMove);

      if (game.chess.isGameOver()) {
        chessGames.delete(chatId);
        return msg.reply(
          `🤖 ${BOT_NAME} plays *${aiMove.san}*\n\n${game.chess.ascii()}\n\n${describeGameOver(game.chess, game.whiteName, game.blackName)}`
        );
      }

      return msg.reply(
        `🤖 ${BOT_NAME} plays *${aiMove.san}*\n\n${game.chess.ascii()}\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}Your turn, ${game.whiteName}!`
      );
    }

    // ── vs person ───────────────────────────────────────────────────────
    const nextName = game.chess.turn() === 'w' ? game.whiteName : game.blackName;
    return msg.reply(`${game.chess.ascii()}\n\n${game.chess.isCheck() ? '⚠️ Check!\n' : ''}*${nextName}'s* turn!`);
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
    return { quitterName, winnerName };
  },
};
