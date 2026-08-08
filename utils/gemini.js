// ─── Gemini API wrapper ─────────────────────────────────────────────────────
// Talks to Google's Generative Language API directly over REST (axios),
// deliberately avoiding the @google/generative-ai SDK so no new npm install
// is required on top of what's already in package.json — important given
// how unreliable `npm install` is over unstable Airtel/MTN data.
//
// Models are read from env so they can be swapped without touching code if
// Google renames/deprecates one (this happens often — see GEMINI_TEXT_MODEL
// and GEMINI_IMAGE_MODEL below). Defaults target the free tier as of when
// this was written.
const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google has been restricting which models new API keys/projects can call
// every few weeks throughout 2026 — gemini-2.5-flash and gemini-2.5-pro both
// now 404 with "no longer available to new users" on freshly created keys,
// even though older keys can still use them. Because of that churn, don't
// trust this default blindly: run probe-gemini-models.sh (project root)
// against your actual key first and set GEMINI_TEXT_MODEL / GEMINI_IMAGE_MODEL
// in .env to whatever it reports as working. gemini-3.1-flash-lite is what
// Google was steering new keys toward as of when this was written.
//
// NOTE: TEXT_MODEL is also used for vision (image-input) requests below in
// generateVision() — Gemini's generateContent endpoint accepts image parts
// on the same text models, there's no separate "vision model" to configure.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-flash-lite';

// Image generation model. Google's newer image models (gemini-3.1-flash-image
// and later) are paid-only with no free tier — gemini-2.5-flash-image was the
// last one documented with a free daily quota, but given the pattern above it
// may also be restricted for new keys. Confirm with the probe script.
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

// Generous but bounded timeout — better to fail and let the command handler
// show an error than hang forever on a bad connection.
const REQUEST_TIMEOUT_MS = 45000;

function assertKey() {
  if (!GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not set in .env');
    err.code = 'NO_GEMINI_KEY';
    throw err;
  }
}

function extractApiErrorMessage(err) {
  return (
    err.response?.data?.error?.message ||
    err.response?.data?.message ||
    err.message ||
    'Unknown Gemini API error'
  );
}

// Shared by generateText/generateVision — both send back the same
// { candidates: [{ content: { parts: [...] }, finishReason }] } shape, so
// the "pull the text out, or explain why there isn't any" logic is common.
function extractTextOrThrow(res) {
  const candidate = res.data?.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text || '').join('').trim();

  if (!text) {
    // Most common cause: the prompt (or image) tripped Gemini's safety
    // filters, which comes back as a candidate with no parts and a
    // finishReason instead of an HTTP error.
    const reason = candidate?.finishReason;
    const err = new Error(reason ? `Gemini returned no text (finishReason: ${reason})` : 'Gemini returned an empty response');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    // The reply IS truncated, but there's still usable text — better to
    // return the partial answer than throw. Logged so it's visible in
    // pm2 logs instead of silently handing back a cut-off reply. See the
    // maxOutputTokens comment on generateText/generateVision below for why
    // this happens even on models with minimal thinking.
    console.warn(`Gemini: response hit MAX_TOKENS and was truncated (${text.length} chars returned). Consider raising maxOutputTokens for this call.`);
  }

  return text;
}

// Gemini 3.x models (gemini-3.1-flash-lite included) run an internal
// "thinking" pass before writing the visible answer, and — per Google's
// docs — thinking tokens and output tokens are BOTH drawn from the same
// maxOutputTokens budget. Flash-Lite already defaults to the lowest
// available thinkingLevel ("minimal"), but "minimal doesn't guarantee
// thinking is off — the model may reason very minimally for complex
// tasks" (Google's wording), and things like solving a math problem in a
// photo count as exactly that kind of complex task. Pinning thinkingLevel
// explicitly (rather than relying on the implicit per-model default) is
// cheap insurance: if GEMINI_TEXT_MODEL ever gets swapped to a fuller
// non-Lite Flash model (plausible given how often Google has been
// restricting model access — see the TEXT_MODEL comment above), that
// model's default thinking level is "medium", not "minimal", which would
// eat noticeably more of the budget and make truncation worse, not better.
function buildGenerationConfig(maxOutputTokens) {
  return {
    maxOutputTokens,
    thinkingConfig: { thinkingLevel: 'minimal' },
  };
}

// ─── Text generation (single-turn or with history) ─────────────────────────
// history: array of { role: 'user' | 'assistant', content: string } — the
// same shape ai.js already keeps in its chatHistory Map. Gemini calls the
// assistant role "model", so it gets remapped here.
//
// maxOutputTokens default raised from the original 800 to 2048 — 800 was
// tight enough that even minimal thinking + a genuinely detailed answer
// (e.g. solving a math problem) could hit MAX_TOKENS and cut off mid-reply.
async function generateText({ systemPrompt, history = [], prompt, maxOutputTokens = 2048 }) {
  assertKey();

  const contents = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const body = {
    contents,
    generationConfig: buildGenerationConfig(maxOutputTokens),
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  try {
    const res = await axios.post(
      `${BASE_URL}/${TEXT_MODEL}:generateContent`,
      body,
      {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return extractTextOrThrow(res);
  } catch (err) {
    if (err.code === 'EMPTY_RESPONSE') throw err;
    const msg = extractApiErrorMessage(err);
    const wrapped = new Error(`Gemini text generation failed: ${msg}`);
    wrapped.code = 'GEMINI_TEXT_ERROR';
    wrapped.status = err.response?.status;
    throw wrapped;
  }
}

// ─── Vision (image + text prompt) ───────────────────────────────────────────
// Used when .copilot/.gpt/.voice are used replying to an image — sends the
// image as an inlineData part alongside the text prompt in the same
// generateContent call that generateText() uses for plain text. history (if
// any) stays plain text, same shape/mapping as generateText — only the
// newest turn carries the image, since Gemini doesn't need the image
// re-sent on every follow-up message to keep the thread coherent.
async function generateVision({ systemPrompt, history = [], prompt, base64Image, mimeType, maxOutputTokens = 2048 }) {
  assertKey();

  if (!base64Image) {
    const err = new Error('generateVision called without an image');
    err.code = 'NO_IMAGE_DATA';
    throw err;
  }

  const contents = history.map(h => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }));

  contents.push({
    role: 'user',
    parts: [
      { text: prompt },
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Image } },
    ],
  });

  const body = {
    contents,
    generationConfig: buildGenerationConfig(maxOutputTokens),
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  try {
    const res = await axios.post(
      `${BASE_URL}/${TEXT_MODEL}:generateContent`,
      body,
      {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return extractTextOrThrow(res);
  } catch (err) {
    if (err.code === 'EMPTY_RESPONSE') throw err;
    const msg = extractApiErrorMessage(err);
    const wrapped = new Error(`Gemini vision analysis failed: ${msg}`);
    wrapped.code = 'GEMINI_VISION_ERROR';
    wrapped.status = err.response?.status;
    throw wrapped;
  }
}

// ─── Image generation ───────────────────────────────────────────────────────
// Returns { base64, mimeType } for the first inline image part Gemini sends
// back. gemini-2.5-flash-image returns images as inlineData parts inside a
// normal generateContent response (not a separate images.generate endpoint
// like OpenAI/DALL-E used).
async function generateImage(prompt) {
  assertKey();

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };

  try {
    const res = await axios.post(
      `${BASE_URL}/${IMAGE_MODEL}:generateContent`,
      body,
      {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    const parts = res.data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData || p.inline_data);
    const inline = imagePart?.inlineData || imagePart?.inline_data;

    if (!inline?.data) {
      const reason = res.data?.candidates?.[0]?.finishReason;
      const err = new Error(reason ? `Gemini returned no image (finishReason: ${reason})` : 'Gemini returned no image data');
      err.code = 'EMPTY_IMAGE';
      throw err;
    }

    return {
      base64: inline.data,
      mimeType: inline.mimeType || inline.mime_type || 'image/png',
    };
  } catch (err) {
    if (err.code === 'EMPTY_IMAGE') throw err;
    const msg = extractApiErrorMessage(err);
    const wrapped = new Error(`Gemini image generation failed: ${msg}`);
    wrapped.code = 'GEMINI_IMAGE_ERROR';
    wrapped.status = err.response?.status;
    throw wrapped;
  }
}

// ─── Audio transcription ────────────────────────────────────────────────────
// Replaces the old Whisper (OpenAI) call. Gemini accepts audio as inline
// base64 data directly in a generateContent request — no separate
// transcription endpoint or file upload needed for short voice notes
// (WhatsApp voice notes are almost always well under the ~20MB inline limit).
async function transcribeAudio({ base64Audio, mimeType }) {
  assertKey();

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribe this audio exactly. Return ONLY the transcribed text, nothing else — no preamble, no quotes.' },
          { inlineData: { mimeType: mimeType || 'audio/ogg', data: base64Audio } },
        ],
      },
    ],
    generationConfig: buildGenerationConfig(2048),
  };

  try {
    const res = await axios.post(
      `${BASE_URL}/${TEXT_MODEL}:generateContent`,
      body,
      {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return extractTextOrThrow(res);
  } catch (err) {
    if (err.code === 'EMPTY_RESPONSE') throw err;
    const msg = extractApiErrorMessage(err);
    const wrapped = new Error(`Gemini transcription failed: ${msg}`);
    wrapped.code = 'GEMINI_TRANSCRIBE_ERROR';
    wrapped.status = err.response?.status;
    throw wrapped;
  }
}

module.exports = { generateText, generateVision, generateImage, transcribeAudio };
