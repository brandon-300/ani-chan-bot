// Renders a Tic Tac Toe board as a PNG image — same pure-JS raster drawing
// approach as commands/games/chessBoardImage.js (no image/graphics library,
// nothing new to install, no native-binary risk on Termux/Android). X's and
// O's are drawn with distance-based math (a diagonal-line test for X, a
// ring test for O) rather than pre-made glyphs, and empty cells get a faint
// position number (1-9) drawn with the same small bitmap font style as the
// chess board's coordinate labels, so players can still see which number to
// type without needing a separate text-only board.

const { encodePNG } = require('../../utils/pngEncoder');

// ─── 5x7 bitmap font — digits 1-9 only ─────────────────────────────────────
// Same style/weight as the coordinate-label font in chessBoardImage.js
// (1-8 copied verbatim so both boards' text reads consistently); 9 added
// here since chess never needed it (ranks only go to 8).
const FONT = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
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
  const x0 = Math.round(x), x1 = Math.round(x + rw);
  const y0 = Math.round(y), y1 = Math.round(y + rh);
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      setPixel(pixels, w, h, px, py, color);
    }
  }
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

// Draws an X inside the square [x0,y0]..[x0+size,y0+size] — two diagonal
// strokes, each `thickness` px wide, built from a distance-to-line test
// rather than a pre-made glyph (there's no font-rendering engine in this
// pipeline, same constraint documented in chessBoardImage.js).
function drawX(pixels, w, h, x0, y0, size, thickness, color) {
  for (let py = y0; py < y0 + size; py++) {
    for (let px = x0; px < x0 + size; px++) {
      const u = px - x0, v = py - y0;
      const d1 = Math.abs(v - u) / Math.SQRT2;        // ↘ diagonal
      const d2 = Math.abs(v - (size - 1 - u)) / Math.SQRT2; // ↙ diagonal
      if (d1 <= thickness / 2 || d2 <= thickness / 2) {
        setPixel(pixels, w, h, px, py, color);
      }
    }
  }
}

// Draws an O as a ring centered on (cx, cy) — a distance-from-center test
// kept between (radius - thickness/2) and (radius + thickness/2), so it
// reads as a real "O" outline instead of a filled dot.
function drawO(pixels, w, h, cx, cy, radius, thickness, color) {
  const span = radius + thickness;
  for (let py = cy - span; py <= cy + span; py++) {
    for (let px = cx - span; px <= cx + span; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(dist - radius) <= thickness / 2) {
        setPixel(pixels, w, h, px, py, color);
      }
    }
  }
}

// ─── Palette ────────────────────────────────────────────────────────────────
const BG = [30, 28, 26];
const CELL_BG = [245, 240, 232];
const CELL_HIGHLIGHT = [250, 224, 140]; // background behind the last move made
const GRID_COLOR = [60, 55, 50];
const X_COLOR = [220, 70, 100];   // matches the ❌ symbol
const O_COLOR = [70, 130, 220];   // matches the ⭕ symbol
const LABEL_COLOR = [175, 168, 158]; // faint position numbers in empty cells

const CELL = 120;
const MARGIN = 24;
const GRID_THICKNESS = 6;
const BOARD_PX = CELL * 3;
const IMG_SIZE = BOARD_PX + MARGIN * 2;

/**
 * Render a Tic Tac Toe board to a PNG buffer.
 * @param {string[][]} board - 3x3 array; each cell is '·' (empty) or one of
 *   the two entries in `symbols`.
 * @param {Object} [opts]
 * @param {[string,string]} [opts.symbols=['❌','⭕']] - which emoji marks
 *   player 1 vs player 2 in `board` — used only to decide X-shape vs
 *   O-shape per cell, never drawn as text/emoji (no font-rendering engine
 *   here, same constraint as chessBoardImage.js).
 * @param {{row:number,col:number}|null} [opts.lastMove=null] - cell to
 *   highlight as the most recent move.
 * @returns {Buffer} PNG file buffer
 */
function renderBoardImage(board, opts = {}) {
  const symbols = opts.symbols || ['❌', '⭕'];
  const lastMove = opts.lastMove || null;

  const pixels = Buffer.alloc(IMG_SIZE * IMG_SIZE * 3);
  fillRect(pixels, IMG_SIZE, IMG_SIZE, 0, 0, IMG_SIZE, IMG_SIZE, BG);

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x0 = MARGIN + col * CELL;
      const y0 = MARGIN + row * CELL;
      const isHighlighted = lastMove && lastMove.row === row && lastMove.col === col;

      fillRect(pixels, IMG_SIZE, IMG_SIZE, x0, y0, CELL, CELL, isHighlighted ? CELL_HIGHLIGHT : CELL_BG);

      const cell = board[row][col];
      if (cell === symbols[0]) {
        const pad = Math.round(CELL * 0.2);
        drawX(pixels, IMG_SIZE, IMG_SIZE, x0 + pad, y0 + pad, CELL - pad * 2, Math.round(CELL * 0.12), X_COLOR);
      } else if (cell === symbols[1]) {
        const cx = x0 + CELL / 2, cy = y0 + CELL / 2;
        const radius = Math.round(CELL * 0.32);
        drawO(pixels, IMG_SIZE, IMG_SIZE, cx, cy, radius, Math.round(CELL * 0.14), O_COLOR);
      } else {
        // Empty cell — draw its 1-9 position number faintly in the corner.
        const posNum = String(row * 3 + col + 1);
        drawText(pixels, IMG_SIZE, IMG_SIZE, posNum, x0 + 10, y0 + 10, 2, LABEL_COLOR);
      }
    }
  }

  // Grid lines drawn on top of cell fills, at the two interior boundaries.
  for (const i of [1, 2]) {
    fillRect(pixels, IMG_SIZE, IMG_SIZE, MARGIN + i * CELL - GRID_THICKNESS / 2, MARGIN, GRID_THICKNESS, BOARD_PX, GRID_COLOR);
    fillRect(pixels, IMG_SIZE, IMG_SIZE, MARGIN, MARGIN + i * CELL - GRID_THICKNESS / 2, BOARD_PX, GRID_THICKNESS, GRID_COLOR);
  }

  return encodePNG(pixels, IMG_SIZE, IMG_SIZE, 3);
}

module.exports = { renderBoardImage };
