import { Router } from 'express';
import crypto from 'node:crypto';
import { resolveProvider, providerList } from '../providers.js';
import { addAccount, getAccount, listAccounts, removeAccount, updateAccount, sanitize } from '../store.js';
import { encrypt } from '../crypto.js';
import { testConnection } from '../mail/imap.js';
import { asyncHandler, HttpError } from '../util.js';

const router = Router();

const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

function pickColor() {
  const used = new Set(listAccounts().map((a) => a.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[listAccounts().length % PALETTE.length];
}

/** 把前端提交的表单整理成可用的连接配置 */
function buildConfig(body = {}) {
  const providerId = body.provider || 'custom';
  const preset = resolveProvider(providerId);
  const email = String(body.email || '').trim();
  const secret = String(body.authCode || body.password || '').trim();

  if (!email) throw new HttpError(400, '邮箱地址不能为空');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, '邮箱地址格式不正确');
  if (!secret) throw new HttpError(400, '授权码不能为空（不是网页登录密码）');

  const imap = { ...preset.imap, ...(body.imap || {}) };
  const smtp = { ...preset.smtp, ...(body.smtp || {}) };
  if (!imap.host) throw new HttpError(400, 'IMAP 服务器地址不能为空');
  if (!smtp.host) throw new HttpError(400, 'SMTP 服务器地址不能为空');

  return {
    provider: providerId,
    email,
    user: String(body.user || email).trim(),
    secret,
    imap: { host: imap.host, port: Number(imap.port) || 993, secure: imap.secure !== false },
    smtp: { host: smtp.host, port: Number(smtp.port) || 465, secure: smtp.secure !== false },
  };
}

router.get('/', (req, res) => {
  res.json({ accounts: listAccounts(), providers: providerList(), palette: PALETTE });
});

// 只测试，不保存
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const cfg = buildConfig(req.body);
    const result = await testConnection(cfg);
    res.json(result);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const cfg = buildConfig(body);

    // 先验证能连上，再落盘，避免存一堆废账户
    const result = await testConnection(cfg);

    const acct = {
      id: crypto.randomUUID(),
      provider: cfg.provider,
      email: cfg.email,
      user: cfg.user,
      label: String(body.label || '').trim() || cfg.email,
      color: body.color || pickColor(),
      imap: cfg.imap,
      smtp: cfg.smtp,
      secretEnc: encrypt(cfg.secret),
      createdAt: new Date().toISOString(),
    };

    const saved = addAccount(acct);
    res.status(201).json({ account: saved, connection: result });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { label, color } = req.body || {};
    const patch = {};
    if (label != null) patch.label = String(label).trim() || undefined;
    if (color != null) patch.color = String(color);
    const updated = updateAccount(req.params.id, patch);
    if (!updated) throw new HttpError(404, '账户不存在');
    res.json({ account: updated });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!getAccount(req.params.id)) throw new HttpError(404, '账户不存在');
    removeAccount(req.params.id);
    res.json({ ok: true });
  }),
);

export default router;
