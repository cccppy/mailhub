import nodemailer from 'nodemailer';
// 深导入：nodemailer 6.x 的 package.json 没有 exports 字段，按路径引没问题。
// 用途见 buildRaw() 的注释。
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
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
 * 附件总量上限。
 *
 * 请求体是一整段 JSON，附件以 base64 传上来会膨胀 4/3；服务端 express.json
 * 的 body 上限是 25 MB，所以这里卡 16 MB，留足余量不撞上限。
 * 顺带一提：QQ/163/139 的 SMTP 对单封邮件本身也有 20~50 MB 的限制，
 * 卡在 16 MB 基本上不会出现「本地通过了、投递被退信」这种更难受的情况。
 */
const ATTACH_TOTAL_MAX = 16 * 1024 * 1024;

/**
 * 把前端传来的附件整理成 nodemailer 认识的形状。
 *
 * 前端只传 { filename, contentType, contentBase64 } 三个字段，不传本地路径 ——
 * 插件页面拿不到真实文件路径，也不该拿。content 统一在这里解成 Buffer。
 */
function mapAttachments(input) {
  if (!Array.isArray(input) || !input.length) return undefined;

  const out = [];
  let total = 0;
  for (const raw of input) {
    if (!raw) continue;
    const filename = String(raw.filename || '').trim();
    if (!filename) continue;

    let content;
    if (raw.contentBase64) content = Buffer.from(String(raw.contentBase64), 'base64');
    else if (raw.content) content = Buffer.from(String(raw.content), 'utf8');
    else continue;
    if (!content.length) continue;

    total += content.length;
    if (total > ATTACH_TOTAL_MAX) {
      const mb = Math.round(ATTACH_TOTAL_MAX / 1024 / 1024);
      throw new HttpError(413, `附件合计超过 ${mb} MB 了，请减掉几个大的，或者把文件放到网盘、正文里发链接。`);
    }

    out.push({ filename, content, contentType: raw.contentType || undefined });
  }
  return out.length ? out : undefined;
}

/**
 * 把邮件编译成原始 MIME，同时把 Message-ID 一并取出来。
 *
 * 为什么不用 `info.message`：SMTP 传输**不返回**它。翻一遍
 * node_modules/nodemailer/lib/smtp-transport/index.js，全程只设置了
 * `info.messageId`，`info.message` 一次都没赋值过。所以早先那句
 * `info.message ? info.message.toString() : null` 恒为 null，
 * 「发完存一份到已发送」其实一直是坏的，只是静默失败、没人发现。
 *
 * 现在改成自己编译一份：拿到的和真正发出去的是同一个 mail 对象，
 * Message-ID 也用同一个（编译出来之后回填到 mail.messageId，
 * sendMail 时会被写成同一个头），所以存档件跟收件人收到的那份是一致的。
 *
 * 附件是 Buffer，重复编译不会像流那样被消费掉，顺序上先编译后发送是安全的。
 */
async function buildRaw(mail) {
  const message = new MailComposer(mail).compile();
  const messageId = message.messageId();
  const buf = await message.build();
  return { raw: buf.toString('utf8'), messageId };
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
    attachments: mapAttachments(payload.attachments),
  };
  if (!mail.text && !mail.html) mail.text = '';

  const { raw, messageId } = await buildRaw(mail);
  // 回填，让真正发出去的那封也用这个 Message-ID，存档件才能跟它对上号
  mail.messageId = messageId;

  const info = await transporter.sendMail(mail);
  return {
    ok: true,
    messageId: info.messageId || messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    // 供 appendToSent 使用
    raw,
  };
}
