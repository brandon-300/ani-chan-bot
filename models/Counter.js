const mongoose = require('mongoose');

// Minimal atomic sequence generator — same "small singleton-per-key store"
// spirit as models/BotState.js, but typed as a Number specifically so $inc
// stays atomic even if two documents (e.g. two .guild create calls
// arriving close together) land in the same tick. BotState's `value` field
// is a String, which can't be safely incremented this way.
const CounterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', CounterSchema);

// Atomically returns the next integer in the named sequence, starting at 1
// the first time a given key is used. Safe under concurrent callers —
// findOneAndUpdate's $inc is a single atomic operation in MongoDB, so two
// simultaneous callers can never receive the same number.
async function getNextSequence(key) {
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { upsert: true, new: true }
  );
  return doc.value;
}

module.exports = { Counter, getNextSequence };
