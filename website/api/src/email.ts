// Gmail SMTP transport for AniChan website verification and recovery.
// Compatible with the existing wweb.js environment variables.
// SMTP credentials are read only from encrypted Cloudflare environment bindings.
import nodemailer from 'nodemailer';
import { cfg } from './mongo';

export function mailReady(): boolean {
  const e=cfg();
  const port=Number(e.SMTP_PORT||465);
  return !!(e.OTP_SECRET && e.OTP_SECRET.length>=32 &&
    e.SMTP_USER && e.SMTP_PASS && e.EMAIL_FROM &&
    (port===465||port===587) && e.SMTP_HOST);
}
export async function sendMail(to: string,subject: string,text: string): Promise<void> {
  if(!mailReady()) throw new Error('Email service not configured.');
  const e=cfg(),port=Number(e.SMTP_PORT||465);
  // Secure TLS (465) or STARTTLS (587). No certificate-validation bypass.
  const transport=nodemailer.createTransport({
    host:e.SMTP_HOST!, port, secure:port===465,
    requireTLS:port===587,
    auth:{user:e.SMTP_USER!,pass:e.SMTP_PASS!},
    connectionTimeout:12000, greetingTimeout:12000, socketTimeout:15000,
    pool:false
  });
  try{
    await transport.sendMail({
      from:{name:e.EMAIL_FROM_NAME||'AniChan',address:e.EMAIL_FROM!},
      to,subject,text
    });
  }finally{transport.close();}
}
