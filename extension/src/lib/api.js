/**
 * 与本地 MailHub 服务通信的唯一出口。
 * 所有请求都会带上 Bearer 令牌，并统一把后端的 { error } 转成异常。
 * 这里的路径必须与 server/src/routes/*.js 保持一致。
 */

export const DEFAULT_SERVER = 'http://127.0.0.1:8787';
export const APP_PAGE = 'src/app/app.html';
export const OPTIONS_PAGE = 'src/options/options.html';

/** 读取插件里保存的连接配置 */
export async function getConfig() {
  const { serverUrl, token } = await chrome.storage.local.get(['serverUrl', 'token']);
  return {
    serverUrl: (serverUrl || DEFAULT_SERVER).replace(/\/+$/, ''),
    token: token || '',
  };
}

export async function setConfig({ serverUrl, token }) {
  const patch = {};
  if (serverUrl !== undefined) patch.serverUrl = String(serverUrl).replace(/\/+$/, '');
  if (token !== undefined) patch.token = String(token).trim();
  await chrome.storage.local.set(patch);
}

export async function isConfigured() {
  const { serverUrl, token } = await getConfig();
  return Boolean(serverUrl && token);
}

/** 最近一次自动连接的失败原因，用于把「连不上」翻译成人能看懂的话 */
let lastConnectError = '';

export function getLastConnectError() {
  return lastConnectError;
}

export const SERVER_DOWN_HINT =
  '本地服务还没起来。正常情况下点一下 MailHub 图标就会自动启动它，稍等几秒即可；如果一直连不上，双击一次项目文件夹里的「启动邮箱助手.bat」（那会顺带把自动启动重新装好）。';

/** 带失败原因的提示：比干巴巴一句「连不上」好排查得多 */
export function connectHint() {
  return lastConnectError ? `${SERVER_DOWN_HINT}（具体原因：${lastConnectError}）` : SERVER_DOWN_HINT;
}

/**
 * 发一次 handshake，成功返回服务端给的 { token, serverUrl }，失败返回 null。
 *
 * withHeader=true 时会带一个自定义请求头，浏览器会先发 OPTIONS 预检。
 * 这一步专门用来兜住 Private Network Access（Chrome 对「插件页 → 本地服务」
 * 的额外限制）：带了自定义头，服务端才有机会在预检里回「允许访问本地网络」。
 */
async function pingHandshake(target, withHeader) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${target}/api/handshake`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: withHeader ? { 'X-MailHub-Client': 'extension' } : undefined,
    });
    if (!res.ok) {
      let msg = `服务返回 HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch {
        /* 非 JSON 响应，保留状态码 */
      }
      lastConnectError = msg;
      return null;
    }
    const data = await res.json();
    if (!data || !data.token) {
      lastConnectError = '服务没有返回访问令牌';
      return null;
    }
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      lastConnectError = '请求超过 5 秒没有响应';
    } else {
      // 典型就是 TypeError: Failed to fetch —— 说明请求根本没送达服务
      lastConnectError = (err && err.message) || '网络请求失败';
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一键连接：向本机服务领取访问令牌，用户完全不需要手动复制粘贴。
 *
 * 服务端只会把令牌发给「本机回环连接 + 插件来源」的请求，普通网页拿不到。
 * 领取成功后自动写进 storage，后续请求就带上了。
 *
 * 为了尽量一次成功，这里会把两个地址（127.0.0.1 / localhost）各试两遍：
 * 先发最简单的 GET，再发带自定义头的版本（触发预检，绕开本地网络限制）。
 */
export async function tryAutoConnect(serverUrl = DEFAULT_SERVER) {
  const primary = String(serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  const candidates = [primary, 'http://localhost:8787', DEFAULT_SERVER].filter(
    (v, i, arr) => v && arr.indexOf(v) === i,
  );

  lastConnectError = '';

  for (const target of candidates) {
    for (const withHeader of [false, true]) {
      const data = await pingHandshake(target, withHeader);
      if (data) {
        await setConfig({ serverUrl: data.serverUrl || target, token: data.token });
        lastConnectError = '';
        return data;
      }
    }
  }
  return null;
}

/**
 * 连不上时在后台悄悄重试：用户先开插件页、再双击启动脚本，
 * 这个顺序下页面会自己恢复，不需要手动刷新。
 * 返回一个取消函数。
 */
export function autoRetryConnect(onConnected, { times = 8, interval = 3000 } = {}) {
  let stopped = false;
  let left = times;

  const tick = async () => {
    if (stopped) return;
    if (await tryAutoConnect()) {
      stopped = true;
      onConnected();
      return;
    }
    left -= 1;
    if (left <= 0) return;
    setTimeout(tick, interval);
  };

  setTimeout(tick, interval);
  return () => {
    stopped = true;
  };
}

function netError(err) {
  if (err && err.name === 'AbortError') {
    return new Error('请求超时了。服务可能在忙（比如正在同步大邮件），再试一次就行。');
  }
  return new Error(SERVER_DOWN_HINT);
}

async function rawFetch(pathAndQuery, opts = {}) {
  const { serverUrl, token } = await getConfig();
  const { method = 'GET', body, timeout = 60000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(serverUrl + pathAndQuery, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw netError(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} path 形如 '/api/accounts'
 * @param {{ method?: string, body?: any, query?: Record<string, any>, timeout?: number }} opts
 */
export async function request(path, opts = {}) {
  const { query } = opts;
  let full = path;
  if (query) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
    }
    const qs = usp.toString();
    if (qs) full += (full.includes('?') ? '&' : '?') + qs;
  }

  const res = await rawFetch(full, opts);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data;
}

/* ---------------- 业务接口封装 ---------------- */

export const api = {
  health: () => request('/api/health', { timeout: 8000 }),

  /* 账户 */
  listAccounts: () => request('/api/accounts'),
  testAccount: (payload) => request('/api/accounts/test', { method: 'POST', body: payload, timeout: 45000 }),
  addAccount: (payload) => request('/api/accounts', { method: 'POST', body: payload, timeout: 60000 }),
  updateAccount: (id, patch) => request(`/api/accounts/${id}`, { method: 'PATCH', body: patch }),
  removeAccount: (id) => request(`/api/accounts/${id}`, { method: 'DELETE' }),

  /* 邮件 */
  folders: (accountId) => request('/api/messages/folders', { query: { accountId }, timeout: 60000 }),

  /** accountId 为空 => 各账户收件箱聚合（统一收件箱） */
  list: ({ accountId, mailbox = 'INBOX', limit = 40, offset = 0, unread = false, q = '' } = {}) =>
    request('/api/messages', {
      query: { accountId, mailbox, limit, offset, unread: unread ? 1 : '', q },
      timeout: 90000,
    }),

  detail: (accountId, uid, mailbox = 'INBOX') =>
    request('/api/messages/detail', { query: { accountId, mailbox, uid }, timeout: 60000 }),

  setFlags: (accountId, { mailbox = 'INBOX', uid, seen, flagged }) =>
    request('/api/messages/flags', { method: 'POST', body: { accountId, mailbox, uid, seen, flagged }, timeout: 45000 }),

  /**
   * 批量操作：一次性把整批邮件交给后端，后端按账户/文件夹分组各发一条命令。
   * @param {'read'|'unread'|'flag'|'unflag'|'trash'|'delete'} action
   * @param {Array<{accountId:string, mailbox:string, uid:number}>} items
   */
  bulk: (action, items) =>
    request('/api/messages/bulk', { method: 'POST', body: { action, items }, timeout: 180000 }),

  /** 删除（语义是移入「已删除」文件夹，可恢复） */
  remove: (accountId, uid, mailbox = 'INBOX') =>
    request('/api/messages', { method: 'DELETE', query: { accountId, mailbox, uid }, timeout: 60000 }),

  /** 永久删除，只用在「已经在垃圾箱里」的情况 */
  purge: (accountId, mailbox, uids) =>
    request('/api/messages/purge', { method: 'POST', body: { accountId, mailbox, uids }, timeout: 60000 }),

  send: (payload) => request('/api/send', { method: 'POST', body: payload, timeout: 120000 }),

  unread: () => request('/api/messages/unread', { timeout: 90000 }),
};

/** 下载附件：附件接口需要带令牌，所以走 fetch 取回 Blob，由页面用 <a download> 保存 */
export async function fetchAttachment(accountId, { mailbox = 'INBOX', uid, index }) {
  const qs = new URLSearchParams({
    accountId,
    mailbox,
    uid: String(uid),
    index: String(index),
  }).toString();

  const res = await rawFetch(`/api/messages/attachment?${qs}`, { timeout: 120000 });
  if (!res.ok) {
    let msg = `下载失败（HTTP ${res.status}）`;
    try {
      const j = JSON.parse(await res.text());
      if (j.error) msg = j.error;
    } catch {
      /* 忽略解析失败，用默认提示 */
    }
    throw new Error(msg);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  let filename = '';
  if (match) {
    try {
      filename = decodeURIComponent(match[1]);
    } catch {
      filename = match[1];
    }
  }
  return { blob: await res.blob(), filename };
}

/** 页面内保存 Blob 为文件（不依赖 downloads 权限） */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'attachment';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------------- 新邮件实时推送 ---------------- */

/**
 * 打开 /api/events 的推送通道（SSE）。
 *
 * 不用原生 EventSource，因为它不能带自定义请求头——令牌只能塞进 URL，
 * 而 URL 会被服务端的诊断日志原样记下来。这里改用 fetch 读流，自己拆 SSE 帧，
 * 令牌照旧走 Authorization 头。
 *
 * 返回 { close() }。断流后会自动重连，间隔从 3 秒翻倍到 30 秒封顶。
 *
 * @param {{
 *   onEvent?: (event: string, data: any) => void,
 *   onStatus?: (state: 'open' | 'closed') => void,
 * }} handlers
 */
export function openEventStream({ onEvent, onStatus } = {}) {
  let closed = false;
  let retryTimer = null;
  let retry = 0;
  let controller = null;

  function handleFrame(chunk) {
    let event = 'message';
    const data = [];

    for (const line of chunk.split('\n')) {
      // 空行和以冒号开头的注释（心跳）直接跳过
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }

    if (!data.length) return;
    let payload = null;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (onEvent) onEvent(event, payload);
  }

  async function run() {
    if (closed) return;

    const { serverUrl, token } = await getConfig();
    controller = new AbortController();

    try {
      const res = await fetch(`${serverUrl}/api/events`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      retry = 0;
      if (onStatus) onStatus('open');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        // 统一成 \n，省得为 \r\n 再写一套判断
        buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');

        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          handleFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
    } catch {
      /* 断流、服务没起来、页面正在关闭——都走下面的重连 */
    }

    if (closed) return;
    if (onStatus) onStatus('closed');

    const delay = Math.min(3000 * 2 ** retry, 30000);
    retry += 1;
    retryTimer = setTimeout(run, delay);
  }

  run();

  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      if (controller) controller.abort();
      if (onStatus) onStatus('closed');
    },
  };
}
