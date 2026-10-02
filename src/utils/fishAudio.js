// ─── Fish Audio TTS wrapper ─────────────────────────────────────────────────
// Calls Fish Audio's REST API directly over axios. The API key/model are
// process-wide; voice.referenceId belongs to each persona. FISH_VOICE_ID is
// only a final emergency override for operators who intentionally force one
// voice across the whole process.
//
// Delivery tuning (all documented request fields):
//   temperature / top_p  – higher = more varied, more expressive delivery
//   prosody.speed/volume – pacing and level
//   latency / chunk_length – sent only when explicitly configured
// Defaults come from utils/config.js; a persona's meta.json `voice` block
// (speed, volume, temperature, topP) overrides them for that persona only.
import axios from 'axios';
import { getActivePersonaSafe } from './persona.js';
const {
  FISH_VOICE_ID,
  FISH_MODEL,
  FISH_REQUEST_TIMEOUT_MS,
  FISH_TEMPERATURE,
  FISH_TOP_P,
  FISH_SPEED,
  FISH_VOLUME_DB,
  FISH_LATENCY,
  FISH_CHUNK_LENGTH,
} = require('./config');

const FISH_API_KEY = process.env.FISH_API_KEY;

function resolveVoiceId(voiceId, persona = null) {
  const activePersona = persona || getActivePersonaSafe();
  const selected = voiceId || activePersona?.voice?.referenceId || FISH_VOICE_ID;
  if (!selected) {
    const label = activePersona?.displayName || 'the active persona';
    const err = new Error(`No Fish Audio voice is configured for ${label}. Set voice.referenceId in that persona's meta.json, or set FISH_VOICE_ID only as a process-wide emergency override.`);
    err.code = 'NO_FISH_VOICE';
    throw err;
  }
  return selected;
}

function assertConfig() {
  if (!FISH_API_KEY) {
    const err = new Error('FISH_API_KEY is not set in .env');
    err.code = 'NO_FISH_KEY';
    throw err;
  }
}

function extractApiErrorMessage(err) {
  // Fish Audio returns binary audio on success, so on failure the body may
  // come back as a Buffer even though it is actually JSON text.
  const data = err.response?.data;
  if (Buffer.isBuffer(data)) {
    try {
      const parsed = JSON.parse(data.toString('utf8'));
      return parsed.message || parsed.error || data.toString('utf8').slice(0, 200);
    } catch {
      return data.toString('utf8').slice(0, 200);
    }
  }
  return data?.message || data?.error || err.message || 'Unknown Fish Audio API error';
}

function pickNumber(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

// Builds the JSON body for POST /v1/tts. Pure function (no I/O) so the exact
// request can be tested. `overrides` beat the persona, which beats config.
function buildTtsPayload(text, referenceId, persona = null, overrides = {}) {
  const tuning = persona?.voice || {};
  const temperature = pickNumber(overrides.temperature, tuning.temperature, FISH_TEMPERATURE);
  const topP = pickNumber(overrides.topP, tuning.topP, FISH_TOP_P);
  const speed = pickNumber(overrides.speed, tuning.speed, FISH_SPEED);
  const volume = pickNumber(overrides.volume, tuning.volume, FISH_VOLUME_DB);

  const prosody = { normalize_loudness: false };
  if (speed !== undefined && speed !== 1) prosody.speed = speed;
  if (volume !== undefined && volume !== 0) prosody.volume = volume;

  const body = {
    text,
    reference_id: referenceId,
    format: 'mp3',
    normalize: true, // Text normalization for numbers/pronunciation, not an audio effect.
    prosody,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (topP !== undefined) body.top_p = topP;
  if (FISH_LATENCY) body.latency = FISH_LATENCY;
  if (FISH_CHUNK_LENGTH) body.chunk_length = FISH_CHUNK_LENGTH;
  return body;
}

// Returns Fish Audio's MP3 bytes directly. `voiceId` is an optional per-call
// override; otherwise use the persona's own reference before the global
// fallback. No pitch/effect processing is added; loudness normalization is
// disabled so the generated reference voice is not post-leveled.
async function synthesizeSpeech(text, { voiceId, persona, overrides } = {}) {
  const activePersona = persona || getActivePersonaSafe();
  const referenceId = resolveVoiceId(voiceId, activePersona);
  assertConfig();

  try {
    const res = await axios.post(
      'https://api.fish.audio/v1/tts',
      buildTtsPayload(text, referenceId, activePersona, overrides),
      {
        headers: {
          Authorization: `Bearer ${FISH_API_KEY}`,
          'Content-Type': 'application/json',
          model: FISH_MODEL,
        },
        responseType: 'arraybuffer',
        timeout: FISH_REQUEST_TIMEOUT_MS,
      }
    );

    return Buffer.from(res.data);
  } catch (err) {
    const msg = extractApiErrorMessage(err);
    const wrapped = new Error(`Fish Audio TTS failed: ${msg}`);
    wrapped.code = 'FISH_TTS_ERROR';
    wrapped.status = err.response?.status;
    throw wrapped;
  }
}

module.exports = { synthesizeSpeech, _resolveVoiceId: resolveVoiceId, _buildTtsPayload: buildTtsPayload };
