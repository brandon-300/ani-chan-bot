// utils/emailTemplate.js — builds the verification email (HTML + plain text).
//
// Pure functions only: no network, no database, no config reads. Everything
// the email needs is passed in, so the layout can be previewed or tested on
// its own. The layout follows the approved AniChan mockup: banner on top,
// handwritten-style title, the code on a pink brush-style panel, an expiry
// line, a pink notice box, signature, then a footer with the bot's avatar and
// feature icons and a dark purple legal strip.
//
// Images are referenced by Content-ID ("cid:…") and attached by
// utils/emailService.js, so nothing is fetched from the internet when the
// recipient opens the email.

const CID_HEADER = 'anichan-header';
const CID_AVATAR = 'anichan-avatar';

const SCRIPT_FONT = "'Segoe Script','Bradley Hand','Brush Script MT','Lucida Handwriting','Comic Sans MS',cursive";
const BODY_FONT = "'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const COPY = {
  email_verification: {
    subject: 'Your AniChan verification code',
    title: 'Your Verification Code',
    intro: 'You requested a verification code for your AniChan account.',
  },
  email_change_auth: {
    subject: 'Approve your AniChan email change',
    title: 'Approve Email Change',
    intro: 'Someone asked to change the email address on your AniChan account. To approve it, use this code.',
  },
  email_change: {
    subject: 'Verify your new AniChan email',
    title: 'Verify Your New Email',
    intro: 'You asked to use this address for your AniChan account.',
  },
  session_unlock: {
    subject: 'Unlock your AniChan session',
    title: 'Unlock Your Session',
    intro: 'Your AniChan session was locked after a long time without activity. Use this code to unlock it.',
  },
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function headerBlock({ hasHeader, brandName }) {
  if (hasHeader) {
    return `<img src="cid:${CID_HEADER}" width="600" alt="${escapeHtml(brandName)} — Your Anime Companion" style="display:block;width:100%;max-width:600px;height:auto;border:0;">`;
  }
  // Used when the banner image is missing from disk — still on-brand.
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#3b1f7a" style="background:linear-gradient(135deg,#3b1f7a 0%,#c0398f 100%);">
    <tr><td align="center" style="padding:42px 20px;">
      <div style="font-family:${SCRIPT_FONT};font-size:44px;font-weight:bold;color:#ffffff;">${escapeHtml(brandName)}</div>
      <div style="font-family:${SCRIPT_FONT};font-size:18px;color:#ffd6f3;margin-top:6px;">Your Anime Companion</div>
    </td></tr>
  </table>`;
}

function avatarCell({ hasAvatar }) {
  if (!hasAvatar) return '';
  return `<td width="96" align="center" valign="middle" style="padding:16px 12px 16px 20px;border-right:1px solid #cfc8ee;">
      <img src="cid:${CID_AVATAR}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border-radius:50%;border:2px solid #ffffff;">
    </td>`;
}

function featureCell(icon, label) {
  return `<td align="center" valign="middle" style="padding:16px 4px;font-family:${BODY_FONT};font-size:12px;color:#2b1a6b;">
      <div style="font-size:22px;line-height:26px;">${icon}</div>
      <div style="margin-top:4px;">${escapeHtml(label)}</div>
    </td>`;
}

function buildVerificationEmail({
  code,
  purpose = 'email_verification',
  ttlMinutes = 10,
  brandName = 'AniChan',
  hasHeader = false,
  hasAvatar = false,
}) {
  const copy = COPY[purpose] || COPY.email_verification;
  const safeCode = String(code).replace(/\D/g, '');
  const safeBrand = escapeHtml(brandName);
  const minutes = Number(ttlMinutes) || 10;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#e9e4f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e9e4f7">
<tr><td align="center" style="padding:24px 12px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fdfbff;border-radius:16px;overflow:hidden;">

    <tr><td style="padding:0;">${headerBlock({ hasHeader, brandName })}</td></tr>

    <tr><td style="padding:30px 40px 6px 40px;">
      <div style="font-family:${SCRIPT_FONT};font-size:34px;line-height:40px;font-weight:bold;color:#2b1a6b;">${escapeHtml(copy.title)}</div>
    </td></tr>

    <tr><td style="padding:10px 40px 0 40px;font-family:${BODY_FONT};font-size:16px;line-height:26px;color:#2b1a6b;">
      <p style="margin:0 0 12px 0;">Hi there,</p>
      <p style="margin:0 0 12px 0;">${escapeHtml(copy.intro)}</p>
      <p style="margin:0;">Here is your 6-digit code:</p>
    </td></tr>

    <tr><td align="center" style="padding:20px 40px 6px 40px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:420px;">
        <tr><td align="center" bgcolor="#ffc4ec" style="background:#ffc4ec;border-radius:18px 40px 20px 38px;padding:18px 20px;">
          <span style="font-family:${BODY_FONT};font-size:46px;line-height:52px;font-weight:bold;letter-spacing:14px;color:#3a1f7a;padding-left:14px;">${safeCode}</span>
        </td></tr>
      </table>
    </td></tr>

    <tr><td align="center" style="padding:14px 40px 18px 40px;font-family:${BODY_FONT};font-size:16px;color:#2b1a6b;">
      &#128338; This code will expire in <strong>${minutes} minutes</strong>.
    </td></tr>

    <tr><td style="padding:0 40px 22px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fdeaf8" style="background:#fdeaf8;border:1px solid #f7b6e6;border-radius:12px;">
        <tr>
          <td width="52" align="center" valign="middle" style="padding:16px 0 16px 16px;font-size:30px;line-height:30px;">&#9888;&#65039;</td>
          <td style="padding:16px 18px;font-family:${BODY_FONT};font-size:15px;line-height:23px;color:#2b1a6b;">
            If you didn&rsquo;t request this code, you can safely ignore this email. Your account is secure.
          </td>
        </tr>
      </table>
    </td></tr>

    <tr><td style="padding:0 40px 28px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="bottom" style="font-family:${BODY_FONT};font-size:15px;line-height:24px;color:#2b1a6b;">
            Best regards,<br>The ${safeBrand} Team
          </td>
          <td align="right" valign="bottom" style="font-family:${SCRIPT_FONT};font-size:20px;line-height:26px;font-weight:bold;color:#2b1a6b;">
            More Anime.<br>More Fun. &#9825;
          </td>
        </tr>
      </table>
    </td></tr>

    <tr><td bgcolor="#e8e5fa" style="background:#e8e5fa;padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${avatarCell({ hasAvatar })}
          ${featureCell('&#127918;', 'Games')}
          ${featureCell('&#127924;', 'Cards')}
          ${featureCell('&#10024;', 'AI Chat')}
          ${featureCell('&#128062;', 'Pets')}
          ${featureCell('&#128101;', 'And More!')}
        </tr>
      </table>
    </td></tr>

    <tr><td align="center" bgcolor="#2b1c5a" style="background:#2b1c5a;padding:18px 24px;font-family:${BODY_FONT};font-size:12px;line-height:19px;color:#cfc8ee;">
      This is an automated email from ${safeBrand}.<br>Please do not reply to this email.
      <div style="margin-top:10px;font-size:16px;color:#8f84c9;">&#9819;</div>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;

  const text = [
    copy.title,
    '',
    'Hi there,',
    '',
    copy.intro,
    '',
    `Your 6-digit code: ${safeCode}`,
    '',
    `This code will expire in ${minutes} minutes.`,
    '',
    "If you didn't request this code, you can safely ignore this email. Your account is secure.",
    '',
    'Best regards,',
    `The ${brandName} Team`,
    '',
    `This is an automated email from ${brandName}. Please do not reply to this email.`,
  ].join('\n');

  return { subject: copy.subject, html, text };
}

module.exports = {
  CID_HEADER,
  CID_AVATAR,
  buildVerificationEmail,
  escapeHtml,
};
