const mongoose = require('mongoose');

// ─── Age Verification Lockout (.setdob under-18 denial) ────────────────────
// See .setdob in commands/economy.js and MIN_REGISTRATION_AGE /
// AGE_VERIFICATION_LOCKOUT_DAYS in utils/config.js.
//
// Created when someone's .setdob calculates an age under the minimum —
// registration is denied and this flag is stored so the same WhatsApp id
// can't just immediately retry with a different (fake) date of birth to
// bypass the check. Deliberately NOT part of the User model: this can
// exist for a WhatsApp id that never even got as far as creating a User
// document (e.g. .setdob was the very first thing they tried), and it
// intentionally stores only the minimum needed to enforce the lockout —
// not a permanent record of anyone's rejected date of birth.
//
// `expiresAt` is a native MongoDB TTL index (`expires: 0` means "delete at
// the time stored in this field", not "N seconds after") — the document
// (and the dobEntered it holds) is deleted automatically by MongoDB once
// the lockout period elapses, with no cron/interval needed. Same reasoning
// as models/User.js's lazy daily-interest check: this bot can't rely on an
// always-on scheduler firing at an exact time on Termux, but a TTL index is
// enforced by MongoDB itself and needs the bot process to be running at all.
//
// NOTE: MongoDB's TTL background sweep runs roughly once a minute, not
// instantly at the exact expiry moment — .setdob's own lockout check
// accounts for this by treating an already-expired-but-not-yet-swept
// document as expired (and deleting it itself) rather than trusting the
// document's mere existence.
const AgeVerificationSchema = new mongoose.Schema({
  // Same WhatsApp id format used as User.id (e.g. "234801234567@c.us").
  id: { type: String, required: true, unique: true },
  dobEntered: { type: Date, required: true },
  calculatedAge: { type: Number, required: true },
  deniedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = mongoose.model('AgeVerification', AgeVerificationSchema);
