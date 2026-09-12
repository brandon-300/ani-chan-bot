// ─── .fancy — Unicode fancy-text style gallery ─────────────────────────────
// Converts plain text into ~35 visually distinct styles using standard
// Unicode lookalike blocks (Mathematical Alphanumeric Symbols, Enclosed
// Alphanumerics, Fullwidth Forms, etc.) — NOT real fonts, since a text
// message can't render one; these are actual distinct codepoints that
// happen to look like a styled version of the same letter.
//
// UNCERTAINTY FLAGGED (per Brandon's rule 7, not guessed around silently):
// this was built from two phone screenshots of the reference bot's output,
// not a live connection to it, so it wasn't testable against the real
// thing. The common, well-standardized styles (bold, italic, fraktur,
// script, circled, squared, fullwidth, small caps, parenthesized, upside
// down, mirrored, reversed) are implemented from verified Unicode
// codepoints and should match exactly. The more obscure substitution-cipher
// styles (roughly #15, #18, #20-25, #29, #34 — regional-indicator,
// invisible-text, katakana-lookalike, Greek/Cyrillic/IPA-lookalike) are
// this file's own best-effort reconstruction of what those looked like in
// the screenshots, not a verified match. After deploying, run `.fancy`
// with each number on a short word and compare against Miyabi's own output
// for those specific numbers — tell me which ones don't match (and ideally
// what Miyabi's version actually looks like) and I'll correct exactly
// those, rather than guess further blind.
//
// Every style is generated at runtime from codepoint math or a small
// lookup table, not hardcoded as literal exotic glyphs sitting in this
// file's source — same reasoning as utils/helpers.js's boldSans/
// doubleStruck (avoids any risk of a mistyped/mis-copied Unicode character
// sitting invisibly in the file, and makes the exact codepoint being used
// for each letter easy to audit here rather than needing to inspect an
// opaque pasted symbol).

const DEMO_TEXT = 'Hello';

// ─── Regular Mathematical Alphanumeric Symbols blocks ──────────────────────
// The vast majority of Unicode "styled text" is one of these: a fixed
// offset from plain A-Z/a-z/0-9, EXCEPT for a handful of letters in each of
// the serif Bold, Italic, Script, and Fraktur variants that Unicode
// allocated at older, pre-existing "Letterlike Symbols" codepoints instead
// of a clean sequential run (that block predates the 2003 Mathematical
// Alphanumeric Symbols block that gave every OTHER letter its main-block
// slot) — `legacy` below is exactly those exceptions, keyed by the
// original plain-ASCII letter.
function mathBlockStyle({ upper, lower, digit, legacy }) {
  return (text) => [...text].map(ch => {
    if (legacy && legacy[ch] !== undefined) return String.fromCodePoint(legacy[ch]);
    const code = ch.codePointAt(0);
    if (upper !== undefined && code >= 65 && code <= 90) return String.fromCodePoint(upper + (code - 65));
    if (lower !== undefined && code >= 97 && code <= 122) return String.fromCodePoint(lower + (code - 97));
    if (digit !== undefined && code >= 48 && code <= 57) return String.fromCodePoint(digit + (code - 48));
    return ch;
  }).join('');
}

const styleBold        = mathBlockStyle({ upper: 0x1D400, lower: 0x1D41A, digit: 0x1D7CE });
const styleItalic      = mathBlockStyle({ upper: 0x1D434, lower: 0x1D44E, legacy: { h: 0x210E } });
const styleBoldItalic  = mathBlockStyle({ upper: 0x1D468, lower: 0x1D482 });
const styleScript      = mathBlockStyle({
  upper: 0x1D49C, lower: 0x1D4B6,
  legacy: { B: 0x212C, E: 0x2130, F: 0x2131, H: 0x210B, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211B, e: 0x212F, g: 0x210A, o: 0x2134 },
});
const styleBoldScript  = mathBlockStyle({ upper: 0x1D4D0, lower: 0x1D4EA });
const styleFraktur     = mathBlockStyle({
  upper: 0x1D504, lower: 0x1D51E,
  legacy: { C: 0x212D, H: 0x210C, I: 0x2111, R: 0x211C, Z: 0x2128 },
});
const styleBoldFraktur = mathBlockStyle({ upper: 0x1D56C, lower: 0x1D586 });
const styleDoubleStruck = mathBlockStyle({
  upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8,
  legacy: { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 },
});
const styleSans           = mathBlockStyle({ upper: 0x1D5A0, lower: 0x1D5BA, digit: 0x1D7E2 });
const styleSansBold       = mathBlockStyle({ upper: 0x1D5D4, lower: 0x1D5EE, digit: 0x1D7EC }); // == utils/helpers.js's boldSans
const styleSansItalic     = mathBlockStyle({ upper: 0x1D608, lower: 0x1D622 });
const styleSansBoldItalic = mathBlockStyle({ upper: 0x1D63C, lower: 0x1D656 });
const styleMonospace      = mathBlockStyle({ upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 });

// ─── Enclosed / Fullwidth blocks ────────────────────────────────────────────
// Circled digits are NOT a simple offset like the letter blocks above — the
// block for ①-⑨ starts at a different point than a plain "add N" formula
// would land on, and ⓪ lives at its own separate codepoint entirely — so
// this one is written out explicitly rather than through mathBlockStyle.
function styleCircledFixed(text) {
  return [...text].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x24B6 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x24D0 + (code - 97));
    if (ch === '0') return '\u24EA';
    if (code >= 49 && code <= 57) return String.fromCodePoint(0x2460 + (code - 49)); // 1-9
    return ch;
  }).join('');
}
function styleNegativeCircled(text) {
  return [...text.toUpperCase()].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F150 + (code - 65));
    return ch;
  }).join('');
}
function styleSquared(text) {
  return [...text.toUpperCase()].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F130 + (code - 65));
    return ch;
  }).join('');
}
// Same as styleSquared, but 'O' specifically becomes the 🅾️ emoji instead
// of its plain squared-letter glyph — a small flourish some generators add
// since 🅾️ already exists as its own well-known emoji (unlike most other
// squared letters, which have no everyday emoji equivalent).
function styleSquaredO(text) {
  return [...text.toUpperCase()].map(ch => {
    if (ch === 'O') return '🅾️';
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F130 + (code - 65));
    return ch;
  }).join('');
}
function styleParenthesized(text) {
  return [...text.toLowerCase()].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x249C + (code - 97));
    return ch;
  }).join('');
}
function styleFullwidth(text) {
  return [...text].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 33 && code <= 126) return String.fromCodePoint(0xFF01 + (code - 33));
    if (ch === ' ') return '\u3000';
    return ch;
  }).join('');
}
// Fullwidth with an extra literal space between every character — a
// distinct, more spread-out "aesthetic" variant of styleFullwidth.
function styleFullwidthSpaced(text) {
  return [...text].map(ch => styleFullwidth(ch)).join(' ');
}
function styleBracketed(text) {
  return [...text].map(ch => (/[a-zA-Z0-9]/.test(ch) ? `[${ch.toUpperCase()}]` : ch)).join('');
}

// ─── Regional Indicator Symbols ─────────────────────────────────────────────
// Individually these render as a boxed letter on most platforms (they only
// combine into an actual flag emoji when exactly two appear adjacently as a
// real ISO country code) — used here purely for that "letter in a box"
// visual, not to form flags.
function styleRegionalIndicator(text) {
  return [...text.toUpperCase()].map(ch => {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1F1E6 + (code - 65));
    return ch;
  }).join('');
}

// ─── Invisible text ──────────────────────────────────────────────────────────
// A real, intentional novelty category on fancy-text-generator sites (not a
// bug/placeholder) — every character becomes a zero-width space, so the
// result looks and IS blank when it's actually sent, matching what
// Brandon's screenshot shows for this slot.
function styleInvisible(text) {
  return [...text].map(() => '\u200B').join('');
}

// ─── Small Caps ──────────────────────────────────────────────────────────────
// Unicode's small-capital Latin letters are scattered across the IPA
// Extensions / Phonetic Extensions blocks (they were adopted from
// linguistics notation, not designed as a matched A-Z set) — q, s, x have
// no small-cap codepoint in wide use, so those three fall back to their
// plain lowercase form rather than guessing a nonstandard substitute.
const SMALL_CAPS = {
  a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07', f: '\uA730',
  g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A', k: '\u1D0B', l: '\u029F',
  m: '\u1D0D', n: '\u0274', o: '\u1D0F', p: '\u1D18', q: 'q', r: '\u0280',
  s: 's', t: '\u1D1B', u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',
  y: '\u028F', z: '\u1D22',
};
function styleSmallCaps(text) {
  return [...text.toLowerCase()].map(ch => SMALL_CAPS[ch] || ch).join('');
}

// ─── Accented ────────────────────────────────────────────────────────────────
const ACCENTED = {
  a: '\u00E1', e: '\u00E9', i: '\u00ED', o: '\u0151', u: '\u0171',
  A: '\u00C1', E: '\u00C9', I: '\u00CD', O: '\u0150', U: '\u0170',
};
function styleAccented(text) {
  return [...text].map(ch => ACCENTED[ch] || ch).join('');
}

const UMLAUT = {
  a: '\u00E4', e: '\u00EB', i: '\u00EF', o: '\u00F6', u: '\u00FC',
  A: '\u00C4', E: '\u00CB', I: '\u00CF', O: '\u00D6', U: '\u00DC',
};
function styleUmlaut(text) {
  return [...text].map(ch => UMLAUT[ch] || ch).join('');
}

// ─── Lookalike substitution ciphers ──────────────────────────────────────────
// Each maps a-z to a visually-similar character from a different script or
// symbol set. Applied case-insensitively (lowercased first) since none of
// these have a meaningfully different "capital" form worth maintaining
// separately.
function makeLookalike(map) {
  return (text) => [...text.toLowerCase()].map(ch => map[ch] || ch).join('');
}

const styleKatakanaLookalike = makeLookalike({
  a: '\u30A2', b: 'b', c: 'c', d: 'd', e: '\u30E8', f: 'f', g: 'g',
  h: '\u3093', i: '\u30CE', j: 'j', k: 'k', l: '\u30EB', m: 'm',
  n: '\u30F3', o: 'o', p: 'p', q: 'q', r: 'r', s: '\u30B9', t: 't',
  u: '\u30A6', v: 'v', w: 'w', x: 'x', y: 'y', z: '\u30B6',
});

const styleGreekLookalike = makeLookalike({
  a: '\u03B1', b: '\u03B2', c: 'c', d: '\u03B4', e: '\u03B5', f: '\u03C6',
  g: '\u03B3', h: '\u03B7', i: '\u03B9', j: 'j', k: '\u03BA', l: '\u03BB',
  m: '\u03BC', n: '\u03B7', o: '\u03BF', p: '\u03C1', q: 'q', r: '\u0433',
  s: '\u03C3', t: '\u03C4', u: '\u03C5', v: 'v', w: '\u03C9', x: '\u03C7',
  y: '\u03C8', z: '\u03B6',
});

const styleCyrillicLookalike = makeLookalike({
  a: '\u0430', b: '\u0431', c: '\u0441', d: '\u0434', e: '\u0435', f: '\u0444',
  g: '\u0433', h: '\u043D', i: '\u0456', j: '\u0458', k: '\u043A', l: '\u043B',
  m: '\u043C', n: '\u043F', o: '\u043E', p: '\u0440', q: 'q', r: '\u044F',
  s: '\u0455', t: '\u0442', u: '\u0446', v: 'v', w: 'w', x: '\u0445',
  y: '\u0443', z: '\u0437',
});

const styleIpaLookalike = makeLookalike({
  a: '\u0250', b: 'b', c: '\u0254', d: '\u0257', e: '\u025B', f: 'f',
  g: '\u0261', h: '\u0266', i: '\u0268', j: '\u025F', k: 'k', l: '\u0234',
  m: '\u0271', n: '\u014B', o: '\u0298', p: '\u0299', q: 'q', r: '\u0279',
  s: '\u0282', t: '\u0288', u: '\u0289', v: '\u028C', w: '\u028D', x: 'x',
  y: '\u028E', z: '\u0290',
});

const styleMixedSymbols = makeLookalike({
  a: '\u0430', b: '6', c: '\u00A9', d: '\u00D0', e: '\u20AC', f: '\u0192',
  g: '9', h: '#', i: '!', j: '\u0134', k: 'k', l: '1', m: '\u1E3F',
  n: '\u00F1', o: '0', p: '\u00DE', q: '9', r: '\u00AE', s: '$',
  t: '+', u: '\u00B5', v: '\u2228', w: '\u026F', x: '\u00D7', y: '\u00A5',
  z: '2',
});

// ─── Flip / mirror / reverse ─────────────────────────────────────────────────
// A near-complete a-z "turned upside down" lookalike set (the actual
// standard used by every "upside down text" generator) plus a matching
// digit set. Letters with no good flipped equivalent (x) map to themselves.
const UPSIDE_DOWN = {
  a: '\u0250', b: 'q', c: '\u0254', d: 'p', e: '\u01DD', f: '\u025F',
  g: '\u0183', h: '\u0265', i: '\u0131', j: '\u027E', k: '\u029E', l: 'l',
  m: '\u026F', n: 'u', o: 'o', p: 'd', q: 'b', r: '\u0279', s: 's',
  t: '\u0287', u: 'n', v: '\u028C', w: '\u028D', x: 'x', y: '\u028E', z: 'z',
  '0': '0', '1': '\u0196', '2': '\u1105', '3': '\u0190', '4': '\u3123',
  '5': '\u03DB', '6': '9', '7': '\u3125', '8': '8', '9': '6',
};
function styleUpsideDown(text) {
  // True "flip the page over" behavior: characters are both individually
  // flipped AND the whole string is reversed, since turning something 180°
  // also reverses reading order.
  return [...text.toLowerCase()].reverse().map(ch => UPSIDE_DOWN[ch] || ch).join('');
}
function styleMirror(text) {
  // Flipped characters, but reading order is left untouched — a distinct
  // effect from true upside-down (styleUpsideDown), closer to "each letter
  // mirrored in place."
  return [...text.toLowerCase()].map(ch => UPSIDE_DOWN[ch] || ch).join('');
}
function styleReversed(text) {
  return [...text].reverse().join('');
}

function styleLowercase(text) { return text.toLowerCase(); }
function styleIdentity(text) { return text; }

// ─── The gallery, in display order ───────────────────────────────────────────
// Index 0 is unused (styles are 1-35, matching Brandon's reference) so the
// array index always equals the style number — avoids an off-by-one
// anywhere else in this file.
const STYLES = [
  null,
  styleCircledFixed,        // 1
  styleNegativeCircled,     // 2
  styleFullwidth,           // 3
  styleBold,                // 4
  styleFraktur,             // 5
  styleBoldItalic,          // 6
  styleScript,              // 7
  styleSans,                // 8
  styleSmallCaps,           // 9
  styleMonospace,           // 10
  styleSansBold,            // 11 (same block as utils/helpers.js's boldSans)
  styleSansBoldItalic,      // 12
  styleSansItalic,          // 13
  styleParenthesized,       // 14
  styleRegionalIndicator,   // 15 — UNCERTAIN, see file header
  styleSquared,             // 16
  styleSquaredO,            // 17
  styleInvisible,           // 18 — UNCERTAIN, see file header
  styleAccented,            // 19
  styleKatakanaLookalike,   // 20 — UNCERTAIN, see file header
  styleGreekLookalike,      // 21 — UNCERTAIN, see file header
  styleCyrillicLookalike,   // 22 — UNCERTAIN, see file header
  styleIpaLookalike,        // 23 — UNCERTAIN, see file header
  styleDoubleStruck,        // 24
  styleMixedSymbols,        // 25 — UNCERTAIN, see file header
  styleBoldScript,          // 26
  styleUmlaut,              // 27
  styleBoldFraktur,         // 28
  styleFullwidthSpaced,     // 29 — UNCERTAIN, see file header
  styleLowercase,           // 30
  styleIdentity,            // 31
  styleUpsideDown,          // 32
  styleMirror,              // 33
  styleBracketed,           // 34 — UNCERTAIN, see file header
  styleReversed,            // 35
];

function applyStyle(num, text) {
  const fn = STYLES[num];
  return fn ? fn(text) : null;
}

function buildGallery() {
  const lines = [];
  for (let i = 1; i < STYLES.length; i++) {
    lines.push(`${i}. ${applyStyle(i, DEMO_TEXT)}`);
  }
  return (
    `Usage: .fancy <styleNumber> <text>\n\n` +
    `Available styles:\n${lines.join('\n')}`
  );
}

module.exports = {
  // .fancy — shows usage + a gallery of all styles applied to a demo word.
  // .fancy <styleNumber> <text> — applies that style to the given text.
  async fancy(client, msg, args) {
    if (!args.length) {
      return msg.reply(buildGallery());
    }

    const num = parseInt(args[0], 10);
    if (isNaN(num) || num < 1 || num >= STYLES.length) {
      return msg.reply(`❌ Invalid style number. Use *.fancy* with no arguments to see all ${STYLES.length - 1} styles.`);
    }

    const text = args.slice(1).join(' ');
    if (!text) {
      return msg.reply('❌ Usage: .fancy <styleNumber> <text>');
    }

    return msg.reply(applyStyle(num, text));
  },
};
