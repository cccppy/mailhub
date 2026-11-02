import {
  api,
  getConfig,
  setConfig,
  tryAutoConnect,
  APP_PAGE,
  DEFAULT_SERVER,
  connectHint,
  autoRetryConnect,
} from '../lib/api.js';

const $ = (id) => document.getElementById(id);

/** 连不上时的自动重试开关（取消函数） */
let stopRetry = null;

/** 服务端拿不到 provider 时的兜底列表，保证设置页永远可用 */
const FALLBACK_PROVIDERS = [
  { id: 'qq', label: 'QQ 邮箱', domain: 'qq.com', imap: { host: 'imap.qq.com', port: 993 }, smtp: { host: 'smtp.qq.com', port: 465 }, hint: 'QQ 邮箱网页版 → 设置 → 账号 → 开启「IMAP/SMTP 服务」→ 生成 16 位授权码。' },
  { id: '139', label: '139 邮箱', domain: '139.com', imap: { host: 'imap.139.com', port: 993 }, smtp: { host: 'smtp.139.com', port: 465 }, hint: '139 邮箱网页版 → 设置 → 账户与安全 → 邮箱协议设置 → 开启 IMAP/SMTP → 生成客户端授权码。' },
  { id: '163', label: '163 邮箱', domain: '163.com', imap: { host: 'imap.163.com', port: 993 }, smtp: { host: 'smtp.163.com', port: 465 }, hint: '163 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 新增授权密码。' },
  { id: '126', label: '126 邮箱', domain: '126.com', imap: { host: 'imap.126.com', port: 993 }, smtp: { host: 'smtp.126.com', port: 465 }, hint: '126 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP → 新增授权密码。' },
  { id: 'gmail', label: 'Gmail', domain: 'gmail.com', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 }, hint: '需先开启 Google 两步验证，再生成「应用专用密码」；且需要能直连 Google。' },
  { id: 'custom', label: '其他邮箱', domain: '', imap: { host: '', port: 993 }, smtp: { host: '', port: 465 }, hint: '展开下面的「自定义服务器参数」，自己填 IMAP / SMTP 地址和端口。' },
];

let providers = FALLBACK_PROVIDERS.slice();
let selectedId = 'qq';
let accounts = [];

/* ============================ 小工具 ============================ */

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text || '';
  el.className = `status ${kind}`;
}

/** 顶部状态条：ok / err / waiting */
function setBar(kind, text, showRetry = false) {
  const bar = $('conn-bar');
  bar.className = `conn-bar ${kind}`;
  $('conn-text').textContent = text;
  $('btn-reconnect').hidden = !showRetry;
}

function currentProvider() {
  return providers.find((p) => p.id === selectedId) || null;
}

/* ============================ 连接 ============================ */

async function tryConnect() {
  try {
    const data = await api.listAccounts();
    providers = data.providers && data.providers.length ? data.providers : providers;
    accounts = data.accounts || [];
    renderChips();
    renderAccounts();
    setBar(
      'ok',
      accounts.length ? `已连接 · 共 ${accounts.length} 个邮箱` : '已连接 · 还没有添加邮箱',
      false,
    );
    return true;
  } catch (err) {
    // 优先显示真实原因（例如 401、连接被拒），比笼统的「连不上」有用得多
    setBar('err', err && err.message ? err.message : connectHint(), true);
    renderChips();
    renderAccounts();
    return false;
  }
}

/** 没有令牌时先自动领取，再试一次连接 */
async function ensureConnected() {
  const cfg = await getConfig();
  if (!cfg.token) {
    const got = await tryAutoConnect(cfg.serverUrl || DEFAULT_SERVER);
    if (!got) {
      setBar('err', connectHint(), true);
      return false;
    }
  }
  return tryConnect();
}

/** 本机地址已在清单里预授权；其他地址需要运行时申请权限 */
function permissionPatternFor(serverUrl) {
  let origin;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    throw new Error('服务地址格式不对，应该像 http://127.0.0.1:8787 这样');
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return null;
  return `${origin}/*`;
}

/**
 * 注意：chrome.permissions.request 必须在用户点击的**同一个任务**里发起，
 * 前面一旦有 await 就会丢失手势、直接被浏览器拒绝。
 * 所以这里刻意不做 contains 预检，直接请求 —— 已授权时它会立刻返回 true，不弹窗。
 */
async function ensureHostPermission(serverUrl) {
  const pattern = permissionPatternFor(serverUrl);
  if (!pattern) return true;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error('没有获得访问该地址的权限，请再点一次并选择「允许」');
  return true;
}

/* ============================ 品牌选择 ============================ */

function shortLabel(p) {
  return p.id === '139' ? '139 邮箱' : p.label.replace('（中国移动）', '');
}

function renderChips() {
  const box = $('provider-chips');
  box.textContent = '';
  for (const p of providers) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${p.id === selectedId ? ' active' : ''}`;
    b.textContent = shortLabel(p);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', p.id === selectedId ? 'true' : 'false');
    b.addEventListener('click', () => {
      selectedId = p.id;
      renderChips();
      onProviderChange();
      $('email').focus();
    });
    box.appendChild(b);
  }
}

function onProviderChange() {
  const p = currentProvider();
  const isCustom = !p || p.id === 'custom';
  $('custom-box').hidden = !isCustom;

  if (p && !isCustom) {
    $('imapHost').value = p.imap?.host || '';
    $('imapPort').value = p.imap?.port || 993;
    $('smtpHost').value = p.smtp?.host || '';
    $('smtpPort').value = p.smtp?.port || 465;
  }

  const domain = p && p.domain ? p.domain : '';
  $('email').placeholder = domain ? `例如 12345678（会自动补 @${domain}）` : '例如 you@example.com';
  $('provider-hint').textContent = p ? p.hint || '' : '';
}

/* ============================ 表单 ============================ */

/** 把「只填了 @ 前面的部分」自动补成完整地址 */
function normalizeEmail(raw) {
  const v = String(raw || '').trim().replace(/\s+/g, '');
  if (!v) return '';
  if (v.includes('@')) return v;
  const p = currentProvider();
  return p && p.domain ? `${v}@${p.domain}` : v;
}

function collectPayload() {
  const p = currentProvider();
  const payload = {
    provider: p ? p.id : 'custom',
    email: normalizeEmail($('email').value),
    authCode: $('authCode').value.trim(),
    label: '',
    color: '',
  };
  if (!p || p.id === 'custom') {
    payload.imap = { host: $('imapHost').value.trim(), port: Number($('imapPort').value) || 993, secure: true };
    payload.smtp = { host: $('smtpHost').value.trim(), port: Number($('smtpPort').value) || 465, secure: true };
  }
  return payload;
}

function validate(payload) {
  if (!payload.email) return '先填一下邮箱地址';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    const p = currentProvider();
    return p && p.domain
      ? `邮箱地址看起来不完整，试试 ${payload.email}@${p.domain}`
      : '邮箱地址格式不对，要像 you@example.com 这样';
  }
  if (!payload.authCode) return '还差授权码 —— 在邮箱网页版后台生成一串再填进来';
  if (payload.imap && !payload.imap.host) return '请在「自定义服务器参数」里填 IMAP 服务器地址';
  if (payload.smtp && !payload.smtp.host) return '请在「自定义服务器参数」里填 SMTP 服务器地址';
  return null;
}

/* ============================ 添加 / 删除 ============================ */

async function addAccount() {
  const payload = collectPayload();
  const bad = validate(payload);
  if (bad) return setStatus('add-status', bad, 'err');

  const btn = $('btn-add');
  const isFirst = accounts.length === 0;
  btn.disabled = true;
  btn.textContent = '正在验证…';
  setStatus('add-status', '正在登录邮箱服务器，稍等十几秒…');

  try {
    if (!(await ensureConnected())) throw new Error(connectHint());

    await api.addAccount(payload);

    $('email').value = '';
    $('authCode').value = '';
    await tryConnect();
    setStatus('add-status', `已添加 ${payload.email}`, 'ok');
    toast('添加成功，正在收取邮件…', 'ok');

    // 第一个邮箱才自动打开收件箱，后面再加就不打扰了
    if (isFirst) {
      setTimeout(() => chrome.tabs.create({ url: chrome.runtime.getURL(APP_PAGE) }), 900);
    }
  } catch (err) {
    setStatus('add-status', err.message, 'err');
    if (/令牌|连不上|服务/.test(err.message)) setBar('err', err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并测试';
  }
}

function renderAccounts() {
  const ul = $('account-list');
  ul.textContent = '';
  $('accounts-empty').hidden = accounts.length > 0;

  for (const a of accounts) {
    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = a.color || '#2563eb';
    li.appendChild(dot);

    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.label || a.email;
    const addr = document.createElement('div');
    addr.className = 'addr';
    addr.textContent = a.email;
    who.append(name, addr);
    li.appendChild(who);

    const del = document.createElement('button');
    del.className = 'link';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (!confirm(`确定移除 ${a.label || a.email} 吗？\n\n本机保存的授权码会一起删掉，邮箱里的邮件不受影响。`)) return;
      try {
        await api.removeAccount(a.id);
        toast('已移除', 'ok');
        await tryConnect();
      } catch (err) {
        toast(`移除失败：${err.message}`, 'error');
      }
    });
    li.appendChild(del);

    ul.appendChild(li);
  }
}

/* ============================ 远程图片开关 ============================ */

/**
 * 全局「要不要放行远程图片」。
 *
 * 默认放行：没设置过就当 allow。老版本默认拦着，结果每封带图的邮件都是一排
 * 灰框，用户得自己去点开关 —— 那不是保护，那是添乱。想拦的人选一下即可。
 *
 * 和收件箱里那个按钮共用同一个键：两处改的是同一个事实，不会出现「设置页
 * 写着放行、打开邮件还是被拦住」这种自相矛盾。
 */
const IMAGE_MODE_KEY = 'imageMode';

async function loadImagePref() {
  let mode = 'allow';
  try {
    const got = await chrome.storage.local.get(IMAGE_MODE_KEY);
    if (String((got || {})[IMAGE_MODE_KEY] || '') === 'block') mode = 'block';
  } catch {
    mode = 'allow';
  }
  document.querySelectorAll('input[name="image-mode"]').forEach((el) => {
    el.checked = el.value === mode;
  });
}

function bindImagePref() {
  document.querySelectorAll('input[name="image-mode"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      const allow = el.value === 'allow';
      try {
        chrome.storage.local.set({ [IMAGE_MODE_KEY]: allow ? 'allow' : 'block' });
      } catch {
        /* 存不下只影响下次打开，本次仍按当前设置走 */
      }
      toast(allow ? '以后打开邮件直接显示图片' : '以后邮件图片默认先拦住', 'ok');
    });
  });
}

/* ============================ 高级设置 ============================ */

async function saveAdvanced() {
  const serverUrl = ($('serverUrl').value.trim() || DEFAULT_SERVER).replace(/\/+$/, '');
  const token = $('token').value.trim();

  try {
    await ensureHostPermission(serverUrl);
  } catch (err) {
    return setStatus('conn-status', err.message, 'err');
  }

  if (!token) {
    // 只给了地址没给令牌：自动去领一个
    const got = await tryAutoConnect(serverUrl);
    if (!got) return setStatus('conn-status', connectHint(), 'err');
    $('token').value = got.token;
  } else {
    await setConfig({ serverUrl, token });
  }

  setStatus('conn-status', '已保存', 'ok');
  await tryConnect();
}

/* ============================ 初始化 ============================ */

function bindEvents() {
  $('btn-add').addEventListener('click', addAccount);
  $('btn-open-app').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(APP_PAGE) });
  });
  $('btn-save').addEventListener('click', saveAdvanced);
  $('btn-reconnect').addEventListener('click', async () => {
    setBar('waiting', '正在重新连接…');
    const cfg = await getConfig();
    await tryAutoConnect(cfg.serverUrl || DEFAULT_SERVER);
    const ok = await tryConnect();
    if (ok) toast('连接成功', 'ok');
  });

  $('authCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAccount();
  });
  $('email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('authCode').focus();
  });
}

async function init() {
  bindEvents();
  bindImagePref();
  renderChips();
  onProviderChange();

  // 图片开关存在浏览器本地，不走服务端，所以先读它，连不上服务也照样能改
  await loadImagePref();

  const cfg = await getConfig();
  $('serverUrl').value = cfg.serverUrl || DEFAULT_SERVER;
  $('token').value = cfg.token || '';

  const ok = await ensureConnected();
  if (!ok) {
    // 先开了设置页、之后才启动服务：后台自动重试，连上就自己恢复
    setBar('err', `${connectHint()} 这里会在后台自动重试。`, true);
    if (!stopRetry) {
      stopRetry = autoRetryConnect(async () => {
        stopRetry = null;
        const back = await tryConnect();
        if (back && !accounts.length) $('email').focus();
      });
    }
    return;
  }

  // 把服务端的 provider 列表正式接管过来（顺序更贴合服务端）
  if (providers.length) renderChips();
  if (!accounts.length) $('email').focus();
}

init();
