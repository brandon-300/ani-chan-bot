// ─── Fish Audio TTS wrapper ─────────────────────────────────────────────────
// Calls Fish Audio's official REST API (api.fish.audio) directly over axios
// — no new npm dependency needed. Returns an mp3 Buffer; converting that to
// an ogg/opus voice note (what WhatsApp needs for a playable .ptt message)
// is handled in commands/ai.js using the same ffmpeg pattern already used
// by .tovn in commands/converter.js.
const axios = require('axios');

const FISH_API_KEY = process.env.FISH_API_KEY;
const FISH_VOICE_ID = process.env.FISH_VOICE_ID; // Fish Audio calls this "reference_id"

// s2.1-pro-free is Fish Audio's free-tier model slug as of when this was
// written. If Fish Audio renames/retires it, override FISH_MODEL in .env —
// no code change needed. Check your usable models at https://fish.audio
const FISH_MODEL = process.env.FISH_MODEL || 's2.1-pro-free';

const REQUEST_TIMEOUT_MS = 45000;

function assertConfig() {
  if (!FISH_API_KEY) {
    const err = new Error('FISH_API_KEY is not set in .env');
    err.code = 'NO_FISH_KEY';
    throw err;
  }
  if (!FISH_VOICE_ID) {
    const err = new Error(
      'FISH_VOICE_ID is not set in .env — pick a voice at https://fish.audio (or your own cloned voice) and copy its reference_id into FISH_VOICE_ID'
    );
    err.code = 'NO_FISH_VOICE';
    throw err;
  }
}

function extractApiErrorMessage(err) {
  // Fish Audio returns binary audio on success, so on failure the body may
  // come back as a Buffer even though it's actually JSON text — decode it
  // before trying to read a message out of it.
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

// Returns a Buffer containing mp3 audio.
async function synthesizeSpeech(text) {
  assertConfig();

  try {
    const res = await axios.post(
      'https://api.fish.audio/v1/tts',
      {
        text,
        reference_id: FISH_VOICE_ID,
        format: 'mp3',
        normalize: true,
      },
      {
        headers: {
          Authorization: `Bearer ${FISH_API_KEY}`,
          'Content-Type': 'application/json',
          model: FISH_MODEL,
        },
        responseType: 'arraybuffer',
        timeout: REQUEST_TIMEOUT_MS,
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

module.exports = { synthesizeSpeech };
