// Connect 4 bot AI — alpha-beta minimax over a heuristic evaluation
// function, same depth + time-budget approach as chessEngine.js and for the
// same reason: this bot is single-threaded and processes commands from one
// shared queue, so an unbounded search would stall every other command in
// every chat, not just this game.
//
// Unlike tic-tac-toe (tictactoeEngine.js), Connect 4's full game tree is far
// too large to search exhaustively on a budget Android phone (up to 7
// choices per move across up to 42 plies, vs. tic-tac-toe's 9 total cells) —
// a true game-theoretic solve requires either a perfect opening-book /
// endgame database or a dedicated solver, neither of which fits this
// project. Instead this uses the standard heuristic: score every possible
// 4-in-a-row "window" on the board by how many of the evaluating side's
// pieces (and empties) it contains, with a bonus for center-column control
// (center columns participate in more possible 4-in-a-row lines than edge
// columns, so pieces there are worth more even before any line is close to
// complete).

const ROWS = 6, COLS = 7;
const CENTER_COL = 3;
const EMPTY = '⬛';

// Center-out column search order — most games are decided by center control,
// so trying center columns first lets alpha-beta prune far more of the tree
// than a plain left-to-right order would.
const COLUMN_ORDER = [3, 2, 4, 1, 5, 0, 6];

function cloneBoard(board) {
  return board.map(row => row.slice());
}

// Drops `piece` into `col` on a *copy* of the caller's board; returns the
// row it landed in, or -1 if the column's already full. Mirrors dropC4() in
// connect4.js exactly — rows fill bottom-up, row 5 is the bottom row — so
// the two stay in lockstep even though this one operates on the engine's
// own scratch copies during search rather than the live game board.
function drop(board, col, piece) {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][col] === EMPTY) { board[r][col] = piece; return r; }
  }
  return -1;
}

function validColumns(board) {
  const cols = [];
  for (const c of COLUMN_ORDER) if (board[0][c] === EMPTY) cols.push(c);
  return cols;
}

// Returns the winning piece, 'draw', or null (game still in progress).
// Same four-direction window check as checkC4Win() in connect4.js, just
// also detecting a full board with no winner as a draw (connect4.js's
// version doesn't need to — the caller there checks the column-full case
// separately move-by-move).
function checkWinner(board) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p === EMPTY) continue;
      if (c + 3 < COLS && [1, 2, 3].every(i => board[r][c + i] === p)) return p;
      if (r + 3 < ROWS && [1, 2, 3].every(i => board[r + i][c] === p)) return p;
      if (r + 3 < ROWS && c + 3 < COLS && [1, 2, 3].every(i => board[r + i][c + i] === p)) return p;
      if (r + 3 < ROWS && c - 3 >= 0 && [1, 2, 3].every(i => board[r + i][c - i] === p)) return p;
    }
  }
  if (board.every(row => row.every(cell => cell !== EMPTY))) return 'draw';
  return null;
}

// Scores one 4-cell window from `me`'s perspective. Blocking an opponent's
// near-complete line is weighted very slightly higher than building the
// bot's own equivalent line (-4 vs +5 magnitude... actually kept
// symmetric-ish but blocking 3s is checked before the bot's own 3s would
// even matter, since checkWinner() at the top of minimax() already catches
// any actual 4-in-a-row before evaluate() is ever called on a decided
// position) — the small asymmetry here just nudges an otherwise-close
// decision toward not leaving an opponent's 3-in-a-row unaddressed.
function scoreWindow(cells, me, opp) {
  const myCount = cells.filter(c => c === me).length;
  const oppCount = cells.filter(c => c === opp).length;
  const emptyCount = cells.filter(c => c === EMPTY).length;

  if (myCount === 4) return 100000;
  if (oppCount === 4) return -100000;
  if (myCount === 3 && emptyCount === 1) return 5;
  if (oppCount === 3 && emptyCount === 1) return -6;
  if (myCount === 2 && emptyCount === 2) return 2;
  if (oppCount === 2 && emptyCount === 2) return -1;
  return 0;
}

function evaluate(board, me, opp) {
  let score = 0;

  for (let r = 0; r < ROWS; r++) {
    if (board[r][CENTER_COL] === me) score += 3;
    else if (board[r][CENTER_COL] === opp) score -= 3;
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += scoreWindow([board[r][c], board[r][c + 1], board[r][c + 2], board[r][c + 3]], me, opp);
    }
  }
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r <= ROWS - 4; r++) {
      score += scoreWindow([board[r][c], board[r + 1][c], board[r + 2][c], board[r + 3][c]], me, opp);
    }
  }
  for (let r = 0; r <= ROWS - 4; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += scoreWindow([board[r][c], board[r + 1][c + 1], board[r + 2][c + 2], board[r + 3][c + 3]], me, opp);
    }
  }
  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += scoreWindow([board[r][c], board[r - 1][c + 1], board[r - 2][c + 2], board[r - 3][c + 3]], me, opp);
    }
  }

  return score;
}

function minimax(board, depth, alpha, beta, maximizing, me, opp, startTime, timeLimitMs) {
  const winner = checkWinner(board);
  if (winner === me) return { score: 1000000 + depth, col: null }; // prefer a faster win
  if (winner === opp) return { score: -1000000 - depth, col: null }; // prefer a slower loss
  if (winner === 'draw') return { score: 0, col: null };

  const cols = validColumns(board);
  const outOfTime = Date.now() - startTime > timeLimitMs;
  if (depth === 0 || outOfTime) {
    return { score: evaluate(board, me, opp), col: null };
  }

  let bestCol = cols[0];
  if (maximizing) {
    let best = -Infinity;
    for (const c of cols) {
      const next = cloneBoard(board);
      drop(next, c, me);
      const { score } = minimax(next, depth - 1, alpha, beta, false, me, opp, startTime, timeLimitMs);
      if (score > best) { best = score; bestCol = c; }
      alpha = Math.max(alpha, best);
      if (beta <= alpha || Date.now() - startTime > timeLimitMs) break;
    }
    return { score: best, col: bestCol };
  } else {
    let best = Infinity;
    for (const c of cols) {
      const next = cloneBoard(board);
      drop(next, c, opp);
      const { score } = minimax(next, depth - 1, alpha, beta, true, me, opp, startTime, timeLimitMs);
      if (score < best) { best = score; bestCol = c; }
      beta = Math.min(beta, best);
      if (beta <= alpha || Date.now() - startTime > timeLimitMs) break;
    }
    return { score: best, col: bestCol };
  }
}

/**
 * @param {string[][]} board - 6x7 array, '⬛'/'🔴'/'🟡' — the live game
 *   board is passed directly; every scratch copy made during search happens
 *   internally (cloneBoard), so the caller's board is never mutated.
 * @param {string} botPiece - '🔴' or '🟡', whichever the bot is playing.
 * @param {string} humanPiece - the other one.
 * @param {{maxDepth?: number, timeLimitMs?: number}} [search]
 * @returns {number|null} column index 0-6, or null if the board is already
 *   full (shouldn't happen — callers check for a draw/column-full state
 *   first, same pattern as chessEngine.js's and tictactoeEngine.js's
 *   getBestMove).
 */
function getBestMove(board, botPiece, humanPiece, { maxDepth = 4, timeLimitMs = 2000 } = {}) {
  const cols = validColumns(board);
  if (!cols.length) return null;

  const startTime = Date.now();
  let bestColOverall = cols[0];

  // Iterative deepening: same reasoning as chessEngine.js's getBestMove —
  // always has a usable move ready from the last fully-completed depth,
  // even if a deeper search gets cut off partway through by the time budget.
  for (let depth = 1; depth <= maxDepth; depth++) {
    const { col } = minimax(board, depth, -Infinity, Infinity, true, botPiece, humanPiece, startTime, timeLimitMs);
    if (col !== null && col !== undefined) bestColOverall = col;
    if (Date.now() - startTime > timeLimitMs) break;
  }

  return bestColOverall;
}

module.exports = { getBestMove };
