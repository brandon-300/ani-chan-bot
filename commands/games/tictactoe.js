const { MessageMedia } = require('whatsapp-web.js');
const { safeGetChat, resolveNameById } = require('../../utils/helpers');
const { getBestMove } = require('./tictactoeEngine');
const { renderBoardImage } = require('./tictactoeBoardImage');
const { BOT_NAME } = require('../../utils/config');

// ─── Active Game Sessions ─────────────────────────────────────────────────────
// chatId -> { board, mode: 'pvp' | 'bot', turn, players, names, symbols,
//             difficulty, lastMove }
// Same shape/conventions as chessGames in chess.js: in bot mode the human
// is always players[0] (symbols[0], '❌') and players[1] is the literal
// string 'BOT' — never a real WhatsApp id, so it can never accidentally
// match one. `names` is resolved once at game start and cached here — see
// the comment in the .ttt command below for why we don't just re-derive it
// from WhatsApp Contact objects every time we need to display it.
const tttGames = new Map();

const DIFFICULTY_KEYS = ['easy', 'medium', 'hard'];

// ─── Helpers ───────────────────────────────────────────────────────────────────
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

// Sends the current board as an image with `caption`. Falls back to the
// existing plain-text board (with the same caption appended) if image
// rendering fails for any reason, so the game is never blocked by it — same
// pattern as sendBoard() in chess.js.
async function sendBoard(msg, chat, game, caption) {
  try {
    const png = renderBoardImage(game.board, { symbols: game.symbols, lastMove: game.lastMove });
    const media = new MessageMedia('image/png', png.toString('base64'), 'ttt-board.png');
    await chat.sendMessage(media, { caption });
  } catch (err) {
    console.error('Tic Tac Toe board image render failed, falling back to text board:', err.message);
    await msg.reply(`${renderTTTText(game.board)}\n\n${caption}`);
  }
}

module.exports = {
  tttGames,

  // .ttt @user — play another person
  // .ttt [easy|medium|hard] — play the bot (defaults to medium)
  // .ttt [1-9] — make a move in whichever game is active (shared by both modes)
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

      const moverName = game.names[game.turn];
      game.board[row][col] = game.symbols[game.turn];
      game.lastMove = { row, col };

      let result = checkTTTWin(game.board);
      if (result) {
        tttGames.delete(chatId);
        const outcome = result === 'draw' ? "🤝 *It's a draw!*" : `🏆 *${moverName} wins!*`;
        return sendBoard(msg, chat, game, `${moverName} played position ${movePos}\n\n${outcome}`);
      }

      // ── vs bot: it replies with its own move in this same message ────────
      if (game.mode === 'bot') {
        const engineCells = toEngineCells(game.board, game.symbols);
        const botIndex = getBestMove(engineCells, 'O', 'X', game.difficulty);

        if (botIndex === null) {
          // Shouldn't happen — checkTTTWin() above already ruled out "board full".
          tttGames.delete(chatId);
          return sendBoard(msg, chat, game, `❌ ${BOT_NAME} couldn't find a move — ending the game.`);
        }

        const botRow = Math.floor(botIndex / 3);
        const botCol = botIndex % 3;
        game.board[botRow][botCol] = game.symbols[1];
        game.lastMove = { row: botRow, col: botCol };

        result = checkTTTWin(game.board);
        if (result) {
          tttGames.delete(chatId);
          const outcome = result === 'draw' ? "🤝 *It's a draw!*" : `🏆 *${game.names[1]} wins!*`;
          return sendBoard(
            msg, chat, game,
            `${moverName} played position ${movePos}\n🤖 ${BOT_NAME} played position ${botIndex + 1}\n\n${outcome}`
          );
        }

        tttGames.set(chatId, game); // game.turn stays 0 — it's the human's turn again
        return sendBoard(
          msg, chat, game,
          `${moverName} played position ${movePos}\n🤖 ${BOT_NAME} played position ${botIndex + 1}\n\nYour turn! Type *.ttt [1-9]* to play.`
        );
      }

      // ── vs person ─────────────────────────────────────────────────────────
      game.turn = game.turn === 0 ? 1 : 0;
      tttGames.set(chatId, game);

      return sendBoard(
        msg, chat, game,
        `${moverName} played position ${movePos}\n\n${game.symbols[game.turn]} ${game.names[game.turn]}'s turn! Type *.ttt [1-9]* to play.`
      );
    }

    // ── A stray move number with no active game ─────────────────────────────
    if (!game && !isNaN(movePos)) {
      return msg.reply('❌ No Tic Tac Toe game active. Start one with *.ttt @user* (vs a person) or *.ttt [easy|medium|hard]* (vs the bot).');
    }

    if (game) return msg.reply('❌ A game is already in progress!');

    // ── Otherwise, this is a request to start a new game ────────────────────
    const mentioned = await msg.getMentions();
    const playerId = contact.id._serialized;

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
    const playerName = await resolveNameById(client, playerId);
    const board = Array.from({ length: 3 }, () => ['·', '·', '·']);
    const symbols = ['❌', '⭕'];

    if (mentioned.length) {
      // ── vs person ────────────────────────────────────────────────────────
      const opponentId = mentioned[0].id._serialized;
      const opponentName = await resolveNameById(client, opponentId);

      const newGame = {
        board, turn: 0, symbols, mode: 'pvp',
        players: [playerId, opponentId],
        names: [playerName, opponentName],
        lastMove: null,
      };
      tttGames.set(chatId, newGame);

      return sendBoard(
        msg, chat, newGame,
        `🎮 *Tic Tac Toe*\n${playerName} (❌) vs ${opponentName} (⭕)\n\n❌ ${playerName}'s turn! Type *.ttt [1-9]* to play.`
      );
    }

    // ── vs bot ────────────────────────────────────────────────────────────
    const difficultyLabel = DIFFICULTY_KEYS.includes((args[0] || '').toLowerCase()) ? args[0].toLowerCase() : 'medium';

    const newGame = {
      board, turn: 0, symbols, mode: 'bot', difficulty: difficultyLabel,
      players: [playerId, 'BOT'],
      names: [playerName, `🤖 ${BOT_NAME}`],
      lastMove: null,
    };
    tttGames.set(chatId, newGame);

    return sendBoard(
      msg, chat, newGame,
      `🎮 *Tic Tac Toe vs ${BOT_NAME}* (${difficultyLabel})\n\n❌ You: ${playerName}\n⭕ 🤖 ${BOT_NAME}\n\nYou're ❌ — type *.ttt [1-9]* to play! Mention someone instead (.ttt @user) to play a person.`
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
