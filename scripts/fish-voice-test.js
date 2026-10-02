#!/usr/bin/env node
'use strict';

// Listening test for the persona voices. Generates the SAME moment four ways so
// you can hear what each change does, then you pick with your ears:
//
//   1-bookish-default.mp3      formal, written-style line, Fish default sampling
//   2-spoken-default.mp3       spoken-style line, Fish default sampling
//   3-spoken-tuned.mp3         spoken-style line + this persona's tuning (what the bot sends now)
//   4-spoken-tuned-cue.mp3     same as 3 plus ONE short [cue] (the optional FISH_EXPRESSION_TAGS mode)
//
//   node scripts/fish-voice-test.js                     marin (AI_PERSONA) with a built-in line
//   node scripts/fish-voice-test.js karane              another persona
//   node scripts/fish-voice-test.js rias "Your own line here"   your own spoken-style line (skips file 1)
//
// Uses 3 or 4 Fish Audio requests per run. Files go to voice-tests/<persona>-<time>/.
// If file 4 says the cue out loud (you hear the word "excited", "surprised", ...),
// leave FISH_EXPRESSION_TAGS off. If 3 already sounds good, leave it off as well.

const path = require('node:path');
const fs = require('node:fs/promises');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { loadPersona, listPersonaIds } = require('../utils/persona');
const { AI_PERSONA } = require('../utils/config');
const fishAudio = require('../utils/fishAudio');
const { toSpeechText, applyExpressionCue, inferExpressionCue } = require('../utils/speechText');

const SAMPLES = {
  marin: {
    bookish: 'You have finished the project. That is a great accomplishment, and I am proud of you.',
    spoken: "Ehh?! Wait, wait, you actually finished it? Ahaha, no way! Okay, that's seriously amazing, I'm so proud of you right now!",
  },
  karane: {
    bookish: 'Thank you for doing that for me. I appreciate it, but please do not make it awkward.',
    spoken: "Eh?! W-wait, you did that for me? Mou... fine, okay, thanks. Don't make it weird, alright?",
  },
  rias: {
    bookish: 'You have figured it out. I am impressed. Please explain how you accomplished it.',
    spoken: "Oh? Hmm... so you finally figured it out. Ara, I'm impressed. Come on, tell me how you did it.",
  },
};
const FISH_DEFAULTS = { temperature: 0.7, topP: 0.7, speed: 1, volume: 0 };

function errMessage(err) {
  return String(err?.message || err || 'unknown error').slice(0, 300);
}

async function main() {
  const args = process.argv.slice(2);
  const knownIds = listPersonaIds();
  const personaId = knownIds.includes((args[0] || '').toLowerCase()) ? args.shift().toLowerCase() : AI_PERSONA;
  const customLine = args.join(' ').trim();

  if (!process.env.FISH_API_KEY) throw new Error('FISH_API_KEY is missing from .env');
  const persona = loadPersona(personaId);
  const sample = SAMPLES[persona.id] || SAMPLES.marin;

  const spoken = toSpeechText(customLine || sample.spoken);
  const variants = [];
  if (!customLine) variants.push({ file: '1-bookish-default.mp3', text: toSpeechText(sample.bookish), overrides: FISH_DEFAULTS, note: 'formal line, Fish defaults' });
  variants.push({ file: '2-spoken-default.mp3', text: spoken, overrides: FISH_DEFAULTS, note: 'spoken line, Fish defaults' });
  variants.push({ file: '3-spoken-tuned.mp3', text: spoken, overrides: {}, note: `spoken line + ${persona.displayName} tuning (current bot behaviour)` });
  const cue = inferExpressionCue(spoken) || 'excited';
  variants.push({ file: '4-spoken-tuned-cue.mp3', text: applyExpressionCue(spoken, cue), overrides: {}, note: `same as 3 with the cue [${cue}]` });

  const outDir = path.join(__dirname, '..', 'voice-tests', `${persona.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`Persona: ${persona.displayName} (${persona.id}) - tuning: ${JSON.stringify({ ...persona.voice, referenceId: undefined })}`);
  let made = 0;
  for (const variant of variants) {
    try {
      const mp3 = await fishAudio.synthesizeSpeech(variant.text, { persona, overrides: variant.overrides });
      await fs.writeFile(path.join(outDir, variant.file), mp3);
      made += 1;
      console.log(`  ok  ${variant.file}  (${variant.note})\n      text: ${variant.text}`);
    } catch (err) {
      console.error(`  FAILED ${variant.file}: ${errMessage(err)}`);
    }
  }
  if (!made) throw new Error('No clip could be generated. Check FISH_API_KEY, credits and the persona voice ID.');

  console.log(`\nSaved ${made} clip(s) in ${path.relative(path.join(__dirname, '..'), outDir)}`);
  console.log('Copy them to your phone to listen:');
  console.log(`  cp ${path.relative(path.join(__dirname, '..'), outDir)}/*.mp3 ~/storage/downloads/`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Voice test failed: ${errMessage(err)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, SAMPLES };
