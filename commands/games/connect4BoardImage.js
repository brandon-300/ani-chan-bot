// Renders a Connect 4 board as a PNG image — same pure-JS raster drawing
// approach as chessBoardImage.js / tictactoeBoardImage.js (no image/graphics
// library, nothing new to install, no native-binary risk on Termux/Android).
// Classic blue board with punched-out slots; a thin ring is drawn around
// the most recently dropped piece so it's easy to spot at a glance.

const { encodePNG } = require('../../utils/pngEncoder');

// ─── 5x7 bitmap font — digits 1-7 only (column numbers) ────────────────────
// Same style/weight as the coordinate-label fonts in chessBoardImage.js and
// tictactoeBoardImage.js, copied verbatim for 1-7 so all three boards' text
// reads consistently.
const FONT = {
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
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

function fillCircle(pixels, w, h, cx, cy, r, color) {
  const r2 = r * r;
  for (let py = cy - r; py <= cy + r; py++) {
    for (let px = cx - r; px <= cx + r; px++) {
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy <= r2) setPixel(pixels, w, h, px, py, color);
    }
  }
}

// A thin ring (not filled) around the most recently dropped piece — same
// distance-band technique as the "O" ring in tictactoeBoardImage.js.
function drawRing(pixels, w, h, cx, cy, radius, thickness, color) {
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

// ─── Palette ────────────────────────────────────────────────────────────────
const BG = [20, 20, 25];
const BOARD_BLUE = [30, 80, 180];
const EMPTY_SLOT = [235, 235, 230];
const RED_PIECE = [210, 45, 45];
const YELLOW_PIECE = [235, 190, 40];
const HIGHLIGHT_RING = [255, 255, 255];
const LABEL_COLOR = [200, 195, 185];

const CELL = 72;
const MARGIN_SIDE = 24;
const MARGIN_TOP = 44; // room for column number labels above the board
const MARGIN_BOTTOM = 20;
const BOARD_PX_W = CELL * 7;
const BOARD_PX_H = CELL * 6;
const IMG_W = BOARD_PX_W + MARGIN_SIDE * 2;
const IMG_H = MARGIN_TOP + BOARD_PX_H + MARGIN_BOTTOM;

/**
 * Render a Connect 4 board to a PNG buffer.
 * @param {string[][]} board - 6x7 array; each cell is '⬛' (empty), '🔴', or
 *   '🟡' — same values connect4.js already stores directly, so no
 *   conversion layer is needed here (unlike tictactoeBoardImage.js, where
 *   the display symbols are configurable — Connect 4's are fixed constants
 *   throughout connect4.js already).
 * @param {{row:number,col:number}|null} [opts.lastMove=null] - most
 *   recently dropped piece, highlighted with a ring.
 * @returns {Buffer} PNG file buffer
 */
function renderBoardImage(board, opts = {}) {
  const lastMove = opts.lastMove || null;

  const pixels = Buffer.alloc(IMG_W * IMG_H * 3);
  fillRect(pixels, IMG_W, IMG_H, 0, 0, IMG_W, IMG_H, BG);
  fillRect(pixels, IMG_W, IMG_H, MARGIN_SIDE, MARGIN_TOP, BOARD_PX_W, BOARD_PX_H, BOARD_BLUE);

  for (let col = 0; col < 7; col++) {
    drawText(pixels, IMG_W, IMG_H, String(col + 1), MARGIN_SIDE + col * CELL + CELL / 2 - 3, MARGIN_TOP - 26, 2, LABEL_COLOR);
  }

  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 7; col++) {
      const cx = MARGIN_SIDE + col * CELL + CELL / 2;
      const cy = MARGIN_TOP + row * CELL + CELL / 2;
      const radius = Math.round(CELL * 0.4);
      const cell = board[row][col];

      let color = EMPTY_SLOT;
      if (cell === '🔴') color = RED_PIECE;
      else if (cell === '🟡') color = YELLOW_PIECE;

      fillCircle(pixels, IMG_W, IMG_H, cx, cy, radius, color);

      if (lastMove && lastMove.row === row && lastMove.col === col) {
        drawRing(pixels, IMG_W, IMG_H, cx, cy, radius + 3, 3, HIGHLIGHT_RING);
      }
    }
  }

  return encodePNG(pixels, IMG_W, IMG_H, 3);
}

module.exports = { renderBoardImage };
