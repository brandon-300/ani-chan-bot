'use strict';

// ─── Speech text preparation ────────────────────────────────────────────────
// Everything that goes to Fish Audio (.tts and .voice) passes through
// toSpeechText(). Its job is the opposite of decoration: make sure NOTHING that
// is not meant to be spoken can be spoken, and turn chat-style writing into
// something that sounds like a person talking.
//
// What gets removed (because the speech engine would read it aloud):
//   • emojis and text emoticons
//   • [[control tokens]] and ANY [bracket cue] or {brace} text
//   • S1-style "(happy)" / "(laughing)" parenthesis cues — on the S2.1 model
//     these are ordinary text and are spoken
//   • stage directions such as *giggles*, (sighs) and "~smiles~"
//   • markdown, URLs, tildes, bullets and headings
//
// What gets converted: chat shorthand ("lol", "omg", "idk") into the words a
// person would actually say, and line breaks into sentence breaks so the voice
// phrases naturally instead of reading one long run-on.
//
// Optional expression cues (config FISH_EXPRESSION_TAGS, OFF by default) are
// added by applyExpressionCue() AFTER sanitizing, from a fixed short list of
// documented S2 cues, never from model output.

// Pictographs, flags, keycaps, skin-tone modifiers, variation selectors, joiners.
const EMOJI_SEQUENCE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;

// Words that describe an action or a sound. When one of them starts a short
// *...*, ~...~ or (...) it is a stage direction, not something to say.
const ACTION_WORDS = [
  'giggl', 'laugh', 'chuckl', 'snicker', 'snort', 'cackl', 'sigh', 'gasp', 'sob', 'weep', 'sniff',
  'smil', 'grin', 'smirk', 'blush', 'wink', 'pout', 'frown', 'glare', 'blink', 'nod', 'shrug',
  'wav', 'hug', 'cuddl', 'facepalm', 'whisper', 'mutter', 'murmur', 'yawn', 'cough', 'fidget',
  'squirm', 'flail', 'bounc', 'tremble', 'shiver', 'sweatdrop', 'flush', 'tilt', 'glanc',
];
// S1-style delivery labels. Only treated as cues inside (parentheses), where
// that syntax lives; inside *asterisks* they are ordinary emphasised words
// ("I am *angry*" must stay as spoken).
const LABEL_WORDS = [
  'happy', 'sad', 'angry', 'excited', 'surprised', 'satisfied', 'delighted', 'scared', 'worried', 'upset',
  'nervous', 'frustrated', 'depressed', 'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed',
  'grateful', 'confident', 'interested', 'curious', 'confused', 'joyful', 'sobbing', 'panting', 'groaning',
  'sighing', 'laughing', 'chuckling', 'whispering', 'shouting', 'screaming', 'crying',
  'break', 'long-break', 'emphasis', 'inhale', 'exhale', 'tsk', 'pause',
];
const ACTION_PATTERN = `(?:${ACTION_WORDS.join('|')})[\\w-]*`;
const LABEL_PATTERN = `(?:${LABEL_WORDS.join('|')})[\\w-]*`;
// 1 to 4 words, the first being a direction word: "giggles", "laughs softly", "sighs, looking away".
const ACTION_BODY = `${ACTION_PATTERN}(?:[ ,]+[a-z'-]+){0,3}`;
const STARRED_DIRECTION = new RegExp(`\\*{1,2}\\s*${ACTION_BODY}\\s*\\*{1,2}`, 'gi');
const PAREN_DIRECTION = new RegExp(`\\(\\s*(?:${ACTION_BODY}|${LABEL_PATTERN})\\s*\\)`, 'gi');
const TILDE_DIRECTION = new RegExp(`~\\s*${ACTION_BODY}\\s*~`, 'gi');

// Text emoticons that would otherwise be read letter by letter.
const EMOTICONS = /(?:(?<=^|\s)(?:[:;=8][-^']?[)(DPpOo3/\\|*$]+|[xX][Dd]+|[>^<][_.-]?[<^>]|[Tt][_.-][Tt]|-_-|o_o|O_O|;_;|\(\^[^)]*\^\)|\([´`'][^)]{0,6}[´`']\))(?=$|\s|[.,!?]))/g;

// Chat shorthand → what a person would say out loud. Whole words only.
const SPOKEN_FORMS = [
  [/\b(?:lmfao|lmao|rofl|lol+)\b/gi, 'haha'],
  [/\bomg\b/gi, 'oh my god'],
  [/\bwtf\b/gi, 'what the heck'],
  [/\bbtw\b/gi, 'by the way'],
  [/\bidk\b/gi, "I don't know"],
  [/\bimo\b/gi, 'in my opinion'],
  [/\btbh\b/gi, 'to be honest'],
  [/\bngl\b/gi, 'not gonna lie'],
  [/\bbrb\b/gi, 'be right back'],
  [/\bikr\b/gi, 'I know, right'],
  [/\birl\b/gi, 'in real life'],
  [/\brn\b/gi, 'right now'],
  [/\bjk\b/gi, 'just kidding'],
  [/\bpl(?:s|z)\b/gi, 'please'],
  [/\bthx\b/gi, 'thanks'],
  [/\bu\b/g, 'you'],
  [/\bur\b/g, 'your'],
  [/&/g, ' and '],
];

// The short, documented S2 cues the optional injector may use. Nothing else is
// ever generated. Keep this list to the "core" tags Fish documents as reliable.
const SAFE_CUES = Object.freeze(['excited', 'sad', 'angry', 'surprised', 'laugh', 'sigh', 'gasp', 'whisper']);

function stripEmojis(text) {
  return String(text || '')
    .replace(EMOJI_SEQUENCE, '')
    .replace(/[ \t]+([,.;!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

function toSpeechText(input) {
  let text = String(input ?? '');

  // Control tokens first: [[reaction:x]], [[bot_action:x]], bare [[x]], and an
  // unterminated [[token cut off at the end of a truncated reply.
  text = text
    .replace(/\[\[[^\]\r\n]*\]\]/g, ' ')
    .replace(/\[\[[^\r\n]*$/gm, ' ');

  // Stage directions and cue syntax the engine would pronounce.
  text = text
    .replace(STARRED_DIRECTION, ' ')
    .replace(PAREN_DIRECTION, ' ')
    .replace(TILDE_DIRECTION, ' ')
    .replace(/\[[^\]\r\n]{0,60}\]/g, ' ')     // [laughs] [whispers sweetly] [excited]
    .replace(/\{[^}\r\n]{0,60}\}/g, ' ')      // {sound effect}
    .replace(/<\|[^|>\r\n]{0,40}\|>/g, ' ')   // <|speaker:0|> style control markers
    .replace(/<[^>\r\n]{1,40}>/g, ' ');       // <tags>

  // Links are never worth reading out.
  text = text
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ');

  // Markdown that is left after the directions are gone.
  text = text
    .replace(/\*\*?([^*\r\n]+?)\*\*?/g, '$1')
    .replace(/(^|[\s(])_([^_\r\n]+?)_(?=[\s).,!?]|$)/g, '$1$2')
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_`#]/g, '')
    .replace(/(?<=\w)~+(?=\w)/g, '')   // sil~ly -> silly (no split)
    .replace(/~+/g, ' ');

  // Emojis and emoticons.
  text = text.replace(EMOJI_SEQUENCE, ' ').replace(EMOTICONS, ' ');

  // Remaining parentheses only wrap ordinary words: keep the words, drop the marks.
  // Any bracket, brace, angle or pipe left over is unpaired junk (e.g. a lone "]")
  // that the engine could read literally, so it goes too.
  text = text.replace(/[()\[\]{}<>|\\^]/g, ' ');

  // Chat shorthand → spoken words.
  for (const [pattern, replacement] of SPOKEN_FORMS) text = text.replace(pattern, replacement);

  // Line breaks become sentence breaks so the voice phrases naturally.
  text = text
    .split(/\r?\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index, lines) => (index < lines.length - 1 && !/[.!?…:;]$/.test(line) ? `${line}.` : line))
    .join(' ');

  // Punctuation clean-up. Keep expressive marks (?! ... —) but stop runaway ones.
  text = text
    .replace(/…/g, '...')
    .replace(/\.{4,}/g, '...')
    .replace(/([!?])\1{2,}/g, '$1$1')
    .replace(/([!?]){3,}/g, '$1$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/(^|[.!?])\s*,+/g, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return text;
}

// ─── Optional expression cues (opt-in) ──────────────────────────────────────
// Picks AT MOST one cue from SAFE_CUES for the start of an utterance using
// simple wording heuristics. Returns null when nothing fits. Laughter words are
// deliberately not tagged: "ahaha" in the text already makes the laugh sound.
function inferExpressionCue(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/\b(?:a?ha(?:ha)+|hehe+|haha+)\b/i.test(t)) return null;
  if (/^(?:eh+|huh|what|wait|whoa|woah|no way|really)\b/i.test(t) || /[?!]{2}/.test(t.slice(0, 40))) return 'surprised';
  if (/^(?:ugh|hmm+|haa+|sigh)\b/i.test(t)) return 'sigh';
  if (/\b(?:sorry|i miss|lonely|it hurts|so sad|crying)\b/i.test(t)) return 'sad';
  if (/\b(?:shut up|so annoying|i hate|stop it|baka|idiot)\b/i.test(t)) return 'angry';
  if ((t.match(/!/g) || []).length >= 2 || /\b(?:yay|let's go|awesome|so cool|amazing)\b/i.test(t)) return 'excited';
  return null;
}

function applyExpressionCue(text, cue = inferExpressionCue(text)) {
  const clean = String(text || '').trim();
  if (!clean || !cue || !SAFE_CUES.includes(cue)) return clean;
  return `[${cue}] ${clean}`;
}

module.exports = {
  EMOJI_SEQUENCE,
  SAFE_CUES,
  stripEmojis,
  toSpeechText,
  inferExpressionCue,
  applyExpressionCue,
};
