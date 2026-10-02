const fs = require('fs');
const path = require('path');
const { AI_PERSONA, AI_CALL_NAMES_OVERRIDE, PERSONAS_DIR } = require('./config');

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const failedPersonaLogs = new Set();
let activePersona;

function listPersonaIds() {
  try {
    return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && ID_RE.test(entry.name))
      .map(entry => entry.name)
      .sort();
  } catch (err) {
    console.error(`Could not enumerate persona directories: ${err.message}`);
    return [];
  }
}

function readPrompt(filePath, label) {
  let value;
  try {
    value = fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    throw new Error(`Persona configuration is missing ${label}: ${filePath} (${err.message})`);
  }
  if (!value) throw new Error(`Persona configuration file is empty: ${filePath}`);
  return value;
}

function loadPersona(personaId = AI_PERSONA) {
  const id = String(personaId || '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw new Error(`Invalid AI_PERSONA value: ${JSON.stringify(personaId)}`);

  const personaDir = path.join(PERSONAS_DIR, id);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(personaDir, 'meta.json'), 'utf8'));
  } catch (err) {
    throw new Error(`Could not load persona "${id}" metadata: ${err.message}`);
  }

  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(`Persona "${id}" metadata must be a JSON object.`);
  }
  if (meta.id !== id) throw new Error(`Persona id in ${id}/meta.json must match its directory name.`);
  if (typeof meta.displayName !== 'string' || !meta.displayName.trim()) {
    throw new Error(`Persona "${id}" requires a non-empty displayName.`);
  }
  if (!Array.isArray(meta.callNames) || !meta.callNames.every(name => typeof name === 'string' && name.trim())) {
    throw new Error(`Persona "${id}" callNames must be an array of non-empty strings.`);
  }
  if (typeof meta.stickerAuthor !== 'string' || !meta.stickerAuthor.trim()) {
    throw new Error(`Persona "${id}" requires a non-empty stickerAuthor.`);
  }
  if (meta.voice != null && (typeof meta.voice !== 'object' || Array.isArray(meta.voice))) {
    throw new Error(`Persona "${id}" voice metadata must be an object when provided.`);
  }
  if (meta.voice?.referenceId != null && typeof meta.voice.referenceId !== 'string') {
    throw new Error(`Persona "${id}" voice.referenceId must be a string or null.`);
  }
  // Optional delivery tuning. Each field is validated here so a typo in
  // meta.json fails loudly at load time instead of silently sending a bad
  // value to Fish Audio on every voice note.
  const VOICE_TUNING_RANGES = { speed: [0.5, 2], volume: [-20, 20], temperature: [0, 1], topP: [0, 1] };
  const voiceTuning = {};
  for (const [field, [min, max]] of Object.entries(VOICE_TUNING_RANGES)) {
    const value = meta.voice?.[field];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Persona "${id}" voice.${field} must be a number between ${min} and ${max}.`);
    }
    voiceTuning[field] = value;
  }

  // AI_CALL_NAMES deliberately replaces names only for this active persona;
  // it is never a shared pool or a default for other persona directories.
  const callNames = AI_CALL_NAMES_OVERRIDE === null
    ? meta.callNames.map(name => name.trim())
    : AI_CALL_NAMES_OVERRIDE;

  return Object.freeze({
    id,
    displayName: meta.displayName.trim(),
    series: typeof meta.series === 'string' ? meta.series.trim() : '',
    callNames: Object.freeze([...callNames]),
    stickerAuthor: meta.stickerAuthor.trim(),
    voice: Object.freeze({ referenceId: meta.voice?.referenceId || null, ...voiceTuning }),
    personality: readPrompt(path.join(personaDir, 'personality.txt'), 'personality.txt'),
    text: readPrompt(path.join(personaDir, 'text.txt'), 'text.txt'),
    voicePrompt: readPrompt(path.join(personaDir, 'voice.txt'), 'voice.txt'),
  });
}

// Strict resolution is lazy: requiring this module never reads persona files.
// AI handlers may use this and catch validation errors at their command boundary.
function getActivePersona() {
  if (!activePersona) activePersona = loadPersona();
  return activePersona;
}

// Startup/routing helpers use the safe getter so incomplete configuration
// cannot take down WhatsApp, MongoDB, or unrelated commands. A failed load is
// retried on later calls (allowing operators to repair files without restart),
// but the same clear log message is emitted only once per configured ID.
function getActivePersonaSafe() {
  try {
    return getActivePersona();
  } catch (err) {
    const id = String(AI_PERSONA || '<unset>');
    if (!failedPersonaLogs.has(id)) {
      failedPersonaLogs.add(id);
      console.error(`❌ AI persona "${id}" is unavailable; persona-dependent AI/sticker features are disabled: ${err.message}`);
    }
    return null;
  }
}

module.exports = { loadPersona, listPersonaIds, getActivePersona, getActivePersonaSafe };
