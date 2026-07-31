const { safeGetChat, resolveNameById } = require('../../utils/helpers');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, turn, players: [{ id, name, piece }, { id, name, piece }] }
const c4Games = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function renderC4(board) {
  return board.map(r => r.join(' ')).join('\n') + '\n1 2 3 4 5 6 7';
}

function dropC4(board, col, piece) {
  for (let r = 5; r >= 0; r--) {
    if (board[r][col] === '⬛') { board[r][col] = piece; return r; }
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

module.exports = {
  c4Games,

  // .c4 @user — start a game
  async c4(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const mentioned = await msg.getMentions();

    if (!mentioned.length) return msg.reply('❌ Usage: .c4 @user');
    if (c4Games.has(chat.id._serialized)) return msg.reply('❌ A game is already active!');

    const playerId = contact.id._serialized;
    const opponentId = mentioned[0].id._serialized;

    // Same issue as tic-tac-toe: the sender's pushname is always accurate,
    // but a freshly-mentioned opponent's often isn't synced yet and falls
    // back to their raw phone number. resolveNameById checks our own saved
    // name first, so it works even the first time they're mentioned.
    const [playerName, opponentName] = await Promise.all([
      resolveNameById(client, playerId),
      resolveNameById(client, opponentId),
    ]);

    const board = Array.from({ length: 6 }, () => Array(7).fill('⬛'));
    const players = [
      { id: playerId, name: playerName, piece: '🔴' },
      { id: opponentId, name: opponentName, piece: '🟡' },
    ];

    c4Games.set(chat.id._serialized, { board, turn: 0, players });
    msg.reply(`🎮 *Connect 4*\n🔴 ${players[0].name} vs 🟡 ${players[1].name}\n\n${renderC4(board)}\n\n🔴 ${players[0].name}'s turn! Type *.drop [1-7]* to play.`);
  },

  // .drop [col]
  async drop(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const game = c4Games.get(chat.id._serialized);
    if (!game) return msg.reply('❌ No active Connect 4 game.');

    const current = game.players[game.turn];
    if (current.id !== contact.id._serialized) return msg.reply('❌ Not your turn!');

    const col = parseInt(args[0]) - 1;
    if (isNaN(col) || col < 0 || col > 6) return msg.reply('❌ Choose a column 1-7.');

    const row = dropC4(game.board, col, current.piece);
    if (row === -1) return msg.reply('❌ Column full! Choose another.');

    if (checkC4Win(game.board, current.piece)) {
      c4Games.delete(chat.id._serialized);
      return msg.reply(`${renderC4(game.board)}\n\n🏆 *${current.name} wins Connect 4!*`);
    }

    game.turn = game.turn === 0 ? 1 : 0;
    c4Games.set(chat.id._serialized, game);
    const next = game.players[game.turn];
    msg.reply(`${renderC4(game.board)}\n\n${next.piece} *${next.name}'s* turn!`);
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
    return { quitterName: quitter.name, winnerName: winner.name };
  },
};
