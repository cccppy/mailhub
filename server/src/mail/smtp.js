import nodemailer from 'nodemailer';
import { HttpError } from '../util.js';

export function transporterFor(acct) {
  return nodemailer.createTransport({
    host: acct.smtp.host,
    port: acct.smtp.port,
    secure: acct.smtp.secure !== false,
    auth: { user: acct.user, pass: acct.secret },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });
}

function formatAddress(a) {
  if (!a) return '';
  if (typeof a === 'string') return a.trim();
  const email = (a.address || '').trim();
  const name = (a.name || '').trim();
  return name ? `"${name.replace(/"/g, '')}" <${email}>` : email;
}

function normalizeList(input) {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : String(input).split(/[,;，；]/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * 发信。from 强制等于账户地址——QQ/163/139 都会校验发件人必须与登录账号一致。
 * 返回 nodemailer 的 info，同时拿到原始 MIME 以便追加到「已发送」。
 */
export async function sendMail(acct, payload) {
  const to = normalizeList(payload.to);
  if (!to.length) throw new HttpError(400, '收件人不能为空');

  const transporter = transporterFor(acct);
  const fromName = payload.fromName || acct.label || '';
  const mail = {
    from: fromName ? `"${String(fromName).replace(/"/g, '')}" <${acct.email}>` : acct.email,
    to: to.map(formatAddress).join(', '),
    cc: normalizeList(payload.cc).map(formatAddress).join(', ') || undefined,
    bcc: normalizeList(payload.bcc).map(formatAddress).join(', ') || undefined,
    subject: payload.subject || '(无主题)',
    text: payload.text || undefined,
    html: payload.html || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    references: Array.isArray(payload.references) ? payload.references : payload.references || undefined,
  };
  if (!mail.text && !mail.html) mail.text = '';

  const info = await transporter.sendMail(mail);
  return {
    ok: true,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    // 供 appendToSent 使用
    raw: info.message ? info.message.toString() : null,
  };
}
