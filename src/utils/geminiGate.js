'use strict';

// ─── Gemini reservation gate ────────────────────────────────────────────────
// While the background sticker-analysis queue is working (or paused waiting for
// Gemini's quota to come back), the shared Gemini quota belongs to that queue.
// This module answers one question — "is Gemini reserved right now?" — for:
//   • index.js, which replies "unavailable" to Gemini commands up front, and
//   • utils/gemini.js, which refuses any other caller as a safety net.
//
// It has no dependency on utils/aiStickers.js (which requires utils/gemini.js),
// so there is no circular import: aiStickers registers itself as the provider.
//
// Everything here fails OPEN: if the provider throws or nothing is registered,
// Gemini is treated as available, so a bug here can never take commands down.

import { GEMINI_PAUSE_DURING_STICKER_ANALYSIS, GEMINI_COMMANDS, GEMINI_BUSY_MESSAGE } from './config.js';

const geminiCommandNames = new Set(GEMINI_COMMANDS.map(name => String(name).toLowerCase()));
let reservationProvider = () => false;

function setReservationProvider(provider) {
  reservationProvider = typeof provider === 'function' ? provider : () => false;
}

function isReserved() {
  if (!GEMINI_PAUSE_DURING_STICKER_ANALYSIS) return false;
  try {
    return Boolean(reservationProvider());
  } catch (_err) {
    return false;
  }
}

function isGeminiCommand(name) {
  return geminiCommandNames.has(String(name || '').toLowerCase());
}

function shouldBlockCommand(name) {
  return isGeminiCommand(name) && isReserved();
}

function makeBusyError() {
  const err = new Error(GEMINI_BUSY_MESSAGE);
  err.code = 'GEMINI_BUSY';
  return err;
}

// Throws GEMINI_BUSY unless Gemini is free or the caller is the analysis queue
// itself (bypass). Called at the top of every function in utils/gemini.js.
function assertAvailable({ bypass = false } = {}) {
  if (!bypass && isReserved()) throw makeBusyError();
}

export default {
  setReservationProvider,
  isReserved,
  isGeminiCommand,
  shouldBlockCommand,
  assertAvailable,
  BUSY_MESSAGE: GEMINI_BUSY_MESSAGE,
};
