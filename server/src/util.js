export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 给任意 Promise 加超时，避免某个邮箱连接卡死拖垮整个聚合请求 */
export function withTimeout(promise, ms, label = '操作') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    }),
  ]);
}

export function toArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

/**
 * 把底层库抛出的英文错误翻译成用户能看懂的话。
 * IMAP/SMTP 的报错非常原始（getaddrinfo ENOTFOUND、Unsafe Login…），
 * 直接甩给用户等于没说。
 */
export function friendlyMessage(err) {
  const raw = String((err && err.message) || err || '').trim() || '服务器内部错误';
  const s = raw.toLowerCase();

  if (/enotfound|eai_again|getaddrinfo|dns/.test(s)) {
    return '解析不出邮箱服务器地址，请检查网络连接，或确认服务器地址填写正确';
  }
  if (/econnrefused/.test(s)) {
    return '邮箱服务器拒绝连接，请确认服务器地址与端口填写正确';
  }
  if (/eacces/.test(s)) {
    return '端口连接被系统拦截，请检查防火墙设置';
  }
  if (/etimedout|timeout|esocket|ehostunreach|enetunreach|econnreset|greeting/.test(s)) {
    return '连接邮箱服务器超时，可能是网络受限，或 993 / 465 端口被防火墙拦截';
  }
  if (/unsafe login/.test(s)) {
    return '邮箱服务器返回「Unsafe Login」，请确认已在邮箱后台正确开启 IMAP/SMTP 服务';
  }
  if (/authenticationfailed|invalid credentials|auth(entication)?\s*failed|535|login fail|bad password/.test(s)) {
    return '登录失败：请确认填的是邮箱后台生成的「授权码」（不是网页登录密码），并已开启 IMAP/SMTP 服务';
  }
  if (/self[- ]signed|unable to verify|certificate|altnames/.test(s)) {
    return '邮箱服务器证书校验失败，无法建立加密连接';
  }
  if (/too many|rate limit|exceed|frequent/.test(s)) {
    return '操作过于频繁，被邮箱服务器限流了，请稍后再试';
  }
  if (/mailbox.*not.*exist|no such mailbox|nonexistent/.test(s)) {
    return '该文件夹在邮箱服务器上不存在';
  }
  return raw;
}
