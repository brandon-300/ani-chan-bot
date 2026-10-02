
// Minimal singleton-per-key store for small persistent bot state that
// doesn't warrant its own dedicated collection/model — e.g. "the date the
// daily stats digest was last sent", so a PM2 restart that happens to land
// in that exact minute doesn't cause a duplicate send. Not meant for
// anything bigger than a handful of small flags/dates.
import mongoose from 'mongoose';
const BotStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: String, default: null },
});

export default mongoose.model('BotState', BotStateSchema);
