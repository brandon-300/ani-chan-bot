// utils/emailService.js — sends AniChan's verification emails.
//
// Two ways to send, chosen with EMAIL_PROVIDER in .env (see utils/config.js):
//   resend — Resend's plain HTTPS API through axios (already a dependency).
//            Needs a domain you own, verified in Resend.
//   smtp   — any SMTP mailbox, e.g. a free Gmail account with an App
//            Password. No domain needed. Uses the "nodemailer" package, which
//            is loaded only when this mode is actually used, so the bot still
//            starts normally if it isn't installed.
//
// The email's pictures are attached as inline "CID" images, which means the
// recipient's mail app never has to download anything from the internet to
// show them:
//   • header banner  — a file in the project (EMAIL_HEADER_IMAGE_PATH)
//   • avatar circle  — the bot's CURRENT WhatsApp profile picture, looked up
//                      at send time, so changing it later changes every
//                      future email. Falls back to MENU_IMAGE_URL, and if
//                      neither can be fetched the email is still sent
//                      without the avatar rather than failing.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  MENU_IMAGE_URL,
  EMAIL_PROVIDER,
  RESEND_API_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_FROM_NAME,
  EMAIL_OTP_TTL_MINUTES,
  EMAIL_REQUEST_TIMEOUT_MS,
  EMAIL_IMAGE_MAX_BYTES,
  EMAIL_HEADER_IMAGE_PATH,
} = require('./config');
const { buildVerificationEmail, CID_HEADER, CID_AVATAR } = require('./emailTemplate');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const PROJECT_ROOT = path.resolve(__dirname, '..');

// The chosen provider's required values must be set in .env — see the email
// section of utils/config.js. Everything else in the account-security
// feature (including the session lock) switches itself off without them.
function isEmailConfigured() {
  if (EMAIL_PROVIDER === 'smtp') return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_FROM);
  return Boolean(RESEND_API_KEY && EMAIL_FROM);
}

// Lowercases/trims and validates. Returns null for anything that isn't a
// plausible single address. Deliberately simple: the real proof an address
// works is the code that gets sent to it.
function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > 254) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) {
    return null;
  }
  const [local] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  return email;
}

// "johndoe@gmail.com" -> "j***@gmail.com" — safe to show in a group chat.
function maskEmail(email) {
  const value = String(email || '');
  const at = value.lastIndexOf('@');
  if (at < 1) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

// True only for a one-to-one chat with the bot. Anything that isn't clearly a
// private chat (a group, a broadcast, an unknown id format) counts as NOT
// private, so sensitive account details fail closed.
function isPrivateChat(msg) {
  const from = String(msg?.from || '');
  return from.endsWith('@c.us') || from.endsWith('@lid');
}

// What may be shown about someone's email in the chat this message came from:
// the masked address in a private chat, a generic phrase anywhere else, so a
// group never learns even a hint of it.
function emailForDisplay(msg, email) {
  return isPrivateChat(msg) ? maskEmail(email) : 'your recovery email';
}

// Image type from the file's own first bytes — more trustworthy than a
// server's Content-Type header. Returns null for anything that isn't a
// format mail apps reliably display inline.
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.slice(0, 4).toString('ascii') === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: EMAIL_REQUEST_TIMEOUT_MS,
    maxContentLength: EMAIL_IMAGE_MAX_BYTES,
    maxBodyLength: EMAIL_IMAGE_MAX_BYTES,
  });
  const buffer = Buffer.from(response.data);
  const type = sniffImageType(buffer);
  if (!type) throw new Error('downloaded file is not a supported image');
  return { buffer, ...type };
}

// Current WhatsApp profile picture of the bot -> MENU_IMAGE_URL -> null.
// Never throws: a missing avatar must not stop a verification email.
async function getAvatarImage(client) {
  try {
    const url = await client.getProfilePicUrl(client.info.wid._serialized);
    if (url) return await downloadImage(url);
  } catch (err) {
    console.error('Email: bot profile picture unavailable, trying fallback image:', err.message);
  }
  if (MENU_IMAGE_URL) {
    try {
      return await downloadImage(MENU_IMAGE_URL);
    } catch (err) {
      console.error('Email: fallback image (MENU_IMAGE_URL) unavailable, sending without avatar:', err.message);
    }
  }
  return null;
}

let cachedHeader;
function getHeaderImage() {
  if (cachedHeader !== undefined) return cachedHeader;
  try {
    const filePath = path.isAbsolute(EMAIL_HEADER_IMAGE_PATH)
      ? EMAIL_HEADER_IMAGE_PATH
      : path.join(PROJECT_ROOT, EMAIL_HEADER_IMAGE_PATH);
    const buffer = fs.readFileSync(filePath);
    const type = sniffImageType(buffer);
    cachedHeader = type ? { buffer, ...type } : null;
    if (!type) console.error(`Email: header image ${filePath} is not a supported image — using the plain header.`);
  } catch (err) {
    // Remembered as "no header" until the next restart; the plain fallback
    // header is used meanwhile.
    console.error(`Email: header image not found (${err.message}) — using the plain header.`);
    cachedHeader = null;
  }
  return cachedHeader;
}

// Each sender takes the same input — the email's parts plus its inline images
// as { filename, buffer, mime, cid } — and resolves { id }. They throw an
// Error whose message never contains the API key, the password or the code.
async function sendWithResend({ to, subject, html, text, images }) {
  const attachments = images.map(img => ({
    filename: img.filename,
    content: img.buffer.toString('base64'),
    content_type: img.mime,
    content_id: img.cid,
  }));
  try {
    const response = await axios.post(
      RESEND_ENDPOINT,
      {
        from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
        to: [to],
        subject,
        html,
        text,
        ...(attachments.length ? { attachments } : {}),
      },
      {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: EMAIL_REQUEST_TIMEOUT_MS,
      }
    );
    return { id: response.data?.id || null };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.message || err.message;
    throw new Error(`Resend request failed${status ? ` (${status})` : ''}: ${detail}`);
  }
}

async function sendWithSmtp({ to, subject, html, text, images }) {
  let nodemailer;
  try {
    // Loaded here, not at the top of the file, so a bot that never uses SMTP
    // (or hasn't installed the package yet) is unaffected.
    nodemailer = require('nodemailer');
  } catch (err) {
    throw new Error('SMTP sending needs the "nodemailer" package — run: npm install nodemailer');
  }
  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: EMAIL_REQUEST_TIMEOUT_MS,
      greetingTimeout: EMAIL_REQUEST_TIMEOUT_MS,
      socketTimeout: EMAIL_REQUEST_TIMEOUT_MS,
    });
    const info = await transporter.sendMail({
      from: { name: EMAIL_FROM_NAME, address: EMAIL_FROM },
      to,
      subject,
      text,
      html,
      attachments: images.map(img => ({
        filename: img.filename,
        content: img.buffer,
        contentType: img.mime,
        cid: img.cid,
      })),
    });
    return { id: info?.messageId || null };
  } catch (err) {
    // nodemailer's messages can include the server's reply but never the
    // password; the code is never passed to anything that logs.
    throw new Error(`SMTP send failed${err.code ? ` (${err.code})` : ''}: ${err.message}`);
  }
}

// Sends one verification email. Resolves { id } on success and throws an
// Error (with a message that never contains credentials or the code) on any
// failure — callers decide what to tell the user.
async function sendVerificationEmail({ client, to, code, purpose }) {
  if (!isEmailConfigured()) throw new Error('email is not configured (see the email section of utils/config.js)');

  const [avatar, header] = await Promise.all([getAvatarImage(client), Promise.resolve(getHeaderImage())]);

  const { subject, html, text } = buildVerificationEmail({
    code,
    purpose,
    ttlMinutes: EMAIL_OTP_TTL_MINUTES,
    brandName: EMAIL_FROM_NAME,
    hasHeader: Boolean(header),
    hasAvatar: Boolean(avatar),
  });

  const images = [];
  if (header) images.push({ filename: `header.${header.ext}`, buffer: header.buffer, mime: header.mime, cid: CID_HEADER });
  if (avatar) images.push({ filename: `avatar.${avatar.ext}`, buffer: avatar.buffer, mime: avatar.mime, cid: CID_AVATAR });

  const send = EMAIL_PROVIDER === 'smtp' ? sendWithSmtp : sendWithResend;
  return send({ to, subject, html, text, images });
}

module.exports = {
  isEmailConfigured,
  normalizeEmail,
  maskEmail,
  isPrivateChat,
  emailForDisplay,
  sniffImageType,
  sendVerificationEmail,
};
