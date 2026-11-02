/**
 * 主流邮箱服务商参数预设。
 * 收信走 IMAP，发信走 SMTP，密码一律使用「授权码 / 客户端密码」，不是网页登录密码。
 */
export const PROVIDERS = {
  qq: {
    label: 'QQ 邮箱',
    domain: 'qq.com',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    hint: 'QQ邮箱网页版 → 设置 → 账号 → 「IMAP/SMTP服务」开启 → 生成授权码（16位）。',
  },
  '163': {
    label: '163 邮箱',
    domain: '163.com',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    hint: '163邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 新增授权密码。',
  },
  '126': {
    label: '126 邮箱',
    domain: '126.com',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    hint: '126邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 新增授权密码。',
  },
  '139': {
    label: '139 邮箱（中国移动）',
    domain: '139.com',
    imap: { host: 'imap.139.com', port: 993, secure: true },
    smtp: { host: 'smtp.139.com', port: 465, secure: true },
    hint: '139邮箱网页版 → 设置 → 账户与安全 → 邮箱协议设置开启 IMAP/SMTP → 生成客户端授权码。',
  },
  gmail: {
    label: 'Gmail',
    domain: 'gmail.com',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    hint: '需先在 Google 账号开启两步验证，再生成「应用专用密码」；且需要能直连 Google。',
  },
  custom: {
    label: '其他 / 自定义',
    domain: '',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    hint: '自行填写 IMAP / SMTP 服务器地址与端口。',
  },
};

export function providerList() {
  return Object.entries(PROVIDERS).map(([id, v]) => ({ id, ...v }));
}

export function resolveProvider(id) {
  return PROVIDERS[id] || PROVIDERS.custom;
}
