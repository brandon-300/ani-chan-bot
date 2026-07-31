// Chess AI — adapted from a Three.js chess engine the user wrote for another
// project. That engine's own move generator/legality checker is NOT used
// here: chess.js (already a dependency, already trusted for PvP mode) does
// that more completely — castling rights, en passant, checkmate, stalemate,
// threefold repetition, and the 50-move rule are all handled correctly by
// chess.js, whereas the original engine only covered a subset. What *is*
// ported over is the genuinely reusable part: the piece-square-table
// evaluation weights and the alpha-beta search structure, rewired to make
// moves on a shared chess.js instance (move/undo) instead of copying a
// custom 64-cell array on every node.

// ─── Evaluation weights (ported from the uploaded engine, with one fix) ──────
// The original PST.p (pawn) table had 65 values instead of 64 — a stray
// extra entry inserted mid-array. It only ever affected a back-rank index
// (a pawn can't occupy that square mid-game; it promotes there instead), so
// it was harmless in practice, but the 64-value table below is the
// corrected version.
const PV = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const PST = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,5,10,10,-20,-20,10,10, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
};

// Static material + positional evaluation, from `color`'s point of view
// (positive = good for `color`). Reads chess.js's own board() output
// directly (rank8→rank1 rows), so no separate board representation is kept
// in sync — chess.js's Chess instance is the single source of truth.
function evaluate(chess, color) {
  const board = chess.board();
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = board[r][c];
      if (!sq) continue;
      const i = r * 8 + c;
      const pi = sq.color === 'w' ? i : 63 - i; // mirror PST lookup for black
      const val = PV[sq.type] + (PST[sq.type] ? PST[sq.type][pi] : 0);
      score += sq.color === 'w' ? val : -val;
    }
  }
  return color === 'w' ? score : -score;
}

// Cheap move-ordering heuristic so alpha-beta prunes more — try
// captures/promotions/castling first. Same idea as the uploaded engine's
// `smv()`, using chess.js's own move-object fields instead of a hand-rolled
// board diff.
function moveScore(m) {
  let s = 0;
  if (m.captured) s += (PV[m.captured] || 0) * 10 - (PV[m.piece] || 0);
  if (m.promotion) s += PV[m.promotion] || 0;
  if (m.isKingsideCastle() || m.isQueensideCastle()) s += 50;
  return s;
}

function minimax(chess, depth, alpha, beta, maximizing, color) {
  if (chess.isGameOver()) {
    if (chess.isCheckmate()) {
      // chess.turn() is the side with no legal moves left — they're the one
      // who got mated. Slight depth bonus so the AI prefers a faster mate
      // (or, if losing, the slowest loss) over an equally-scored slower one.
      return chess.turn() === color ? -100000 - depth : 100000 + depth;
    }
    return 0; // any draw: stalemate, threefold, 50-move, insufficient material
  }
  if (depth === 0) return evaluate(chess, color);

  const moves = chess.moves({ verbose: true });
  moves.sort((a, b) => moveScore(b) - moveScore(a));

  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false, color));
      chess.undo();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true, color));
      chess.undo();
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

// Iterative deepening with a wall-clock time budget — same shape as the
// uploaded engine's getBestMoveAsync(), simplified to run synchronously.
// A hard time budget matters more here than it did in the browser: this bot
// is single-threaded and processes commands from one queue, so a slow
// search would stall every other command in the chat, not just the chess
// game, for as long as it runs. Defaults are deliberately conservative for
// a budget Android phone (Termux) rather than tuned for maximum strength.
function getBestMove(chess, { maxDepth = 3, timeLimitMs = 2500 } = {}) {
  const color = chess.turn();
  const startTime = Date.now();
  let bestMoveOverall = null;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;
    moves.sort((a, b) => moveScore(b) - moveScore(a));

    let bestMove = moves[0];
    let bestVal = -Infinity;
    let timedOut = false;

    for (const m of moves) {
      chess.move(m);
      const val = minimax(chess, depth - 1, -Infinity, Infinity, false, color);
      chess.undo();
      if (val > bestVal) {
        bestVal = val;
        bestMove = m;
      }
      if (Date.now() - startTime > timeLimitMs) {
        timedOut = true;
        break;
      }
    }

    bestMoveOverall = bestMove;
    if (timedOut || Date.now() - startTime > timeLimitMs) break;
  }

  return bestMoveOverall;
}

module.exports = { getBestMove };
