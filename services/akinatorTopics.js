/**
 * What the player's answers have already SETTLED, worked out by the application itself.
 *
 * The model is told to track this too, but it kept asking things the answers had already
 * decided: after "Does your character play sports? no" it listed volleyball, golf, tennis;
 * after "blonde hair? yes" it asked about green hair. This module turns the answers into
 * explicit rules and checks every proposed question against them, so the question is
 * rejected (and the model asked again) before the player ever sees it.
 *
 *   - a "no" / "probably not" to a BROAD question (sports, weapons, magic, music ...) rules
 *     out everything inside that topic;
 *   - a "yes" to one value of an EXCLUSIVE trait (hair colour, eye colour, gender) settles
 *     it, so no other value is asked;
 *   - a "no" to a series ruled that series out; a "yes" confirms it and rules out the others;
 *   - too many questions in a row about one dimension are held back so the game moves on.
 *
 * This is word-list knowledge, deliberately simple and easy to extend: add words to the
 * lists below. Anything it does not know about is still covered by the model's own
 * knownFacts / ruledOut lists, which are fed back into every prompt.
 */

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── knowledge ───────────────────────────────────────────────────────────────

// One canonical colour per group of words. The same colours serve hair and eyes; the
// question's context word (hair / eyes) says which trait is being asked about.
const COLOUR_WORDS = {
  black: ['black'],
  blonde: ['blonde', 'blond', 'golden', 'gold'],
  brown: ['brown', 'brunette'],
  red: ['red', 'crimson', 'scarlet'],
  pink: ['pink'],
  blue: ['blue', 'navy'],
  green: ['green'],
  white: ['white'],
  grey: ['grey', 'gray', 'silver'],
  purple: ['purple', 'violet', 'lavender'],
  orange: ['orange'],
  yellow: ['yellow'],
  teal: ['teal', 'cyan', 'turquoise', 'aqua'],
};
const COLOUR_OF = {};
for (const [canonical, words] of Object.entries(COLOUR_WORDS)) for (const word of words) COLOUR_OF[word] = canonical;

const TRAIT_CONTEXT = {
  hair: ['hair', 'haired', 'hairstyle'],
  eyes: ['eye', 'eyes', 'eyed'],
};

const GENDER_SIDES = {
  male: ['male', 'boy', 'man', 'guy', 'gentleman'],
  female: ['female', 'girl', 'woman', 'lady'],
};

// A topic is a broad area. Asking about its terms ("sports") and answering no rules out its
// members ("volleyball", "golf" ...). A member question answered no rules out only itself.
const TOPICS = [
  {
    id: 'sports', label: 'sports',
    terms: ['sport', 'sports', 'athlete', 'athletes', 'athletic', 'athletics'],
    members: ['volleyball', 'tennis', 'badminton', 'golf', 'baseball', 'softball', 'soccer', 'football', 'basketball', 'swimming', 'swimmer', 'track', 'marathon', 'running', 'runner', 'boxing', 'boxer', 'wrestling', 'judo', 'karate', 'rugby', 'hockey', 'cycling', 'rowing', 'gymnastics', 'skating', 'skiing', 'surfing', 'climbing', 'table tennis', 'ping pong', 'cricket', 'handball', 'lacrosse', 'sprinter', 'sprinting', 'athletics club'],
  },
  {
    id: 'weapons', label: 'weapons',
    terms: ['weapon', 'weapons', 'armed', 'weaponry'],
    members: ['sword', 'swords', 'katana', 'blade', 'blades', 'gun', 'guns', 'pistol', 'rifle', 'firearm', 'firearms', 'bow', 'arrows', 'spear', 'lance', 'axe', 'hammer', 'dagger', 'knife', 'knives', 'whip', 'scythe', 'shield', 'trident', 'cannon', 'bomb', 'bombs', 'swordsman', 'swordswoman'],
  },
  {
    id: 'powers', label: 'magic and special powers',
    terms: ['magic', 'magical', 'supernatural', 'superpower', 'superpowers', 'special power', 'special powers', 'special ability', 'special abilities', 'magical power', 'magical powers', 'supernatural power', 'supernatural powers', 'supernatural ability', 'supernatural abilities', 'powers'],
    members: ['fire', 'flame', 'flames', 'ice', 'frost', 'lightning', 'thunder', 'electricity', 'telepathy', 'telekinesis', 'teleport', 'teleportation', 'invisibility', 'flight', 'levitation', 'healing', 'summon', 'summoning', 'curse', 'curses', 'poison', 'gravity', 'time travel', 'shapeshifting', 'shapeshifter', 'mind control', 'illusion', 'illusions', 'necromancy', 'alchemy', 'elemental', 'elements', 'spell', 'spells', 'wizard', 'witch', 'sorcerer', 'mage', 'psychic', 'mutation', 'mutant'],
  },
  {
    id: 'music', label: 'music',
    terms: ['music', 'musical', 'musician', 'musicians', 'sing', 'sings', 'singing', 'band', 'instrument', 'instruments'],
    members: ['guitar', 'piano', 'drums', 'drummer', 'violin', 'bass', 'keyboard', 'flute', 'saxophone', 'trumpet', 'idol', 'concert', 'vocalist', 'singer', 'orchestra', 'choir'],
  },
  {
    id: 'food', label: 'food and cooking',
    terms: ['cook', 'cooks', 'cooking', 'food', 'chef', 'baking', 'baker'],
    members: ['ramen', 'sushi', 'cake', 'sweets', 'candy', 'pizza', 'curry', 'noodles', 'bread', 'dessert', 'burger', 'restaurant', 'cafe'],
  },
  {
    id: 'animals', label: 'animals and pets',
    terms: ['animal', 'animals', 'pet', 'pets', 'creature', 'creatures', 'beast'],
    members: ['dog', 'cat', 'wolf', 'fox', 'dragon', 'bird', 'rabbit', 'bear', 'horse', 'tiger', 'lion', 'snake', 'fish', 'dinosaur', 'monkey', 'owl', 'cow', 'pig', 'slime'],
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function analyze(question) {
  const text = normalizeText(question);
  const tokens = new Set(text.split(' ').filter(Boolean));
  const padded = ` ${text} `;
  const has = phrase => padded.includes(` ${phrase} `);
  const hasAny = phrases => phrases.some(has);
  return { text, tokens, padded, has, hasAny };
}

function contextOf(info) {
  const hair = TRAIT_CONTEXT.hair.some(word => info.tokens.has(word));
  const eyes = TRAIT_CONTEXT.eyes.some(word => info.tokens.has(word));
  if (hair && !eyes) return 'hair';
  if (eyes && !hair) return 'eyes';
  return '';
}

function coloursIn(info) {
  return [...new Set([...info.tokens].map(token => COLOUR_OF[token]).filter(Boolean))];
}

function gendersIn(info) {
  return Object.entries(GENDER_SIDES).filter(([, words]) => words.some(word => info.tokens.has(word))).map(([side]) => side);
}

function topicHits(info, topic) {
  return { term: info.hasAny(topic.terms), member: info.hasAny(topic.members) };
}

function isNegative(answer) {
  return answer === 'no' || answer === 'probnot';
}

// The part of a title before ":" / " - " is how people usually say it ("Mashle").
function seriesMainTitle(title) {
  return normalizeText(String(title || '').split(/[:\-–—(]/)[0]);
}

// "Is your character from <Title>?" -> "<Title>". Only a capitalised name counts as a title:
// "from a romance anime", "from the 2000s", "from a long-running series" are genre / era
// questions, not guesses at a specific series.
const NOT_A_TITLE = new Set(['japan', 'earth', 'america', 'korea', 'china', 'europe', 'asia']);

function titleFromQuestion(question) {
  const text = String(question || '').trim();
  const match = text.match(/\bfrom\s+(?:the\s+)?(?:(?:an?|the)\s+)?(?:(?:anime|series|show|manga)\s+)*(.+?)\s*[?!.]*$/i);
  if (!match) return '';
  const title = match[1].replace(/[?!.]+$/g, '').trim();
  if (!/^[A-Z0-9]/.test(title)) return '';
  if (/^(?:\d{4}s?|\d{2}s)\b/i.test(title)) return '';
  if (NOT_A_TITLE.has(title.toLowerCase())) return '';
  return title;
}

function isSeriesTitleQuestion(question) {
  return Boolean(titleFromQuestion(question));
}

function sameSeries(a, b) {
  const x = seriesMainTitle(a);
  const y = seriesMainTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 4 && y.length >= 4 && (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `));
}

function seriesTitles(history) {
  const seen = new Map();
  for (const item of Array.isArray(history) ? history : []) {
    const main = seriesMainTitle(item?.anime);
    if (main.length >= 4 && !seen.has(main)) seen.set(main, String(item.anime).trim());
  }
  return seen;
}

// ─── what the answers have settled ───────────────────────────────────────────

/**
 * answers: [{ question, answer }]   history: candidateHistory ([{ anime }]) used to
 * recognise questions about a series.
 * Returns { facts: [...], rules: [...] }. `facts` are plain sentences for the prompt;
 * `rules` are what findViolation() checks proposed questions against.
 */
function deriveEstablished(answers, history = []) {
  const facts = [];
  const rules = [];
  const titles = seriesTitles(history);
  const confirmedSeries = [];
  const deniedSeries = [];

  for (const entry of Array.isArray(answers) ? answers : []) {
    const answer = entry?.answer;
    const info = analyze(entry?.question);
    if (!info.text) continue;

    // ── topics ──
    for (const topic of TOPICS) {
      const hit = topicHits(info, topic);
      if (hit.term && !hit.member) {
        if (isNegative(answer)) {
          facts.push(`Not connected to ${topic.label} at all (player answered ${answer === 'no' ? 'no' : 'probably not'}).`);
          rules.push({ kind: 'topic', topic, reason: `${topic.label} were ruled out` });
        } else if (answer === 'yes') {
          facts.push(`Connected to ${topic.label}.`);
        }
      }
    }

    // ── exclusive traits: hair / eye colour ──
    const context = contextOf(info);
    const colours = context ? coloursIn(info) : [];
    if (context && colours.length === 1) {
      const colour = colours[0];
      if (answer === 'yes') {
        facts.push(`${context === 'hair' ? 'Hair' : 'Eye'} colour is ${colour}.`);
        rules.push({ kind: 'trait', context, keep: colour, reason: `${context === 'hair' ? 'hair' : 'eye'} colour is already known (${colour})` });
      } else if (isNegative(answer)) {
        facts.push(`${context === 'hair' ? 'Hair' : 'Eye'} colour is not ${colour}${answer === 'probnot' ? ' (probably)' : ''}.`);
      }
    }

    // ── gender ──
    const sides = gendersIn(info);
    if (sides.length === 1) {
      const side = sides[0];
      if (answer === 'yes') {
        facts.push(`Gender: ${side}.`);
        rules.push({ kind: 'gender', sides: ['male', 'female'], reason: `gender is already known (${side})` });
      } else if (isNegative(answer)) {
        facts.push(`Not ${side}${answer === 'probnot' ? ' (probably)' : ''}.`);
        rules.push({ kind: 'gender', sides: [side], reason: `the answer for ${side} is already known` });
      }
    }

    // ── series the bot has been testing ──
    const asked = new Map(titles);
    const written = titleFromQuestion(entry?.question);
    if (written) {
      const main = seriesMainTitle(written);
      if (main.length >= 3 && !asked.has(main)) asked.set(main, written);
    }
    for (const [main, full] of asked) {
      if (!info.has(main)) continue;
      if (answer === 'yes') confirmedSeries.push({ main, full });
      else if (isNegative(answer)) deniedSeries.push({ main, full });
    }
  }

  for (const series of confirmedSeries) {
    facts.push(`The character IS from ${series.full}. Do not ask about any other series.`);
  }
  if (confirmedSeries.length) {
    const keep = new Set(confirmedSeries.map(series => series.main));
    const everyTitle = new Map(titles);
    for (const entry of Array.isArray(answers) ? answers : []) {
      const written = titleFromQuestion(entry?.question);
      const main = written ? seriesMainTitle(written) : '';
      if (main.length >= 3 && !everyTitle.has(main)) everyTitle.set(main, written);
    }
    for (const [main, full] of everyTitle) {
      if (!keep.has(main)) rules.push({ kind: 'series', main, full, reason: `the series is already confirmed` });
    }
  }
  for (const series of deniedSeries) {
    facts.push(`The character is NOT from ${series.full}; nothing from that series should be asked about.`);
    rules.push({ kind: 'series', main: series.main, full: series.full, reason: `${series.full} was ruled out` });
  }

  return { facts: [...new Set(facts)], rules };
}

// ─── checking a proposed question ────────────────────────────────────────────

/**
 * Returns a short reason (string) when `question` asks about something already settled by
 * the answers, otherwise ''. `modelRuledOut` is the model's own list of ruled-out topics:
 * a question that mentions one of those exact phrases is rejected too.
 */
function findViolation(question, established, modelRuledOut = []) {
  const info = analyze(question);
  if (!info.text) return '';

  for (const rule of established?.rules || []) {
    if (rule.kind === 'topic') {
      const hit = topicHits(info, rule.topic);
      if (hit.term || hit.member) return rule.reason;
    } else if (rule.kind === 'trait') {
      if (contextOf(info) === rule.context && coloursIn(info).length) return rule.reason;
    } else if (rule.kind === 'gender') {
      if (gendersIn(info).some(side => rule.sides.includes(side))) return rule.reason;
    } else if (rule.kind === 'series') {
      if (info.has(rule.main)) return rule.reason;
    }
  }

  for (const phrase of Array.isArray(modelRuledOut) ? modelRuledOut : []) {
    const normalized = normalizeText(phrase);
    if (normalized.length >= 4 && info.has(normalized)) return `"${String(phrase).trim()}" was ruled out`;
  }
  return '';
}

// The series (as written in the rule) that a guessed anime title contradicts, or ''.
// A guess from a series the player said "no" to - or from another series once one was
// confirmed - is wrong whatever the model's confidence says.
function seriesConflict(animeTitle, established) {
  for (const rule of established?.rules || []) {
    if (rule.kind === 'series' && sameSeries(animeTitle, rule.full || rule.main)) return rule.full || rule.main;
  }
  return '';
}

// ── series-title questions are rationed ────────────────────────────────────────
// Asking about one series after another ("Is it Toradora? Horimiya? Nisekoi?") is not
// guessing, it is reading a list. Title questions are allowed only after some questions
// about the character itself, with gaps between them and within a budget; when the model
// is already confident it may confirm a series sooner.
function seriesQuestionProblem(question, answers, settings, confidence = 0) {
  if (!isSeriesTitleQuestion(question)) return '';
  const list = Array.isArray(answers) ? answers : [];
  let total = 0;
  let sinceLast = list.length;
  list.forEach((entry, index) => {
    if (isSeriesTitleQuestion(entry.question)) { total += 1; sinceLast = list.length - 1 - index; }
  });
  const confident = Number(confidence) >= settings.AKINATOR_SERIES_CONFIRM_CONFIDENCE;
  if (total >= settings.AKINATOR_MAX_SERIES_QUESTIONS) return 'budget';
  if (!confident && list.length < settings.AKINATOR_SERIES_QUESTION_MIN_ANSWERS) return 'too_early';
  if (total > 0 && sinceLast < (confident ? 2 : settings.AKINATOR_SERIES_QUESTION_GAP)) return 'gap';
  return '';
}

function seriesQuestionCount(answers) {
  return (Array.isArray(answers) ? answers : []).filter(entry => isSeriesTitleQuestion(entry.question)).length;
}

// ── which parts of the CHARACTER have been asked about ──────────────────────────
const CHARACTER_DIMENSIONS = [
  { id: 'personality', label: 'personality (shy, cheerful, tsundere, serious, kind ...)', words: ['personality', 'tsundere', 'kuudere', 'yandere', 'dandere', 'shy', 'cheerful', 'serious', 'cold', 'kind', 'gentle', 'energetic', 'lazy', 'arrogant', 'cunning', 'mysterious', 'calm', 'clumsy', 'smart', 'intelligent', 'genius', 'confident', 'quiet', 'outgoing', 'stoic', 'bubbly', 'sarcastic', 'loyal', 'temper', 'tomboy', 'proud', 'stubborn', 'selfless', 'playful', 'mean', 'rude', 'sweet', 'honest', 'jealous', 'caring', 'ambitious'] },
  { id: 'role', label: 'role in the story (main heroine, rival, love interest, side character ...)', words: ['protagonist', 'main character', 'heroine', 'hero', 'villain', 'antagonist', 'rival', 'mentor', 'sidekick', 'love interest', 'side character', 'supporting', 'deuteragonist', 'harem', 'lead', 'minor character'] },
  { id: 'relationships', label: 'relationships and love life (family, childhood friend, crush ...)', words: ['sister', 'brother', 'sibling', 'family', 'mother', 'father', 'parent', 'friend', 'childhood', 'lover', 'boyfriend', 'girlfriend', 'crush', 'married', 'fiance', 'fiancee', 'engaged', 'love', 'dating', 'relationship', 'romantic', 'confess', 'confessed', 'kiss'] },
  { id: 'age', label: 'age or school year', words: ['age', 'old', 'older', 'young', 'younger', 'teen', 'teenager', 'adult', 'child', 'kid', 'elderly', 'grade', 'first year', 'second year', 'third year', 'year old', 'middle school', 'elementary', 'university', 'college', 'senior', 'junior'] },
  { id: 'affiliation', label: 'occupation, club or organisation', words: ['club', 'team', 'student council', 'organization', 'organisation', 'guild', 'military', 'teacher', 'idol', 'maid', 'nurse', 'doctor', 'detective', 'pilot', 'noble', 'royal', 'king', 'queen', 'princess', 'prince', 'president', 'job', 'occupation', 'works', 'work', 'part time', 'class', 'committee', 'academy'] },
  { id: 'abilities', label: 'abilities or fighting style', words: ['fight', 'fights', 'fighter', 'combat', 'skill', 'skills', 'ability', 'abilities', 'strong', 'strength', 'fast', 'speed', 'magic', 'powers', 'weapon', 'weapons', 'talent', 'talented', 'skilled', 'athletic'] },
  { id: 'appearance', label: 'appearance details (hairstyle, accessories, clothes)', words: ['glasses', 'ribbon', 'ribbons', 'uniform', 'dress', 'kimono', 'hat', 'cape', 'coat', 'scar', 'tattoo', 'horns', 'tail', 'ears', 'wings', 'mask', 'armor', 'jacket', 'hoodie', 'costume', 'skirt', 'accessory', 'accessories', 'bow', 'headband', 'clothes', 'wear', 'wears', 'ponytail', 'twin tails', 'twintails', 'pigtails', 'bangs', 'braid', 'braids', 'bun', 'tall', 'short', 'height', 'curvy', 'slim', 'long hair', 'short hair', 'curly', 'straight'] },
  { id: 'species', label: 'species (human, demon, robot ...)', words: ['human', 'robot', 'android', 'demon', 'angel', 'vampire', 'ghost', 'alien', 'monster', 'elf', 'spirit', 'god', 'goddess', 'cyborg', 'beastman', 'fairy'] },
  { id: 'signature', label: 'signature habit, catchphrase or famous moment', words: ['catchphrase', 'signature', 'famous for', 'known for', 'nickname', 'habit', 'always', 'never', 'favorite', 'favourite', 'hobby', 'hobbies', 'loves', 'afraid', 'fear', 'secret'] },
];

function dimensionsOf(question) {
  const found = new Set();
  // "Is your character from Kaguya-sama: Love is War?" says nothing about the character.
  if (isSeriesTitleQuestion(question)) return found;
  const info = analyze(question);
  if (contextOf(info)) found.add('appearance');
  if (gendersIn(info).length) found.add('gender');
  for (const dimension of CHARACTER_DIMENSIONS) {
    if (info.hasAny(dimension.words)) found.add(dimension.id);
  }
  return found;
}

// Labels of the character dimensions nobody has asked about yet, so the model can be
// pointed at them. `answers` are the questions asked so far.
function untouchedDimensions(answers) {
  const touched = new Set();
  for (const entry of Array.isArray(answers) ? answers : []) {
    for (const id of dimensionsOf(entry.question)) touched.add(id);
  }
  return CHARACTER_DIMENSIONS.filter(dimension => !touched.has(dimension.id)).map(dimension => dimension.label);
}

// Dimensions a question touches, used to stop the game circling one subject.
function topicsOf(question) {
  const info = analyze(question);
  const found = new Set();
  for (const topic of TOPICS) {
    const hit = topicHits(info, topic);
    if (hit.term || hit.member) found.add(topic.id);
  }
  const context = contextOf(info);
  if (context) found.add(context);
  if (gendersIn(info).length) found.add('gender');
  return found;
}

/**
 * How many of the most recent questions, in a row, were about the same dimension as
 * `question` and did not get a yes (a yes means drilling down is worthwhile).
 */
function topicStreak(question, recentAnswers) {
  const wanted = topicsOf(question);
  if (!wanted.size) return { count: 0, topic: '' };
  let count = 0;
  let shared = '';
  for (let i = (recentAnswers || []).length - 1; i >= 0; i--) {
    const previous = recentAnswers[i];
    if (previous.answer === 'yes') break;
    const overlap = [...topicsOf(previous.question)].find(id => wanted.has(id));
    if (!overlap) break;
    shared = shared || overlap;
    count += 1;
  }
  return { count, topic: shared };
}

module.exports = {
  deriveEstablished,
  findViolation,
  seriesConflict,
  seriesQuestionProblem,
  seriesQuestionCount,
  untouchedDimensions,
  dimensionsOf,
  titleFromQuestion,
  isSeriesTitleQuestion,
  topicsOf,
  topicStreak,
  normalizeText,
  TOPICS,
};
