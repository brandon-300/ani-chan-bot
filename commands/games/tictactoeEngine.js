// Tic Tac Toe bot AI. Unlike chessEngine.js, this doesn't need alpha-beta
// pruning or a time budget — the entire game tree from any position is at
// most 9 plies deep and a few thousand nodes, so a full unpruned minimax
// finishes in well under a millisecond even on a budget Android phone.
//
// Because search depth was never the bottleneck, difficulty here isn't
// depth-limited (chess's approach) — a shallow-depth-limited minimax would
// still play at a very high standard on a board this small, so it wouldn't
// actually produce an easier opponent. Instead, difficulty is a chance of
// playing a random legal move instead of the minimax-optimal one: 'hard'
// always plays optimally (perfect play from either side is a well-known
// result — an optimal opponent can never be beaten, only drawn), 'easy' and
// 'medium' occasionally play a weaker move so newer/younger players can
// actually win sometimes.

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],           // diagonals
];

// `cells` is a flat array of 9: null (empty), or 'X'/'O'. Returns 'X', 'O',
// 'draw', or null (game still in progress).
function checkWinner(cells) {
  for (const [a, b, c] of WIN_LINES) {
    if (cells[a] && cells[a] === cells[b] && cells[b] === cells[c]) return cells[a];
  }
  if (cells.every(c => c !== null)) return 'draw';
  return null;
}

// Returns { index, score } for the best move available to `player` from
// this position — score is from `botSymbol`'s perspective (positive =
// good for the bot) regardless of whose turn it currently is, same
// convention chessEngine.js's evaluate() uses. A depth term keeps the bot
// preferring a faster win / slower loss over an equally-scored alternative,
// same reasoning as chessEngine.js's mate-distance bonus.
function minimax(cells, player, botSymbol, humanSymbol, depth) {
  const winner = checkWinner(cells);
  if (winner === botSymbol) return { index: -1, score: 10 - depth };
  if (winner === humanSymbol) return { index: -1, score: depth - 10 };
  if (winner === 'draw') return { index: -1, score: 0 };

  const nextPlayer = player === botSymbol ? humanSymbol : botSymbol;
  let best = null;

  for (let i = 0; i < 9; i++) {
    if (cells[i] !== null) continue;
    cells[i] = player;
    const result = minimax(cells, nextPlayer, botSymbol, humanSymbol, depth + 1);
    cells[i] = null;

    const candidate = { index: i, score: result.score };
    if (best === null) {
      best = candidate;
    } else if (player === botSymbol ? candidate.score > best.score : candidate.score < best.score) {
      best = candidate;
    }
  }

  return best;
}

const MISTAKE_CHANCE = { easy: 0.6, medium: 0.25, hard: 0 };

/**
 * @param {(string|null)[]} cells - flat 9-cell board, null/'X'/'O'.
 * @param {string} botSymbol - 'X' or 'O', whichever the bot is playing.
 * @param {string} humanSymbol - the other one.
 * @param {'easy'|'medium'|'hard'} [difficulty='medium']
 * @returns {number|null} index 0-8 of the chosen cell, or null if the
 *   board is already full (shouldn't happen — callers check isGameOver
 *   first, same pattern as chessEngine.js's getBestMove).
 */
function getBestMove(cells, botSymbol, humanSymbol, difficulty = 'medium') {
  const empties = [];
  for (let i = 0; i < 9; i++) if (cells[i] === null) empties.push(i);
  if (!empties.length) return null;

  const mistakeChance = MISTAKE_CHANCE[difficulty] ?? MISTAKE_CHANCE.medium;
  if (Math.random() < mistakeChance) {
    return empties[Math.floor(Math.random() * empties.length)];
  }

  const best = minimax(cells.slice(), botSymbol, botSymbol, humanSymbol, 0);
  return best.index;
}

module.exports = { getBestMove };
