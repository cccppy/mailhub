import { Router } from 'express';
import { rawAccounts } from '../store.js';
import {
  resolveAccount,
  listFolders,
  listMessages,
  getMessage,
  getAttachment,
  setFlags,
  bulkSetFlags,
  trashMessages,
  purgeMessages,
  unreadSummary,
} from '../mail/imap.js';
import { asyncHandler, HttpError, friendlyMessage } from '../util.js';

const router = Router();

function tag(msg, acct) {
  return { ...msg, accountId: acct.id, accountLabel: acct.label, accountColor: acct.color };
}

router.get(
  '/folders',
  asyncHandler(async (req, res) => {
    const acct = resolveAccount(req.query.accountId);
    const { folders } = await listFolders(acct);
    res.json({ folders });
  }),
);

/**
 * 邮件列表。
 * 传 accountId => 单账户某文件夹；不传 => 全部账户收件箱聚合（统一收件箱）。
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { accountId, mailbox = 'INBOX' } = req.query;
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const offset = Number(req.query.offset) || 0;
    const unread = req.query.unread === '1' || req.query.unread === 'true';
    const search = req.query.q ? String(req.query.q).trim() : '';

    if (accountId) {
      const acct = resolveAccount(accountId);
      const r = await listMessages(acct, { mailbox, limit, offset, unread, search });
      return res.json({ ...r, messages: r.messages.map((m) => tag(m, acct)), errors: [] });
    }

    const accounts = rawAccounts();
    if (!accounts.length) return res.json({ messages: [], errors: [], mailbox: 'INBOX', total: 0 });

    const settled = await Promise.allSettled(
      accounts.map(async (a) => {
        const acct = resolveAccount(a.id);
        const r = await listMessages(acct, { mailbox: 'INBOX', limit, offset, unread, search });
        return r.messages.map((m) => tag(m, acct));
      }),
    );

    const messages = [];
    const errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') messages.push(...r.value);
      else {
        errors.push({
          accountId: accounts[i].id,
          label: accounts[i].label,
          error: String((r.reason && r.reason.message) || r.reason),
        });
      }
    });
    messages.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    res.json({ messages, errors, mailbox: 'INBOX', total: messages.length });
  }),
);

router.get(
  '/unread',
  asyncHandler(async (req, res) => {
    const summary = await unreadSummary();
    const unseen = summary.reduce((n, s) => n + (s.unseen || 0), 0);
    res.json({ accounts: summary, unseen });
  }),
);

router.get(
  '/attachment',
  asyncHandler(async (req, res) => {
    const acct = resolveAccount(req.query.accountId);
    const { mailbox = 'INBOX', uid, index = 0 } = req.query;
    const att = await getAttachment(acct, { mailbox, uid, index });
    res.setHeader('Content-Type', att.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
    );
    res.send(att.content);
  }),
);

router.post(
  '/flags',
  asyncHandler(async (req, res) => {
    const { accountId, mailbox = 'INBOX', uid } = req.body || {};
    const acct = resolveAccount(accountId);
    const r = await setFlags(acct, { mailbox, uid, seen: req.body.seen, flagged: req.body.flagged });
    res.json(r);
  }),
);

// 详情：GET /api/messages/detail?accountId=..&mailbox=INBOX&uid=123
router.get(
  '/detail',
  asyncHandler(async (req, res) => {
    const { mailbox = 'INBOX', uid } = req.query;
    const acct = resolveAccount(req.query.accountId);
    const msg = await getMessage(acct, { mailbox, uid });
    res.json({ message: { ...msg, accountId: acct.id, accountLabel: acct.label, accountColor: acct.color } });
  }),
);

/**
 * 批量操作。
 *
 * body: { action, items: [{ accountId, mailbox, uid }] }
 * action: read | unread | flag | unflag | trash | delete
 *
 * 设计要点：按「账户 + 文件夹」分组，每组只开一次 IMAP 连接、发一条
 * STORE / MOVE 命令。勾 40 封邮件不会变成 40 次 TCP 握手 —— 那是几十秒的事。
 */
const BULK_ACTIONS = new Set(['read', 'unread', 'flag', 'unflag', 'trash', 'delete']);

router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const { action } = req.body || {};
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];

    if (!BULK_ACTIONS.has(action)) throw new HttpError(400, `不认识的操作：${action || '(空)'}`);
    if (!items.length) throw new HttpError(400, '没有选中任何邮件');
    if (items.length > 500) throw new HttpError(400, '一次最多处理 500 封，请分批操作');

    const groups = new Map();
    for (const it of items) {
      if (!it || !it.accountId || !it.uid) continue;
      const mailbox = it.mailbox || 'INBOX';
      const key = `${it.accountId}\u0000${mailbox}`;
      if (!groups.has(key)) groups.set(key, { accountId: it.accountId, mailbox, uids: [] });
      groups.get(key).uids.push(it.uid);
    }

    const results = [];
    let done = 0;

    // 逐个分组串行执行：同一个账户并发开多个 IMAP 连接容易被服务器当成异常登录
    for (const g of groups.values()) {
      try {
        const acct = resolveAccount(g.accountId);
        let r;
        if (action === 'trash' || action === 'delete') {
          r = await trashMessages(acct, { mailbox: g.mailbox, uids: g.uids });
        } else {
          r = await bulkSetFlags(acct, {
            mailbox: g.mailbox,
            uids: g.uids,
            seen: action === 'read' ? true : action === 'unread' ? false : undefined,
            flagged: action === 'flag' ? true : action === 'unflag' ? false : undefined,
          });
        }
        done += Number(r.count) || g.uids.length;
        results.push({ accountId: g.accountId, mailbox: g.mailbox, ok: true, ...r });
      } catch (err) {
        results.push({
          accountId: g.accountId,
          mailbox: g.mailbox,
          ok: false,
          count: 0,
          error: friendlyMessage(err),
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    res.json({ ok: failed.length === 0, action, done, results });
  }),
);

// 单封删除（保留老接口，语义已改为「移入已删除」）
router.delete(
  '/',
  asyncHandler(async (req, res) => {
    const { accountId, mailbox = 'INBOX', uid } = req.query;
    if (!uid) throw new HttpError(400, '缺少邮件 uid');
    const acct = resolveAccount(accountId);
    const r = await trashMessages(acct, { mailbox, uids: [uid] });
    res.json(r);
  }),
);

// 永久删除：只给「已在垃圾箱里」的场景用
router.post(
  '/purge',
  asyncHandler(async (req, res) => {
    const { accountId, mailbox = 'INBOX', uids } = req.body || {};
    const acct = resolveAccount(accountId);
    const r = await purgeMessages(acct, { mailbox, uids });
    res.json(r);
  }),
);

export default router;
