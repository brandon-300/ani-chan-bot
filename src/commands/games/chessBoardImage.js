// Renders a chess.js board position as a PNG image — coordinates, real
// chess piece shapes, and a last-move highlight. Pure JS raster drawing on
// top of pngEncoder.js; no image/graphics library involved, so there's
// nothing new to install and no native-binary platform risk (this project
// has already hit that once, with sharp on Termux/Android — see project
// history).
//
// A note on "Unicode chess glyphs": there's no font-rendering engine
// anywhere in this pipeline — it's raw pixel drawing, the same way the old
// circle-token version worked. That means literal Unicode characters like
// ♞ can't actually be drawn here; rendering real font glyphs would require
// a text-rendering engine (e.g. reusing the WhatsApp session's Chromium via
// client.pupBrowser to screenshot HTML, or a native canvas/SVG library).
// Both add either a shared-resource dependency on the live WhatsApp browser
// or the exact kind of native-binary Android risk this project deliberately
// avoided when this renderer was first built. Instead, each piece is drawn
// as a small hand-built silhouette — a rook's crenellated tower, a bishop's
// mitre, a knight's head with an ear and snout, a king's cross, a queen's
// pointed crown, a pawn's ball-and-cone — visually verified before use, the
// same way the old circle tokens and the coordinate-label bitmap font were.

const { encodePNG } = require('../../utils/pngEncoder');

// ─── 5x7 bitmap font — coordinate labels only (a-h, 1-8) ─────────────────────
const FONT = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  'a': ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  'b': ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '##.##'],
  'c': ['.....', '.....', '.###.', '#....', '#....', '#....', '.###.'],
  'd': ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  'e': ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  'f': ['..##.', '.#..#', '.#...', '###..', '.#...', '.#...', '.#...'],
  'g': ['.....', '.####', '#...#', '#...#', '.####', '....#', '.###.'],
  'h': ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
};

// ─── Drawing primitives ────────────────────────────────────────────────────
function setPixel(pixels, w, h, x, y, color) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const idx = (y * w + x) * 3;
  pixels[idx] = color[0];
  pixels[idx + 1] = color[1];
  pixels[idx + 2] = color[2];
}

function fillRect(pixels, w, h, x, y, rw, rh, color) {
  const y0 = Math.round(y), y1 = Math.round(y + rh);
  for (let py = y0; py < y1; py++) {
    for (let px = x; px < x + rw; px++) {
      setPixel(pixels, w, h, px, py, color);
    }
  }
}

function fillCircle(pixels, w, h, cx, cy, r, color) {
  const r2 = r * r;
  for (let py = cy - r; py <= cy + r; py++) {
    for (let px = cx - r; px <= cx + r; px++) {
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy <= r2) setPixel(pixels, w, h, px, py, color);
    }
  }
}

// Draws a vertically-symmetric silhouette from a list of per-row half-widths
// (top to bottom), each row `rowH` pixels tall, centered on `cx`. Used for
// every piece's tapered body/base — pawns, rooks, bishops, queens and kings
// are all left-right symmetric, so this one helper covers all of them.
function fillSymmetricRows(pixels, w, h, cx, topY, rows, rowH, color) {
  rows.forEach((halfW, i) => {
    if (halfW <= 0) return;
    fillRect(pixels, w, h, cx - halfW, topY + i * rowH, halfW * 2, rowH, color);
  });
}

function drawText(pixels, w, h, text, ox, oy, scale, color) {
  let x = ox;
  for (const ch of text) {
    const rows = FONT[ch];
    if (rows) {
      for (let ry = 0; ry < 7; ry++) {
        for (let rx = 0; rx < 5; rx++) {
          if (rows[ry][rx] !== '#') continue;
          fillRect(pixels, w, h, x + rx * scale, oy + ry * scale, scale, scale, color);
        }
      }
    }
    x += 6 * scale;
  }
}

function textWidth(text, scale) {
  return text.length * 6 * scale - scale;
}

// ─── Piece silhouettes ─────────────────────────────────────────────────────
// Each piece is drawn bottom-anchored at (cx, baseY) — baseY is the pixel
// row its base sits on. All were built and visually verified together on
// realistic checkered squares before use (both colors, side by side).

function drawPawn(pixels, w, h, cx, baseY, color) {
  fillCircle(pixels, w, h, cx, baseY - 38, 8, color);
  fillSymmetricRows(pixels, w, h, cx, baseY - 28, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 2, color);
  fillRect(pixels, w, h, cx - 16, baseY - 8, 32, 8, color);
}

function drawRook(pixels, w, h, cx, baseY, color) {
  const toothW = 5, gap = 3, teeth = 3;
  const topW = teeth * toothW + (teeth - 1) * gap;
  let x = cx - topW / 2;
  for (let i = 0; i < teeth; i++) {
    fillRect(pixels, w, h, x, baseY - 46, toothW, 10, color);
    x += toothW + gap;
  }
  fillRect(pixels, w, h, cx - 13, baseY - 38, 26, 6, color);
  fillSymmetricRows(pixels, w, h, cx, baseY - 32, [11, 11, 11, 11, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15], 2, color);
  fillRect(pixels, w, h, cx - 16, baseY - 8, 32, 8, color);
}

function drawBishop(pixels, w, h, cx, baseY, color) {
  fillCircle(pixels, w, h, cx, baseY - 46, 4, color);
  fillSymmetricRows(pixels, w, h, cx, baseY - 40, [3, 4, 5, 6, 7, 7, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14], 2, color);
  fillRect(pixels, w, h, cx - 16, baseY - 8, 32, 8, color);
}

function drawKnight(pixels, w, h, cx, baseY, color, eyeColor) {
  // Asymmetric (unlike the other five pieces) — a horse head in profile,
  // facing right: ears, forehead, nose bridge, a protruding snout, a mouth
  // notch, jaw curving back, then the neck widening into the shoulders.
  const originX = cx - 14;
  const rows = [
    [11, 5], [10, 7], [9, 9], [7, 12], [6, 13], [5, 15], [5, 16],
    [4, 19], [4, 20], [3, 22], [3, 20], [5, 15], [7, 13], [8, 14],
    [7, 17], [6, 19], [5, 21], [4, 23], [3, 25],
  ];
  rows.forEach(([xStart, width], i) => {
    fillRect(pixels, w, h, originX + xStart, baseY - 50 + i * 2.5, width, 2.5, color);
  });
  setPixel(pixels, w, h, originX + 10, baseY - 43, eyeColor);
  setPixel(pixels, w, h, originX + 11, baseY - 43, eyeColor);
  fillRect(pixels, w, h, cx - 16, baseY - 8, 32, 8, color);
}

function drawQueen(pixels, w, h, cx, baseY, color) {
  const pts = 5, spacing = 7;
  for (let i = 0; i < pts; i++) {
    const px = cx - (pts - 1) * spacing / 2 + i * spacing;
    fillCircle(pixels, w, h, px, baseY - 48, 3, color);
  }
  fillRect(pixels, w, h, cx - 15, baseY - 42, 30, 6, color);
  fillSymmetricRows(pixels, w, h, cx, baseY - 36, [10, 10, 9, 9, 9, 10, 11, 12, 13, 14], 2, color);
  fillRect(pixels, w, h, cx - 16, baseY - 8, 32, 8, color);
}

function drawKing(pixels, w, h, cx, baseY, color) {
  fillRect(pixels, w, h, cx - 2, baseY - 56, 4, 10, color); // cross, vertical
  fillRect(pixels, w, h, cx - 7, baseY - 52, 14, 4, color); // cross, horizontal
  fillRect(pixels, w, h, cx - 15, baseY - 42, 30, 6, color);
  fillSymmetricRows(pixels, w, h, cx, baseY - 36, [10, 10, 9, 9, 9, 10, 11, 12, 13, 14], 2, color);
  fillRect(pixels, w, h, cx - 16, baseY - 8, 32, 8, color);
}

const PIECE_DRAWERS = { p: drawPawn, r: drawRook, b: drawBishop, n: drawKnight, q: drawQueen, k: drawKing };

function drawPiece(pixels, w, h, type, color, cx, baseY) {
  const drawer = PIECE_DRAWERS[type];
  if (!drawer) return;
  const fillColor = color === 'w' ? WHITE_PIECE : BLACK_PIECE;
  if (type === 'n') {
    const eyeColor = color === 'w' ? WHITE_PIECE_DETAIL : BLACK_PIECE_DETAIL;
    drawer(pixels, w, h, cx, baseY, fillColor, eyeColor);
  } else {
    drawer(pixels, w, h, cx, baseY, fillColor);
  }
}

// ─── Palette ────────────────────────────────────────────────────────────────
const LIGHT_SQUARE = [235, 224, 200];
const DARK_SQUARE = [140, 100, 70];
const HIGHLIGHT_LIGHT = [240, 220, 120];
const HIGHLIGHT_DARK = [200, 170, 60];
const BOARD_BG = [30, 28, 26];
const COORD_COLOR = [200, 195, 185];
const WHITE_PIECE = [248, 246, 240];
const WHITE_PIECE_DETAIL = [60, 55, 50]; // e.g. the knight's eye, on a light piece
const BLACK_PIECE = [35, 32, 30];
const BLACK_PIECE_DETAIL = [220, 215, 205]; // e.g. the knight's eye, on a dark piece

const SQUARE = 64;
const MARGIN = 28;
const BOARD_PX = SQUARE * 8;
const IMG_SIZE = BOARD_PX + MARGIN * 2;

/**
 * Render a chess.js board position to a PNG buffer.
 * @param {import('chess.js').Chess} chess
 * @param {Object} [opts]
 * @param {'w'|'b'} [opts.perspective='w'] - Which side's view to render from.
 *   'b' flips the board (rank 1 at top, files h→a left-to-right).
 * @param {{from: string, to: string}|null} [opts.lastMove=null] - Squares to highlight.
 * @returns {Buffer} PNG file buffer
 */
function renderBoardImage(chess, opts = {}) {
  const perspective = opts.perspective === 'b' ? 'b' : 'w';
  const lastMove = opts.lastMove || null;
  const board = chess.board(); // [0]=rank8..[7]=rank1, each row a1..h8 order per rank

  const pixels = Buffer.alloc(IMG_SIZE * IMG_SIZE * 3);
  fillRect(pixels, IMG_SIZE, IMG_SIZE, 0, 0, IMG_SIZE, IMG_SIZE, BOARD_BG);

  const files = 'abcdefgh';
  for (let displayRow = 0; displayRow < 8; displayRow++) {
    for (let displayCol = 0; displayCol < 8; displayCol++) {
      // Map a display cell to a board-array cell, flipping for Black's perspective.
      const boardRow = perspective === 'w' ? displayRow : 7 - displayRow;
      const boardCol = perspective === 'w' ? displayCol : 7 - displayCol;
      const square = board[boardRow][boardCol];
      const file = files[boardCol];
      const rank = 8 - boardRow;
      const squareName = `${file}${rank}`;

      const x = MARGIN + displayCol * SQUARE;
      const y = MARGIN + displayRow * SQUARE;
      const isLight = (boardRow + boardCol) % 2 === 0;
      const isHighlighted = lastMove && (squareName === lastMove.from || squareName === lastMove.to);

      const squareColor = isHighlighted
        ? (isLight ? HIGHLIGHT_LIGHT : HIGHLIGHT_DARK)
        : (isLight ? LIGHT_SQUARE : DARK_SQUARE);
      fillRect(pixels, IMG_SIZE, IMG_SIZE, x, y, SQUARE, SQUARE, squareColor);

      if (square) {
        const cx = x + SQUARE / 2;
        const baseY = y + SQUARE - 6;
        drawPiece(pixels, IMG_SIZE, IMG_SIZE, square.type, square.color, cx, baseY);
      }
    }
  }

  // Coordinate labels along the bottom (files) and left (ranks), matching
  // whichever perspective is being rendered.
  const displayFiles = perspective === 'w' ? files.split('') : files.split('').reverse();
  const displayRanks = perspective === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = 0; i < 8; i++) {
    drawText(pixels, IMG_SIZE, IMG_SIZE, displayFiles[i], MARGIN + i * SQUARE + SQUARE / 2 - 7, IMG_SIZE - MARGIN + 8, 2, COORD_COLOR);
    drawText(pixels, IMG_SIZE, IMG_SIZE, String(displayRanks[i]), 8, MARGIN + i * SQUARE + SQUARE / 2 - 7, 2, COORD_COLOR);
  }

  return encodePNG(pixels, IMG_SIZE, IMG_SIZE, 3);
}

module.exports = { renderBoardImage };
