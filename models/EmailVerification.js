const mongoose = require('mongoose');

// One row per verification code that has been issued (commands/account.js).
//
// The plaintext 6-digit code is NEVER stored — only a per-row random salt and
// a SHA-256 hash of salt+code. (Honest limit: a 6-digit code is only 1,000,000
// possibilities, so hashing alone can't protect it from someone who can read
// the database; the real protection is the short lifetime plus the attempt
// limit and lock enforced in commands/account.js.)
//
// Purposes:
//   email_verification — prove ownership of a brand-new address (first email)
//   email_change_auth  — prove ownership of the CURRENT address before it may
//                        be replaced (context.newEmail holds the target)
//   email_change       — prove ownership of the NEW address, then swap
//   session_unlock     — unlock a session locked for inactivity
const EmailVerificationSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  email: { type: String, required: true },           // where the code was sent
  purpose: {
    type: String,
    required: true,
    enum: ['email_verification', 'email_change_auth', 'email_change', 'session_unlock'],
  },
  codeHash: { type: String, required: true },
  salt: { type: String, required: true },
  expiresAt: { type: Date, required: true },          // when the CODE stops working
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, required: true },      // snapshot of config at issue time
  createdAt: { type: Date, default: Date.now },
  // Set when the row stops being usable: verified successfully, replaced by
  // a newer code for the same purpose, or killed by too many wrong attempts.
  closedAt: { type: Date, default: null },
  // The id of the bot's WhatsApp message that asked for the code. A reply is
  // only treated as an answer when it quotes THIS message.
  promptMsgId: { type: String, default: null },
  context: {
    newEmail: { type: String, default: null },        // email_change_auth only
    command: { type: String, default: null },         // session_unlock: command to resume
    args: { type: [String], default: [] },
    msgId: { type: String, default: null },           // original message, for resuming
    chatId: { type: String, default: null },
  },
  // Rows are kept for a day AFTER creation (not just until expiresAt) so the
  // "N codes per hour" limit can still count them; MongoDB deletes them
  // automatically after that, no scheduler needed.
  purgeAt: { type: Date, required: true },
});

EmailVerificationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
EmailVerificationSchema.index({ promptMsgId: 1 });
EmailVerificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('EmailVerification', EmailVerificationSchema);
