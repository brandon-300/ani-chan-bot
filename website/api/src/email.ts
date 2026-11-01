/**
 * The original AniChan Gmail SMTP presentation, reused by the website.
 * The approved HTML template is in ./emailTemplate.ts. Images are attached
 * inline with their original Content-IDs, not sent as standalone pictures.
 */
import nodemailer from 'nodemailer';
import { cfg } from './mongo';
import { buildVerificationEmail, CID_HEADER, CID_AVATAR } from './emailTemplate';

type Purpose = 'email_verification' | 'password_reset';
type InlineImage = {
  filename: string;
  content: Buffer;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  cid: string;
};
const HEADER_URL =
  'https://raw.githubusercontent.com/brandon-300/ani-chan-bot/main/assets/email/header.jpg';
let headerPromise: Promise<InlineImage | null> | null = null;

export function mailReady(): boolean {
  const e = cfg();
  const port = Number(e.SMTP_PORT || 465);
  return !!(e.OTP_SECRET && e.OTP_SECRET.length >= 32 &&
    e.SMTP_USER && e.SMTP_PASS &&
    (port === 465 || port === 587) && e.SMTP_HOST);
}
function imageMime(bytes: Buffer): InlineImage['contentType'] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
async function loadImage(urlString: string, cid: string, maxBytes = 256_000): Promise<InlineImage | null> {
  let url: URL;
  try { url = new URL(urlString); } catch { return null; }
  // Limit remote image hosts to GitHub's project asset and Cloudinary.
  if (url.protocol !== 'https:' || url.username || url.password ||
    !['raw.githubusercontent.com', 'res.cloudinary.com'].includes(url.hostname)) return null;
  try {
    const response = await fetch(url, { redirect:'error', signal:AbortSignal.timeout(7_000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > maxBytes) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 16 || bytes.length > maxBytes) return null;
    const contentType = imageMime(bytes);
    if (!contentType) return null;
    const ext = contentType.slice('image/'.length).replace('jpeg', 'jpg');
    return { filename: cid + '.' + ext, content: bytes, contentType, cid };
  } catch { return null; }
}
function originalBanner(): Promise<InlineImage | null> {
  if (!headerPromise) headerPromise = loadImage(HEADER_URL, CID_HEADER);
  return headerPromise;
}

export async function sendVerificationEmail(
  to: string, code: string, purpose: Purpose
): Promise<void> {
  if (!mailReady()) throw new Error('Email service not configured.');
  const e = cfg();
  const port = Number(e.SMTP_PORT || 465);
  const [header, avatar] = await Promise.all([
    originalBanner(),
    e.EMAIL_AVATAR_IMAGE_URL
      ? loadImage(e.EMAIL_AVATAR_IMAGE_URL, CID_AVATAR)
      : Promise.resolve(null),
  ]);
  const { subject, text, html } = buildVerificationEmail({
    code, purpose, ttlMinutes:10, brandName:e.EMAIL_FROM_NAME || 'AniChan',
    hasHeader:!!header, hasAvatar:!!avatar
  });
  const attachments = [header, avatar].filter((v): v is InlineImage => !!v);
  const transport = nodemailer.createTransport({
    host:e.SMTP_HOST!, port, secure:port === 465,
    requireTLS:port === 587,
    auth:{user:e.SMTP_USER!, pass:e.SMTP_PASS!},
    connectionTimeout:12000, greetingTimeout:12000, socketTimeout:15000,
    pool:false
  });
  try {
    await transport.sendMail({
      from:{name:e.EMAIL_FROM_NAME || 'AniChan', address:e.EMAIL_FROM || e.SMTP_USER!},
      to, subject, text, html, attachments
    });
  } finally {
    transport.close();
  }
}
