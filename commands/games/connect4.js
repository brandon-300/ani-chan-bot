const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./connect4Engine');
const { renderBoardImage } = require('./connect4BoardImage');
const { BOT_NAME } = require('../../utils/config');
const { isChatBusy, claim, release } = require('./activeGame');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, mode: 'pvp' | 'bot', turn, players, difficulty, lastMove }
// `players` is [{ id, name, piece }, { id, name, piece }] — same shape as
// before. Same conventions as chessGames/tttGames: in bot mode the human is
// always players[0] (🔴, moves first) and players[1].id is the literal
// string 'BOT' — never a real WhatsApp id, so it can never accidentally
// match one.
const c4Games = new Map();

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

const EMPTY = '⬛';

// ─── Helpers ───────────────────────────────────────────────────────────────────
function renderC4Text(board) {
  return board.map(r => r.join(' ')).join('\n') + '\n1 2 3 4 5 6 7';
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

// Sends the current board as an image with `caption`. Falls back to the
// existing plain-text board (with the same caption appended) if image
// rendering fails for any reason, so the game is never blocked by it — same
// pattern as sendBoard() in chess.js/tictactoe.js. Uses msg.reply() from the
// start (a real quoted reply bubble) rather than chat.sendMessage(), which
// was a bug found and fixed in both of those files after the fact.
async function sendBoard(msg, game, caption) {
  try {
    const png = renderBoardImage(game.board, { lastMove: game.lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'c4-board.png');
    await msg.reply(media, undefined, { caption });
  } catch (err) {
    console.error('Connect 4 board image render failed, falling back to text board:', err.message);
    await msg.reply(`${renderC4Text(game.board)}\n\n${caption}`);
  }
}

module.exports = {
  c4Games,

  // .c4 @user — play another person
  // .c4 [easy|medium|hard] — play the bot (defaults to medium)
  async c4(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();
    const chatId = chat.id._serialized;

    if (c4Games.has(chatId)) return msg.reply('❌ A game is already active!');

    const busy = isChatBusy(chatId);
    if (busy) return msg.reply(`❌ A ${busy.label} game is already active in this chat! Finish it or use *.quitgame* first.`);

    const playerId = contact.id._serialized;

    // Same issue as tic-tac-toe/chess: the sender's pushname is always
    // accurate, but a freshly-mentioned opponent's often isn't synced yet
    // and falls back to their raw phone number. resolveNameById checks our
    // own saved name first, so it works even the first time they're
    // mentioned.
    const playerName = await resolveNameById(client, playerId);
    const board = Array.from({ length: 6 }, () => Array(7).fill(EMPTY));

    if (mentioned.length) {
      // ── vs person ────────────────────────────────────────────────────────
      const opponentId = mentioned[0].id._serialized;
      const opponentName = await resolveNameById(client, opponentId);

      const players = [
        { id: playerId, name: playerName, piece: '🔴' },
        { id: opponentId, name: opponentName, piece: '🟡' },
      ];

      const game = { board, turn: 0, mode: 'pvp', players, lastMove: null };
      c4Games.set(chatId, game);
      claim(chatId, 'c4');

      return sendBoard(
        msg, game,
        `🎮 *Connect 4*\n🔴 ${playerName} vs 🟡 ${opponentName}\n\n🔴 ${playerName}'s turn! Type *.drop [1-7]* to play.`
      );
    }

    // ── vs bot ────────────────────────────────────────────────────────────
    const difficultyLabel = DIFFICULTY_KEYS.includes((args[0] || '').toLowerCase()) ? args[0].toLowerCase() : 'medium';
    const players = [
      { id: playerId, name: playerName, piece: '🔴' },
      { id: 'BOT', name: `🤖 ${BOT_NAME}`, piece: '🟡' },
    ];

    const game = { board, turn: 0, mode: 'bot', difficulty: difficultyLabel, players, lastMove: null };
    c4Games.set(chatId, game);
    claim(chatId, 'c4');

    return sendBoard(
      msg, game,
      `🎮 *Connect 4 vs ${BOT_NAME}* (${difficultyLabel})\n\n🔴 You: ${playerName}\n🟡 🤖 ${BOT_NAME}\n\nYou're 🔴 — type *.drop [1-7]* to play! Mention someone instead (.c4 @user) to play a person.`
    );
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
      c4Games.delete(chatId);
      release(chatId, 'c4');
      return sendBoard(msg, game, `🏆 *${current.name} wins Connect 4!*`);
    }

    if (isBoardFull(game.board)) {
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
    return sendBoard(msg, game, `${next.piece} *${next.name}'s* turn! Type *.drop [1-7]* to play.`);
  },

  // Ends an in-progress game as a forfeit by `playerId` in `chatId`, if
  // they're in one. Returns null when there's no c4 game for them here, so
  // the shared .quitgame command can fall through and try other game types.
  quitC4(chatId, playerId) {
    const game = c4Games.get(chatId);
    if (!game || !game.players.some(p => p.id === playerId)) return null;

    const quitter = game.players.find(p => p.id === playerId);
    const winner = game.players.find(p => p.id !== playerId);
    c4Games.delete(chatId);
    release(chatId, 'c4');
    return { quitterName: quitter.name, winnerName: winner.name };
  },
};
