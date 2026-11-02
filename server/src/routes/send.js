import { Router } from 'express';
import { resolveAccount, appendToSent } from '../mail/imap.js';
import { sendMail } from '../mail/smtp.js';
import { asyncHandler, HttpError } from '../util.js';

const router = Router();

router.post(
  '/send',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (!body.accountId) throw new HttpError(400, '请先选择发件账户');
    const acct = resolveAccount(body.accountId);

    const result = await sendMail(acct, body);

    // 发信成功后把副本写进「已发送」；失败不影响发信结果
    let sentCopy = { ok: false, reason: '未尝试' };
    if (result.raw) {
      try {
        sentCopy = await appendToSent(acct, { raw: result.raw, folder: body.sentFolder });
      } catch (err) {
        sentCopy = { ok: false, reason: String(err.message || err) };
      }
    }

    res.json({
      ok: true,
      messageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      sentCopy,
    });
  }),
);

export default router;
