// ─── Fish Audio TTS wrapper ─────────────────────────────────────────────────
// Calls Fish Audio's REST API directly over axios. The API key/model are
// process-wide; voice.referenceId belongs to each persona. FISH_VOICE_ID is
// only a final emergency override for operators who intentionally force one
// voice across the whole process.
const axios = require('axios');
const { FISH_VOICE_ID, FISH_MODEL, FISH_REQUEST_TIMEOUT_MS } = require('./config');
const { getActivePersonaSafe } = require('./persona');

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

// Returns Fish Audio's MP3 bytes directly. `voiceId` is an optional per-call
// override; otherwise use the persona's own reference before the global
// fallback. No pitch/effect processing is added; loudness normalization is
// disabled so the generated reference voice is not post-leveled.
async function synthesizeSpeech(text, { voiceId } = {}) {
  const referenceId = resolveVoiceId(voiceId);
  assertConfig();

  try {
    const res = await axios.post(
      'https://api.fish.audio/v1/tts',
      {
        text,
        reference_id: referenceId,
        format: 'mp3',
        normalize: true, // Text normalization for numbers/pronunciation, not an audio effect.
        prosody: { normalize_loudness: false },
      },
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

module.exports = { synthesizeSpeech, _resolveVoiceId: resolveVoiceId };
