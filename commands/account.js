// commands/account.js — verified recovery email + 30-day session lock
//
// What lives here:
//   .setemail <address>   add or change your recovery email (command below)
//   _checkSession(...)    the "session gate" index.js runs after the
//                         registration gate and before any command
//   _handleOtpReply(...)  recognises a reply to one of the bot's code prompts
//                         and verifies the code (index.js calls it before the
//                         normal message routing)
//
// Names starting with "_" are not registered as commands by index.js's loader.
//
// How the pieces fit together
//   • An account that hasn't been active for SESSION_LOCK_DAYS is LOCKED the
//     next time it sends a command (User.sessionLockedAt, stored).
//   • A locked account with a verified email gets a code by email; replying to
//     the bot's prompt with that code unlocks it and re-runs the command that
//     triggered the lock. A locked account WITHOUT an email is told to run
//     .setemail (which is allowed while locked) — verifying that first email
//     also unlocks the session.
//   • Changing an existing verified email takes two proofs: first a code sent
//     to the CURRENT address, then a code sent to the NEW address.
//   • Codes live in the EmailVerification collection (hashed, never plain).
//   • If email isn't configured (RESEND_API_KEY / EMAIL_FROM), .setemail says
//     so and nobody is ever locked.
//   • Privacy: .setemail only works in a private chat with the bot, and a
//     group never sees any part of anyone's email — see emailForDisplay() in
//     utils/emailService.js.

const crypto = require('crypto');
const User = require('../models/User');
const EmailVerification = require('../models/EmailVerification');
const { isOwner, isMod, safeGetContact, safeGetQuotedMessage } = require('../utils/helpers');
const {
  BOT_PREFIX,
  EMAIL_OTP_TTL_MINUTES,
  EMAIL_OTP_MAX_ATTEMPTS,
  EMAIL_OTP_LOCK_MINUTES,
  EMAIL_OTP_RESEND_COOLDOWN_SECONDS,
  EMAIL_OTP_HOURLY_LIMIT,
  SESSION_LOCK_DAYS,
  SESSION_ACTIVITY_DEBOUNCE_MS,
} = require('../utils/config');
const { isEmailConfigured, normalizeEmail, maskEmail, isPrivateChat, emailForDisplay, sendVerificationEmail } = require('../utils/emailService');

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
// How long a verification row is kept in MongoDB. Must stay >= one hour so
// the "codes per hour" limit can still count it; the database deletes it
// automatically after this (see the TTL index in models/EmailVerification.js).
const RECORD_RETENTION_MS = ONE_DAY_MS;

// Accounts currently in the middle of issuing a code. Two commands from the
// same locked person arriving together would otherwise both pass the cooldown
// check before either had written a row, and send two emails.
const issuing = new Set();

// ─── Small helpers ──────────────────────────────────────────────────────────
// Same resolution order as index.js's registration gate.
async function resolveSenderId(msg) {
  try {
    const contact = await safeGetContact(msg);
    if (contact?.id?._serialized) return contact.id._serialized;
  } catch (err) {
    console.error('Account: contact lookup failed, using raw sender id:', err.message);
  }
  return msg.author || msg.from;
}

function userPart(id) {
  return String(id || '').split('@')[0].split(':')[0];
}

function sameUser(a, b) {
  return Boolean(a) && Boolean(b) && (a === b || userPart(a) === userPart(b));
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function codeMatches(code, salt, expectedHash) {
  const actual = Buffer.from(hashCode(code, salt), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function minutesLeft(untilMs, nowMs) {
  return Math.max(1, Math.ceil((untilMs - nowMs) / ONE_MINUTE_MS));
}

async function unlockSession(userId) {
  await User.updateOne(
    { id: userId },
    { $set: { sessionLockedAt: null, otpLockedUntil: null, lastActiveAt: Date.now() } }
  );
}

// ─── Issuing a code ─────────────────────────────────────────────────────────
// Applies the lock / cooldown / hourly limits, stores a hashed code, emails
// it, then replies on WhatsApp with the prompt the user must reply to. All
// user-facing failure messages are sent from here, so callers just return.
// Returns true only when a code was sent.
async function issueCode({ client, msg, userId, purpose, toEmail, context = {}, promptLines = [], skipCooldown = false }) {
  if (issuing.has(userId)) return false;
  issuing.add(userId);
  try {
    const now = Date.now();

    const lockInfo = await User.findOne({ id: userId }, 'otpLockedUntil').lean();
    if (lockInfo?.otpLockedUntil && lockInfo.otpLockedUntil.getTime() > now) {
      await msg.reply(`🔒 Too many incorrect codes. Verification is locked for ${minutesLeft(lockInfo.otpLockedUntil.getTime(), now)} more minute(s).`);
      return false;
    }

    if (!skipCooldown) {
      const latest = await EmailVerification.findOne({ userId }).sort({ createdAt: -1 }).lean();
      if (latest) {
        const waitMs = EMAIL_OTP_RESEND_COOLDOWN_SECONDS * 1000 - (now - latest.createdAt.getTime());
        if (waitMs > 0) {
          await msg.reply(`⏳ A code was just sent. Check your email and reply to my earlier message with it, or wait ${Math.ceil(waitMs / 1000)}s to request a new one.`);
          return false;
        }
      }
    }

    const sinceHour = new Date(now - ONE_HOUR_MS);
    const recentCount = await EmailVerification.countDocuments({ userId, createdAt: { $gte: sinceHour } });
    if (recentCount >= EMAIL_OTP_HOURLY_LIMIT) {
      const oldest = await EmailVerification.findOne({ userId, createdAt: { $gte: sinceHour } }).sort({ createdAt: 1 }).lean();
      const retryAt = oldest ? oldest.createdAt.getTime() + ONE_HOUR_MS : now + ONE_HOUR_MS;
      await msg.reply(`⏳ You've requested too many codes. Please try again in ${minutesLeft(retryAt, now)} minute(s).`);
      return false;
    }

    const code = generateCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const record = await EmailVerification.create({
      userId,
      email: toEmail,
      purpose,
      codeHash: hashCode(code, salt),
      salt,
      expiresAt: new Date(now + EMAIL_OTP_TTL_MINUTES * ONE_MINUTE_MS),
      maxAttempts: EMAIL_OTP_MAX_ATTEMPTS,
      purgeAt: new Date(now + RECORD_RETENTION_MS),
      context: {
        newEmail: context.newEmail || null,
        command: context.command || null,
        args: context.args || [],
        msgId: context.msgId || null,
        chatId: context.chatId || null,
      },
    });

    try {
      await sendVerificationEmail({ client, to: toEmail, code, purpose });
    } catch (err) {
      // The error text never contains the code or the API key.
      console.error('Account: verification email failed:', err.message);
      await EmailVerification.deleteOne({ _id: record._id }).catch(() => {});
      await msg.reply("❌ I couldn't send the email right now. Please try again in a few minutes.");
      return false;
    }

    // The new code is live — retire any older still-open code for the same
    // purpose so only the newest one can ever be used.
    await EmailVerification.updateMany(
      { userId, purpose, closedAt: null, _id: { $ne: record._id } },
      { $set: { closedAt: new Date(now) } }
    );

    const prompt = [
      ...promptLines,
      `Reply to *this message* with the 6-digit code. It expires in ${EMAIL_OTP_TTL_MINUTES} minutes.`,
      '',
      "📬 Don't see the email? Check your spam folder.",
    ].join('\n');
    try {
      const sent = await msg.reply(prompt);
      const promptMsgId = sent?.id?._serialized;
      if (promptMsgId) {
        await EmailVerification.updateOne({ _id: record._id }, { $set: { promptMsgId } });
      } else {
        console.error('Account: prompt was sent but its message id is unknown — the code cannot be matched to a reply.');
      }
    } catch (err) {
      console.error('Account: could not send the code prompt:', err.message);
    }
    return true;
  } finally {
    issuing.delete(userId);
  }
}

// ─── Session gate (called from index.js) ────────────────────────────────────
// Runs after the registration gate. Returns { blocked }. When blocked, this
// has already told the user what to do. Fails open on unexpected errors in
// the caller (same policy as the registration gate).
async function _checkSession(client, msg, command, args, registrationCheck) {
  // Without a working way to email codes nobody can be unlocked, so nobody
  // is ever locked.
  if (!isEmailConfigured()) return { blocked: false };

  const senderId = registrationCheck?.senderId;
  if (!senderId || !registrationCheck.wasActive) return { blocked: false };
  if (isOwner(senderId) || isMod(senderId)) return { blocked: false };
  // .setemail must keep working while locked — it's the way out for an
  // account that has no recovery email yet.
  if (['setemail', 'website', 'link', 'syncprofile'].includes(command)) return { blocked: false };

  const user = registrationCheck.user
    || await User.findOne({ id: senderId }, 'registration email emailVerifiedAt sessionLockedAt lastActiveAt').lean();
  if (!user) return { blocked: false };

  const now = Date.now();
  let locked = Boolean(user.sessionLockedAt);

  if (!locked && user.lastActiveAt && now - user.lastActiveAt >= SESSION_LOCK_DAYS * ONE_DAY_MS) {
    // Conditional on "not already locked" so two simultaneous commands lock
    // exactly once and keep the first lock time.
    await User.updateOne({ id: senderId, sessionLockedAt: null }, { $set: { sessionLockedAt: new Date(now) } });
    locked = true;
  }

  if (!locked) {
    // Successful use of the account: move the inactivity clock forward, at
    // most once per SESSION_ACTIVITY_DEBOUNCE_MS to keep database writes low.
    if (!user.lastActiveAt || now - user.lastActiveAt >= SESSION_ACTIVITY_DEBOUNCE_MS) {
      await User.updateOne({ id: senderId, sessionLockedAt: null }, { $set: { lastActiveAt: now } })
        .catch(err => console.error('Account: could not update activity clock:', err.message));
    }
    return { blocked: false };
  }

  // ── Locked ──
  if (!user.email) {
    await msg.reply(
      `🔒 *Session locked*\n\n` +
      `Your AniChan session is locked because your account has been inactive for more than ${SESSION_LOCK_DAYS} days.\n\n` +
      `You don't have a verified recovery email. Send *${BOT_PREFIX}setemail your@email.com* to me in a private chat to set one and unlock it.`
    );
    return { blocked: true };
  }

  // Only a real prefixed command can be re-run after unlocking; implicit AI
  // routes (DM chat, reply-to-bot, wake word) just need to be sent again.
  const resumable = String(msg.body || '').startsWith(BOT_PREFIX) && command !== 'copilot' && command !== 'voice';
  await issueCode({
    client,
    msg,
    userId: senderId,
    purpose: 'session_unlock',
    toEmail: user.email,
    context: resumable
      ? { command, args: (args || []).map(String), msgId: msg.id?._serialized, chatId: msg.from }
      : {},
    promptLines: [
      `🔒 *Session locked*`,
      ``,
      `Your AniChan session was locked after ${SESSION_LOCK_DAYS} days of inactivity.`,
      ``,
      `🔐 A verification code was sent to ${emailForDisplay(msg, user.email)}.`,
    ],
  });
  return { blocked: true };
}

// ─── Reply-with-code handling (called from index.js) ───────────────────────
// Returns true when the message was a reply to one of OUR code prompts and
// was dealt with (so index.js must not route it anywhere else), false for
// everything else. `resumeCommand({ msgId, command, args })` is supplied by
// index.js and re-runs the command that was interrupted by a lock.
async function _handleOtpReply(client, msg, resumeCommand) {
  if (msg.type !== 'chat' || !msg.hasQuotedMsg) return false;
  const typed = String(msg.body || '').trim();
  const digits = typed.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(digits)) return false;

  const quoted = await safeGetQuotedMessage(msg).catch(() => null);
  if (!quoted || !quoted.fromMe || !quoted.id?._serialized) return false;

  const record = await EmailVerification.findOne({ promptMsgId: quoted.id._serialized }).lean();
  if (!record) return false;

  const senderId = await resolveSenderId(msg);
  if (!sameUser(senderId, record.userId)) {
    await msg.reply("❌ That code isn't for you.");
    return true;
  }

  const now = Date.now();
  if (record.closedAt) {
    await msg.reply('❌ That code is no longer valid. Request a new one.');
    return true;
  }
  if (record.expiresAt.getTime() <= now) {
    await EmailVerification.updateOne({ _id: record._id, closedAt: null }, { $set: { closedAt: new Date(now) } });
    await msg.reply('⌛ That code has expired. Request a new one.');
    return true;
  }

  const lockInfo = await User.findOne({ id: record.userId }, 'otpLockedUntil').lean();
  if (lockInfo?.otpLockedUntil && lockInfo.otpLockedUntil.getTime() > now) {
    await msg.reply(`🔒 Too many incorrect codes. Verification is locked for ${minutesLeft(lockInfo.otpLockedUntil.getTime(), now)} more minute(s).`);
    return true;
  }

  if (!codeMatches(digits, record.salt, record.codeHash)) {
    const updated = await EmailVerification.findOneAndUpdate(
      { _id: record._id, closedAt: null },
      { $inc: { attempts: 1 } },
      { new: true }
    );
    if (!updated) {
      await msg.reply('❌ That code is no longer valid. Request a new one.');
      return true;
    }
    const remaining = updated.maxAttempts - updated.attempts;
    if (remaining <= 0) {
      await EmailVerification.updateOne({ _id: record._id }, { $set: { closedAt: new Date(now) } });
      await User.updateOne({ id: record.userId }, { $set: { otpLockedUntil: new Date(now + EMAIL_OTP_LOCK_MINUTES * ONE_MINUTE_MS) } });
      await msg.reply(`🔒 Too many incorrect codes. Verification is locked for ${EMAIL_OTP_LOCK_MINUTES} minutes.`);
    } else {
      await msg.reply(`❌ Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`);
    }
    return true;
  }

  // Correct code. Closing the row is the atomic "claim": if two replies race,
  // only one of them gets the row back and does the work.
  const claimed = await EmailVerification.findOneAndUpdate(
    { _id: record._id, closedAt: null },
    { $set: { closedAt: new Date(now) } }
  );
  if (!claimed) return true;

  switch (record.purpose) {
    case 'email_verification':
    case 'email_change': {
      await User.updateOne(
        { id: record.userId },
        { $set: { email: record.email, emailVerifiedAt: new Date(now), otpLockedUntil: null } }
      );
      const user = await User.findOne({ id: record.userId }, 'sessionLockedAt').lean();
      const wasLocked = Boolean(user?.sessionLockedAt);
      if (wasLocked) await unlockSession(record.userId);
      await msg.reply(
        `✅ Email verified: ${emailForDisplay(msg, record.email)}` +
        (wasLocked ? '\n🔓 Your session is unlocked.' : '')
      );
      return true;
    }

    case 'email_change_auth': {
      const newEmail = record.context?.newEmail;
      if (!newEmail) {
        await msg.reply(`❌ Something went wrong. Please start again with *${BOT_PREFIX}setemail*.`);
        return true;
      }
      await issueCode({
        client,
        msg,
        userId: record.userId,
        purpose: 'email_change',
        toEmail: newEmail,
        skipCooldown: true,
        promptLines: [
          '✅ Current email confirmed.',
          '',
          `🔐 Now verify your NEW email — a code was sent to ${emailForDisplay(msg, newEmail)}.`,
        ],
      });
      return true;
    }

    case 'session_unlock': {
      await unlockSession(record.userId);
      const { command, args, msgId } = record.context || {};
      const canResume = Boolean(command && msgId && typeof resumeCommand === 'function');
      await msg.reply(canResume ? '✅ Session unlocked! Running your command…' : `✅ Session unlocked! Welcome back — send your command again.`);
      if (canResume) {
        try {
          await resumeCommand({ msgId, command, args: args || [] });
        } catch (err) {
          console.error('Account: could not resume the original command:', err.message);
          await msg.reply('⚠️ I couldn\'t re-run your command automatically — please send it again.');
        }
      }
      return true;
    }

    default:
      await msg.reply('❌ Something went wrong with that code. Please request a new one.');
      return true;
  }
}

// ─── .setemail ──────────────────────────────────────────────────────────────
module.exports = {
  // .setemail <address>
  async setemail(client, msg, args) {
    // Private chat only: the address would otherwise be typed — in full —
    // into a group. This check comes first so a group learns nothing.
    if (!isPrivateChat(msg)) {
      return msg.reply(`🔒 For your privacy, use *${BOT_PREFIX}setemail* in a private chat with me — not in a group.`);
    }

    if (!isEmailConfigured()) {
      return msg.reply(
        "❌ Email verification isn't set up on this bot yet.\n" +
        'The bot owner needs to set RESEND_API_KEY and EMAIL_FROM in the .env file.'
      );
    }

    const userId = await resolveSenderId(msg);
    const user = await User.findOne({ id: userId }, 'email sessionLockedAt').lean();
    if (!user) {
      return msg.reply(`❌ You don't have an account yet. Start with *${BOT_PREFIX}reg*.`);
    }

    const raw = args[0];
    if (!raw) {
      const status = user.email
        ? `📧 Your verified email: ${maskEmail(user.email)}\n\nTo change it: *${BOT_PREFIX}setemail new@email.com*`
        : `📧 You haven't set a recovery email yet.\n\nSet one: *${BOT_PREFIX}setemail your@email.com*`;
      return msg.reply(
        `${status}\n\n` +
        `Your email is used to unlock your account after ${SESSION_LOCK_DAYS} days of inactivity.`
      );
    }

    const email = normalizeEmail(raw);
    if (!email) {
      return msg.reply(`❌ That doesn't look like a valid email address.\nExample: *${BOT_PREFIX}setemail you@example.com*`);
    }
    if (user.email === email) {
      return msg.reply(`✅ ${maskEmail(email)} is already your verified email.`);
    }

    if (user.email) {
      // Existing verified email: prove control of it BEFORE it can be replaced.
      await issueCode({
        client,
        msg,
        userId,
        purpose: 'email_change_auth',
        toEmail: user.email,
        context: { newEmail: email },
        promptLines: [
          `🔐 To change your email, first confirm your current one — a code was sent to ${maskEmail(user.email)}.`,
        ],
      });
      return;
    }

    await issueCode({
      client,
      msg,
      userId,
      purpose: 'email_verification',
      toEmail: email,
      promptLines: [
        `🔐 Verification code sent to ${maskEmail(email)}.`,
      ],
    });
  },

  // Exported for index.js; the leading underscore keeps them out of the
  // command table.
  _checkSession,
  _handleOtpReply,
};
