// Renders the Battle HUD as a PNG image — same pure-JS raster drawing
// approach as chessBoardImage.js / tictactoeBoardImage.js /
// connect4BoardImage.js. Unlike those three, Battle has no spatial board to
// draw (it's just two HP totals and whose turn it is), so this renders two
// horizontal HP bars instead — filled proportionally to each fighter's
// current HP, colored to match the 🔵/🔴 side markers battle.js's caption
// text already uses, with a small "-25"/"+10" delta badge next to whichever
// side was just hit or healed, and a highlighted border around whoever's
// turn it is.
//
// Player names are intentionally NOT drawn into the image — they're
// arbitrary-length, arbitrary-script WhatsApp pushnames (emoji, non-Latin
// text, anything), which a small hand-built bitmap font (digits + a couple
// of symbols, same as the other three board renderers) has no way to
// render correctly. Names stay in the caption text under the image, same
// as every other detail besides HP numbers.

const { encodePNG } = require('../../utils/pngEncoder');

// ─── 5x7 bitmap font — digits 0-9 plus + / - ───────────────────────────────
// Same style/weight as the other three board renderers' fonts (1-9 copied
// verbatim); 0 and the two sign glyphs are new here since HP values and
// damage/heal deltas need them and none of the other boards did.
const FONT = {
  '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '..#..', '..#..', '.#...', '#....', '.....'],
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

// An unfilled rectangle outline, `thickness` px wide — used for the
// whose-turn highlight border around a panel.
function strokeRect(pixels, w, h, x, y, rw, rh, thickness, color) {
  fillRect(pixels, w, h, x, y, rw, thickness, color);
  fillRect(pixels, w, h, x, y + rh - thickness, rw, thickness, color);
  fillRect(pixels, w, h, x, y, thickness, rh, color);
  fillRect(pixels, w, h, x + rw - thickness, y, thickness, rh, color);
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
  return text.length * 6 * scale - scale; // no trailing gap after the last glyph
}

// ─── Palette ────────────────────────────────────────────────────────────────
const BG = [24, 22, 26];
const BAR_BG = [55, 50, 55];
const P1_COLOR = [70, 130, 220];  // matches the 🔵 marker
const P2_COLOR = [220, 70, 80];   // matches the 🔴 marker
const TURN_HIGHLIGHT = [250, 224, 140];
const HP_TEXT_COLOR = [235, 232, 225];
const DAMAGE_COLOR = [230, 70, 70];
const HEAL_COLOR = [90, 200, 110];

const IMG_W = 480;
const PANEL_H = 60;
const PANEL_GAP = 18;
const MARGIN = 22;
const BAR_H = 26;
const BAR_MAX_W = IMG_W - MARGIN * 2;
const IMG_H = MARGIN * 2 + PANEL_H * 2 + PANEL_GAP;

function drawPanel(pixels, y, hp, color, isTurn, delta) {
  const x = MARGIN;
  const barY = y + (PANEL_H - BAR_H) / 2;

  if (isTurn) {
    strokeRect(pixels, IMG_W, IMG_H, x - 6, y - 6, BAR_MAX_W + 12, PANEL_H + 12, 3, TURN_HIGHLIGHT);
  }

  fillRect(pixels, IMG_W, IMG_H, x, barY, BAR_MAX_W, BAR_H, BAR_BG);
  const fillW = Math.max(0, Math.round((Math.max(0, Math.min(100, hp)) / 100) * BAR_MAX_W));
  if (fillW > 0) fillRect(pixels, IMG_W, IMG_H, x, barY, fillW, BAR_H, color);

  const hpLabel = `${Math.max(0, Math.round(hp))}/100`;
  const scale = 2;
  const labelX = x + BAR_MAX_W / 2 - textWidth(hpLabel, scale) / 2;
  const labelY = barY + BAR_H / 2 - (7 * scale) / 2;
  drawText(pixels, IMG_W, IMG_H, hpLabel, labelX, labelY, scale, HP_TEXT_COLOR);

  if (delta) {
    const deltaText = (delta > 0 ? '+' : '-') + Math.abs(delta);
    const deltaColor = delta > 0 ? HEAL_COLOR : DAMAGE_COLOR;
    drawText(pixels, IMG_W, IMG_H, deltaText, x + BAR_MAX_W - textWidth(deltaText, 2) - 4, barY - 22, 2, deltaColor);
  }
}

/**
 * Render the Battle HUD to a PNG buffer.
 * @param {Object} state
 * @param {number} state.p1Hp - 0-100
 * @param {number} state.p2Hp - 0-100
 * @param {'p1'|'p2'|null} [state.turnSide=null] - whose turn is highlighted;
 *   null when the battle has just ended (nobody's turn anymore).
 * @param {{side:'p1'|'p2', delta:number}|null} [state.lastAction=null] -
 *   shows a "+N"/"-N" badge over whichever side just acted; positive delta
 *   is a heal (green), negative is damage taken (red).
 * @returns {Buffer} PNG file buffer
 */
function renderBoardImage(state = {}) {
  const { p1Hp = 100, p2Hp = 100, turnSide = null, lastAction = null } = state;

  const pixels = Buffer.alloc(IMG_W * IMG_H * 3);
  fillRect(pixels, IMG_W, IMG_H, 0, 0, IMG_W, IMG_H, BG);

  const p1Delta = lastAction?.side === 'p1' ? lastAction.delta : null;
  const p2Delta = lastAction?.side === 'p2' ? lastAction.delta : null;

  drawPanel(pixels, MARGIN, p1Hp, P1_COLOR, turnSide === 'p1', p1Delta);
  drawPanel(pixels, MARGIN + PANEL_H + PANEL_GAP, p2Hp, P2_COLOR, turnSide === 'p2', p2Delta);

  return encodePNG(pixels, IMG_W, IMG_H, 3);
}

module.exports = { renderBoardImage };
