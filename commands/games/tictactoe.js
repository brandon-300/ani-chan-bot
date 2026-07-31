const { mentionName, safeGetChat } = require('../../utils/helpers');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, turn, players, symbols }
const tttGames = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
function renderTTT(board) {
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

module.exports = {
  tttGames,

  // .ttt — start a game, or (if one's active) .ttt [1-9] to make a move
  async ttt(client, msg, args) {
    const chat = await safeGetChat(msg);
    if (!chat) return;
    const contact = await msg.getContact();
    const chatId = chat.id._serialized;

    const game = tttGames.get(chatId);
    const movePos = parseInt(args[0]);

    // ── Active game + numeric arg = this is a move ──────────────────────────
    if (game && !isNaN(movePos)) {
      if (movePos < 1 || movePos > 9) return msg.reply('❌ Choose a position 1-9.');

      if (!game.players.includes(contact.id._serialized)) {
        return msg.reply("❌ You're not part of this game!");
      }

      const currentPlayerId = game.players[game.turn];
      if (currentPlayerId !== contact.id._serialized) {
        const waitingOn = await client.getContactById(currentPlayerId);
        return msg.reply(`❌ Not your turn! Waiting on ${mentionName(waitingOn)}.`);
      }

      const row = Math.floor((movePos - 1) / 3);
      const col = (movePos - 1) % 3;

      if (game.board[row][col] !== '·') {
        return msg.reply('❌ That spot is already taken! Choose another.');
      }

      game.board[row][col] = game.symbols[game.turn];

      const result = checkTTTWin(game.board);
      if (result) {
        tttGames.delete(chatId);
        if (result === 'draw') {
          return msg.reply(`${renderTTT(game.board)}\n\n🤝 *It's a draw!*`);
        }
        const winner = await client.getContactById(currentPlayerId);
        return msg.reply(`${renderTTT(game.board)}\n\n🏆 *${mentionName(winner)} wins!* (${result})`);
      }

      game.turn = game.turn === 0 ? 1 : 0;
      tttGames.set(chatId, game);

      const nextContact = await client.getContactById(game.players[game.turn]);
      return msg.reply(
        `${renderTTT(game.board)}\n\n${game.symbols[game.turn]} ${mentionName(nextContact)}'s turn! Type *.ttt [1-9]* to play.`
      );
    }

    // ── Otherwise, this is a request to start a new game ────────────────────
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to play! .ttt @user');
    if (tttGames.has(chatId)) return msg.reply('❌ A game is already in progress!');

    const board = Array.from({ length: 3 }, () => ['·', '·', '·']);
    const players = [contact.id._serialized, mentioned[0].id._serialized];

    tttGames.set(chatId, { board, turn: 0, players, symbols: ['❌', '⭕'] });

    msg.reply(
      `🎮 *Tic Tac Toe*\n${mentionName(contact)} (❌) vs ${mentionName(mentioned[0])} (⭕)\n\n${renderTTT(board)}\n\n❌ ${mentionName(contact)}'s turn! Type *.ttt [1-9]* to play.`
    );
  },
};
