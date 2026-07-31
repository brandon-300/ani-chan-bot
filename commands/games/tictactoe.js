const { safeGetChat, resolveNameById } = require('../../utils/helpers');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, turn, players, names, symbols }
// `names` is resolved once at game start and cached here — see the comment
// on the .ttt command below for why we don't just re-derive it from
// WhatsApp Contact objects every time we need to display it.
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

      game.board[row][col] = game.symbols[game.turn];

      const result = checkTTTWin(game.board);
      if (result) {
        tttGames.delete(chatId);
        if (result === 'draw') {
          return msg.reply(`${renderTTT(game.board)}\n\n🤝 *It's a draw!*`);
        }
        return msg.reply(`${renderTTT(game.board)}\n\n🏆 *${game.names[game.turn]} wins!* (${result})`);
      }

      game.turn = game.turn === 0 ? 1 : 0;
      tttGames.set(chatId, game);

      return msg.reply(
        `${renderTTT(game.board)}\n\n${game.symbols[game.turn]} ${game.names[game.turn]}'s turn! Type *.ttt [1-9]* to play.`
      );
    }

    // ── Otherwise, this is a request to start a new game ────────────────────
    const mentioned = await msg.getMentions();
    if (!mentioned.length) return msg.reply('❌ Mention someone to play! .ttt @user');
    if (tttGames.has(chatId)) return msg.reply('❌ A game is already in progress!');

    const playerId = contact.id._serialized;
    const opponentId = mentioned[0].id._serialized;

    // msg.getContact() (the sender) always comes with an accurate pushname
    // from WhatsApp, but msg.getMentions() (the opponent) often doesn't —
    // WhatsApp only syncs a contact's pushname to us once we've seen them
    // message in this chat ourselves. Without this, the opponent falls back
    // to their raw phone number instead of their actual name. resolveNameById
    // checks our own saved name for them first, so it works even the very
    // first time they're mentioned. We resolve both once here and cache the
    // result in game state — every later message (turn prompts, win
    // announcement) reads from that cache instead of re-fetching, which also
    // means no extra network round-trips per move on shaky connections.
    const [playerName, opponentName] = await Promise.all([
      resolveNameById(client, playerId),
      resolveNameById(client, opponentId),
    ]);

    const board = Array.from({ length: 3 }, () => ['·', '·', '·']);
    const players = [playerId, opponentId];
    const names = [playerName, opponentName];

    tttGames.set(chatId, { board, turn: 0, players, names, symbols: ['❌', '⭕'] });

    msg.reply(
      `🎮 *Tic Tac Toe*\n${playerName} (❌) vs ${opponentName} (⭕)\n\n${renderTTT(board)}\n\n❌ ${playerName}'s turn! Type *.ttt [1-9]* to play.`
    );
  },

  // Ends an in-progress game as a forfeit by `playerId` in `chatId`, if
  // they're in one. Returns null when there's no ttt game for them here, so
  // a shared .quitgame command can fall through and try other game types.
  quitTTT(chatId, playerId) {
    const game = tttGames.get(chatId);
    if (!game || !game.players.includes(playerId)) return null;

    const idx = game.players.indexOf(playerId);
    const winnerIdx = idx === 0 ? 1 : 0;
    tttGames.delete(chatId);
    return { quitterName: game.names[idx], winnerName: game.names[winnerIdx] };
  },
};
