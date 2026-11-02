import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getAccount } from '../store.js';
import { decrypt } from '../crypto.js';
import { HttpError, withTimeout } from '../util.js';

/**
 * 网易系（163/126）要求客户端在登录后发送 IMAP ID 命令，否则会返回
 * "Unsafe Login" 拒绝访问。imapflow 会在服务端声明 ID 能力时自动发送。
 */
const CLIENT_INFO = { name: 'MailHub', version: '1.0.0', vendor: 'MailHub' };

export function resolveAccount(accountId) {
  const acct = getAccount(accountId);
  if (!acct) throw new HttpError(404, '账户不存在');
  return { ...acct, secret: decrypt(acct.secretEnc) };
}

export function clientFor(acct) {
  return new ImapFlow({
    host: acct.imap.host,
    port: acct.imap.port,
    secure: acct.imap.secure !== false,
    auth: { user: acct.user, pass: acct.secret },
    clientInfo: CLIENT_INFO,
    logger: false,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
}

async function withClient(acct, fn) {
  const client = clientFor(acct);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* 忽略 */
      }
    }
  }
}

function mapAddr(list) {
  return (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));
}

/**
 * 单张内嵌图的大小上限：再大就别塞进 JSON 了。
 * 详情是一次 JSON 往返，几十兆的 base64 会把页面卡死，所以宁可让那张图显示不出来。
 */
const INLINE_IMAGE_MAX = 2 * 1024 * 1024;
/** 一整封邮件里所有内嵌图的合计上限 */
const INLINE_TOTAL_MAX = 5 * 1024 * 1024;

/** 这个附件是不是「正文里引用的图」，而不是用户要下载的附件 */
export function isInlineImage(att) {
  if (!att || !att.contentId) return false;
  if (String(att.contentDisposition || '').toLowerCase() === 'attachment') return false;
  return /^image\//i.test(String(att.contentType || ''));
}

/**
 * 把正文里 `src="cid:xxx"` 用到的内嵌图整理成 Content-ID -> data: URL 的映射。
 *
 * 浏览器不认识 cid: 协议，原文照搬一定显示不出来。图本身就在邮件里，
 * 不需要联网，所以这里直接内联成 data: URL —— 既不涉及发件人追踪，也不会多发请求。
 */
export function collectInlineImages(attachments) {
  const map = {};
  let total = 0;
  for (const a of attachments || []) {
    if (!isInlineImage(a)) continue;
    const buf = a.content;
    if (!buf || !buf.length || buf.length > INLINE_IMAGE_MAX) continue;
    if (total + buf.length > INLINE_TOTAL_MAX) break;
    total += buf.length;

    // Content-ID 的标准写法带尖括号 <xx@yy>，但正文里引用时常常不带，
    // 两种键都登记一份，前端就不用猜该用哪种了
    const key = String(a.contentId).trim().replace(/^<|>$/g, '');
    if (!key) continue;
    const dataUrl = `data:${a.contentType};base64,${buf.toString('base64')}`;
    map[key] = dataUrl;
    map[`<${key}>`] = dataUrl;
  }
  return map;
}

function hasAttachment(node) {
  if (!node) return false;
  if (String(node.disposition || '').toLowerCase() === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachment);
  return false;
}

function mapListItem(msg) {
  const env = msg.envelope || {};
  const date = env.date || msg.internalDate;
  return {
    uid: msg.uid,
    seq: msg.seq,
    subject: env.subject || '(无主题)',
    from: mapAddr(env.from),
    to: mapAddr(env.to),
    date: date ? new Date(date).toISOString() : null,
    seen: Boolean(msg.flags && msg.flags.has('\\Seen')),
    flagged: Boolean(msg.flags && msg.flags.has('\\Flagged')),
    hasAttachment: hasAttachment(msg.bodyStructure),
    size: msg.size || 0,
  };
}

/** 测试账户连通性：能连上并列出文件夹即视为成功 */
export async function testConnection(acct) {
  return withTimeout(
    withClient(acct, async (client) => {
      const boxes = await client.list();
      return {
        ok: true,
        server: acct.imap.host,
        folderCount: boxes.length,
        folders: boxes.slice(0, 10).map((m) => m.path),
      };
    }),
    25000,
    '连接邮箱服务器',
  );
}

/** 列出文件夹，并附带未读数 */
export async function listFolders(acct) {
  return withClient(acct, async (client) => {
    const boxes = await client.list();
    const usable = boxes.filter((m) => !(m.flags && m.flags.has('\\Noselect')));
    const folders = await Promise.all(
      usable.map(async (m) => {
        let unseen = 0;
        let messages = 0;
        try {
          const st = await client.status(m.path, { unseen: true, messages: true });
          unseen = st.unseen || 0;
          messages = st.messages || 0;
        } catch {
          /* 个别文件夹不支持 STATUS，忽略 */
        }
        return {
          path: m.path,
          name: m.name || m.path,
          delimiter: m.delimiter || '/',
          specialUse: m.specialUse || null,
          unseen,
          messages,
        };
      }),
    );
    return { folders };
  });
}

/**
 * 拉取邮件列表。默认按时间倒序返回最新的 limit 封。
 * @param {object} opts { mailbox, limit, offset, unread, search }
 */
export async function listMessages(acct, opts = {}) {
  const mailbox = opts.mailbox || 'INBOX';
  const limit = Math.min(Number(opts.limit) || 30, 200);
  const offset = Number(opts.offset) || 0;

  return withClient(acct, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const total = client.mailbox.exists || 0;
      if (!total) return { total: 0, mailbox, messages: [] };

      let seqRange = null;
      if (opts.unread || opts.search) {
        const criteria = {};
        if (opts.unread) criteria.seen = false;
        if (opts.search) criteria.text = String(opts.search);
        const found = await client.search(criteria, { uid: false });
        if (!found || !found.length) return { total: 0, mailbox, messages: [] };
        const picked = found.slice(Math.max(0, found.length - offset - limit), found.length - offset);
        if (!picked.length) return { total: found.length, mailbox, messages: [] };
        seqRange = picked.join(',');
      } else {
        const end = Math.max(1, total - offset);
        const start = Math.max(1, end - limit + 1);
        seqRange = `${start}:${end}`;
      }

      const out = [];
      for await (const msg of client.fetch(
        seqRange,
        { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true },
        { uid: false },
      )) {
        out.push(mapListItem(msg));
      }
      out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      return { total, mailbox, messages: out };
    } finally {
      lock.release();
    }
  });
}

/** 读取单封邮件全文 */
export async function getMessage(acct, { mailbox = 'INBOX', uid }) {
  if (!uid) throw new HttpError(400, '缺少邮件 uid');
  return withClient(acct, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const res = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!res || !res.source) throw new HttpError(404, '邮件不存在或已被删除');
      const parsed = await simpleParser(res.source);
      return {
        uid: Number(uid),
        mailbox,
        subject: parsed.subject || '(无主题)',
        from: mapAddr(parsed.from ? (parsed.from.value || []) : []),
        to: mapAddr(parsed.to ? [].concat(parsed.to.value || []) : []),
        cc: mapAddr(parsed.cc ? [].concat(parsed.cc.value || []) : []),
        date: parsed.date ? new Date(parsed.date).toISOString() : null,
        messageId: parsed.messageId || null,
        inReplyTo: parsed.inReplyTo || null,
        references: [].concat(parsed.references || []),
        text: parsed.text || '',
        html: typeof parsed.html === 'string' ? parsed.html : '',
        seen: Boolean(res.flags && res.flags.has('\\Seen')),
        flagged: Boolean(res.flags && res.flags.has('\\Flagged')),
        // 正文里 cid: 引用的内嵌图：Content-ID -> data: URL。
        //
        // 现在这版 mailparser 解析时已经把 cid: 直接换成了 data:，通常这里是空对象；
        // 只有它没换掉（老版本、或将来改了行为）才需要兜这一层。
        // 之所以加这个判断，是因为同一张图在 html 里已经有一份 base64 了，
        // 再复制一份进 inlineImages 会让详情响应白白大一倍。
        inlineImages: /src\s*=\s*["']?cid:/i.test(parsed.html || '')
          ? collectInlineImages(parsed.attachments)
          : {},
        attachments: (parsed.attachments || []).map((a, i) => ({
          index: i,
          filename: a.filename || `附件${i + 1}`,
          size: a.size || 0,
          contentType: a.contentType || 'application/octet-stream',
          contentId: a.contentId || null,
          // 内嵌图是正文的一部分，不该出现在「附件」栏里让人下载
          inline: isInlineImage(a),
        })),
      };
    } finally {
      lock.release();
    }
  });
}

/** 下载某个附件（重新取一次原文，取出第 index 个附件） */
export async function getAttachment(acct, { mailbox = 'INBOX', uid, index }) {
  return withClient(acct, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const res = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!res || !res.source) throw new HttpError(404, '邮件不存在');
      const parsed = await simpleParser(res.source);
      const att = (parsed.attachments || [])[Number(index)];
      if (!att) throw new HttpError(404, '附件不存在');
      return {
        filename: att.filename || `attachment-${index}`,
        contentType: att.contentType || 'application/octet-stream',
        content: att.content,
      };
    } finally {
      lock.release();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 标记与删除                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把入参里的 uid 收敛成干净的整数数组。
 * 前端可能传单个值、数组、字符串数组，还可能重复，统一在这里抚平。
 */
function uidList(uids) {
  const arr = (Array.isArray(uids) ? uids : [uids])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(arr)].sort((a, b) => a - b);
}

/**
 * 批量改标记：一次 STORE 命令处理一整串 uid。
 *
 * 以前是逐封循环调 messageFlagsAdd，勾 30 封就是 30 个 IMAP 命令往返；
 * imapflow 支持直接传 uid 数组，服务端一次就能改完，快一个量级。
 * @param {object} opts { mailbox, uids, seen, flagged }
 */
export async function bulkSetFlags(acct, { mailbox = 'INBOX', uids, seen, flagged }) {
  const list = uidList(uids);
  if (!list.length) throw new HttpError(400, '缺少邮件 uid');

  return withClient(acct, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (seen === true) await client.messageFlagsAdd(list, ['\\Seen'], { uid: true });
      if (seen === false) await client.messageFlagsRemove(list, ['\\Seen'], { uid: true });
      if (flagged === true) await client.messageFlagsAdd(list, ['\\Flagged'], { uid: true });
      if (flagged === false) await client.messageFlagsRemove(list, ['\\Flagged'], { uid: true });
      return { ok: true, count: list.length };
    } finally {
      lock.release();
    }
  });
}

/** 单封改标记，保留给原来的接口用 */
export async function setFlags(acct, { mailbox = 'INBOX', uid, seen, flagged }) {
  if (!uid) throw new HttpError(400, '缺少邮件 uid');
  const r = await bulkSetFlags(acct, { mailbox, uids: [uid], seen, flagged });
  return { ok: true, count: r.count };
}

/**
 * 各家「已删除」文件夹的名字完全不一样，靠 \Trash 这个标准标记最稳，
 * 没有就按名字猜 —— 猜错顶多退回打标记，不会把邮件弄丢。
 */
const TRASH_NAME_HINTS = [
  /^trash$/i,
  /deleted/i,
  /已删除/,
  /垃圾桶/,
  /回收站/,
];

function pickTrashFolder(boxes) {
  const usable = boxes.filter((b) => !(b.flags && b.flags.has('\\Noselect')));
  return (
    usable.find((b) => b.specialUse === '\\Trash') ||
    usable.find((b) => TRASH_NAME_HINTS.some((re) => re.test(b.name || '') || re.test(b.path || ''))) ||
    null
  );
}

function sameFolder(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/** 本账户的「已删除」文件夹路径，找不到返回 null */
export async function findTrash(acct) {
  return withClient(acct, async (client) => {
    const boxes = await client.list();
    const trash = pickTrashFolder(boxes);
    return { folder: trash ? trash.path : null };
  });
}

/**
 * 删除邮件 —— 移到「已删除」文件夹，不是物理删除。
 *
 * 老实现调的是 imapflow 的 messageDelete()，那个方法内部是
 * 「打 \Deleted 标记 → 立刻 EXPUNGE」，等于当场把邮件从服务器上抹掉，
 * 网页版邮箱里也翻不出来。用户点的是「删除」，心里的预期是「进回收站还能捞回来」，
 * 所以改成 MOVE 到垃圾箱，和网页端的行为对齐。
 *
 * 三种情况：
 *   1. 有垃圾箱且当前不在垃圾箱 → MOVE 过去（可恢复）
 *   2. 当前就在垃圾箱里 → 这次才是真删（打标记 + EXPUNGE）
 *   3. 服务器上压根没有垃圾箱（极少数自建服务器）→ 只打 \Deleted 不 EXPUNGE，
 *      邮件在「标记为删除」的中间状态，别的客户端仍能看到，不会凭空消失
 *
 * @param {object} opts { mailbox, uids }
 * @returns {Promise<{ok:boolean, count:number, moved?:boolean, purged?:boolean, folder?:string, reason?:string}>}
 */
export async function trashMessages(acct, { mailbox = 'INBOX', uids }) {
  const list = uidList(uids);
  if (!list.length) throw new HttpError(400, '缺少邮件 uid');

  return withClient(acct, async (client) => {
    const boxes = await client.list();
    const trash = pickTrashFolder(boxes);

    // 情况 2：本来就在垃圾箱里，删除 = 清空
    if (trash && sameFolder(trash.path, mailbox)) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageDelete(list, { uid: true });
      } finally {
        lock.release();
      }
      return { ok: true, count: list.length, moved: false, purged: true, folder: trash.path };
    }

    // 情况 3：没有垃圾箱，只能打标记
    if (!trash) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageFlagsAdd(list, ['\\Deleted'], { uid: true });
      } finally {
        lock.release();
      }
      return {
        ok: true,
        count: list.length,
        moved: false,
        marked: true,
        reason: '这个邮箱没有「已删除」文件夹，只在服务器上打了删除标记',
      };
    }

    // 情况 1：搬到垃圾箱
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageMove(list, trash.path, { uid: true });
    } finally {
      lock.release();
    }
    return { ok: true, count: list.length, moved: true, folder: trash.path };
  });
}

/**
 * 真正清空（只用于「已在垃圾箱里」的场景）。
 * 单独留一个入口，方便以后做「清空垃圾箱」。
 */
export async function purgeMessages(acct, { mailbox = 'INBOX', uids }) {
  const list = uidList(uids);
  if (!list.length) throw new HttpError(400, '缺少邮件 uid');
  return withClient(acct, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageDelete(list, { uid: true });
      return { ok: true, count: list.length, purged: true };
    } finally {
      lock.release();
    }
  });
}

/** 把已发送邮件追加到「已发送」文件夹 */
export async function appendToSent(acct, { folder, raw }) {
  return withClient(acct, async (client) => {
    const boxes = await client.list();
    const preferred = folder || process.env.SENT_FOLDER;
    const sent =
      (preferred && boxes.find((b) => b.path === preferred)) ||
      boxes.find((b) => b.specialUse === '\\Sent') ||
      boxes.find((b) => /(^|[\/.])Sent([\/.]|$)/i.test(b.path)) ||
      boxes.find((b) => /已发送/.test(b.path));
    if (!sent) return { ok: false, reason: '未找到已发送文件夹' };
    await client.append(sent.path, raw, ['\\Seen']);
    return { ok: true, folder: sent.path };
  });
}

/** 汇总各账户收件箱未读数，用于插件角标 */
export async function unreadSummary() {
  const { rawAccounts } = await import('../store.js');
  const accounts = rawAccounts();
  const results = await Promise.allSettled(
    accounts.map(async (a) => {
      const acct = resolveAccount(a.id);
      const info = await withTimeout(
        withClient(acct, (client) => client.status('INBOX', { unseen: true, messages: true })),
        20000,
        '获取未读数',
      );
      return { accountId: a.id, label: a.label, color: a.color, unseen: info.unseen || 0, total: info.messages || 0 };
    }),
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { accountId: accounts[i].id, label: accounts[i].label, color: accounts[i].color, unseen: 0, error: String(r.reason && r.reason.message) },
  );
}
