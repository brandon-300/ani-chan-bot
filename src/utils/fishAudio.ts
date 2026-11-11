// Fish Audio TTS wrapper
// Calls Fish Audio's REST API directly over axios. The API key/model are
// process-wide; voice.referenceId belongs to each persona. FISH_VOICE_ID is
// only a final emergency override for operators who intentionally force one
// voice across the whole process.
//
// Delivery tuning (all documented request fields):
//   temperature / top_p   higher = more varied, more expressive delivery
//   prosody.speed/volume  pacing and level
//   latency / chunk_length  sent only when explicitly configured
// Defaults come from utils/config.js; a persona's meta.json `voice` block
// (speed, volume, temperature, topP) overrides them for that persona only.
import axios from 'axios';
import { getActivePersonaSafe } from './persona.js';
import { BOT_OWNER } from './config.js';

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
} = await import('./config.js');

const FISH_API_KEY = process.env.FISH_API_KEY;

// Anime character voice settings for improved quality
// These are optimized for anime character voices with emotion
const ANIME_VOICE_SETTINGS = {
  // Default anime voice settings
  default: {
    temperature: 0.7,
    topP: 0.9,
    speed: 1.0,
    volume: 0,
  },
  // Persona-specific voice profiles
  personas: {
    // Example persona IDs - these should match your persona config
    // Add more personas as needed
    'rem': {
      referenceId: 'a0e99841-438c-4a64-b679-ae501e7d6091', // Example: Rem from Re:Zero
      temperature: 0.8,
      topP: 0.95,
      speed: 1.1,
      volume: 2,
    },
    'ram': {
      referenceId: 'b1f2a3d4-567e-4b8c-9d0e-1f2a3d4b567e', // Example: Ram from Re:Zero
      temperature: 0.75,
      topP: 0.9,
      speed: 1.05,
      volume: 1,
    },
    'emilia': {
      referenceId: 'c2g3b4e5-678f-4c9d-0e1f-2a3b4c5d678f', // Example: Emilia from Re:Zero
      temperature: 0.85,
      topP: 0.95,
      speed: 0.95,
      volume: 3,
    },
    'zero_two': {
      referenceId: 'd3h4c5f6-789g-4d0f-1e2g-3b4c5d6e789g', // Example: Zero Two from Darling in the Franxx
      temperature: 0.7,
      topP: 0.85,
      speed: 0.9,
      volume: 4,
    },
    'mikasa': {
      referenceId: 'e4i5d6g7-890h-4e1g-2f3h-4c5d6e7f890h', // Example: Mikasa from Attack on Titan
      temperature: 0.65,
      topP: 0.8,
      speed: 0.85,
      volume: 5,
    },
  },
};

function resolveVoiceId(voiceId, personaId = null) {
  const activePersona = personaId ? { id: personaId } : getActivePersonaSafe();
  
  // Check if we have anime voice settings for this persona
  const personaSettings = ANIME_VOICE_SETTINGS.personas[personaId || activePersona?.id || ''];
  if (personaSettings && personaSettings.referenceId) {
    return personaSettings.referenceId;
  }
  
  // Fall back to persona's own voice reference
  if (activePersona?.voice?.referenceId) {
    return activePersona.voice.referenceId;
  }
  
  // Fall back to global FISH_VOICE_ID
  const selected = voiceId || FISH_VOICE_ID;
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

// Get anime voice settings for a persona
function getAnimeVoiceSettings(personaId) {
  const personaSettings = ANIME_VOICE_SETTINGS.personas[personaId || ''];
  if (personaSettings) {
    return personaSettings;
  }
  return ANIME_VOICE_SETTINGS.default;
}

// Builds the JSON body for POST /v1/tts. Pure function (no I/O) so the exact
// request can be tested. `overrides` beat the persona, which beats config.
function buildTtsPayload(text, referenceId, personaId = null, overrides = {}) {
  const activePersona = personaId ? { id: personaId, voice: {} } : getActivePersonaSafe();
  
  // Get anime voice settings for this persona
  const animeSettings = getAnimeVoiceSettings(personaId || activePersona?.id);
  
  const tuning = activePersona?.voice || {};
  
  // Use anime settings if available, otherwise fall back to persona/config
  const temperature = pickNumber(
    overrides.temperature,
    animeSettings.temperature,
    tuning.temperature,
    FISH_TEMPERATURE
  );
  const topP = pickNumber(
    overrides.topP,
    animeSettings.topP,
    tuning.topP,
    FISH_TOP_P
  );
  const speed = pickNumber(
    overrides.speed,
    animeSettings.speed,
    tuning.speed,
    FISH_SPEED
  );
  const volume = pickNumber(
    overrides.volume,
    animeSettings.volume,
    tuning.volume,
    FISH_VOLUME_DB
  );

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
// always applied by Fish Audio itself.
async function synthesizeSpeech(text, personaId = null, voiceId = null, overrides = {}) {
  assertConfig();

  const referenceId = resolveVoiceId(voiceId, personaId);
  const payload = buildTtsPayload(text, referenceId, personaId, overrides);

  try {
    const response = await axios.post(
      'https://api.fish.audio/v1/tts',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${FISH_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: FISH_REQUEST_TIMEOUT_MS,
      }
    );

    // Validate response
    if (!response.data || response.data.byteLength === 0) {
      const err = new Error('Fish Audio returned empty audio data');
      err.code = 'EMPTY_AUDIO';
      throw err;
    }

    return response.data;
  } catch (err) {
    if (err.response) {
      err.message = extractApiErrorMessage(err);
    }
    throw err;
  }
}

// Convenience: synthesize and return as a Buffer (already is one, but this
// makes the contract explicit for callers that don't need the raw bytes).
async function synthesizeSpeechBuffer(text, personaId, voiceId, overrides) {
  return synthesizeSpeech(text, personaId, voiceId, overrides);
}

export default {
  synthesizeSpeech,
  synthesizeSpeechBuffer,
  buildTtsPayload,
  resolveVoiceId,
  getAnimeVoiceSettings,
  ANIME_VOICE_SETTINGS,
};
