/**
 * IMAP IDLE 长连接：新邮件实时推送。
 *
 * 跟 imap.js 里其它操作最大的不同是连接的生命周期。那边每个操作都是
 * 「连上 → 干活 → logout」的短连接，用完就扔；服务器主动推的东西不是对某个
 * 命令的应答，短连接根本收不到，所以这里每个账户必须维持一条**常驻**连接。
 *
 * 三个关键事实（都是 imapflow 1.7.8 的实际行为，不是猜的）：
 *
 *   1. 不要手动调 idle()。`idle()` 会一直挂着，**新邮件到达也不会返回**，源码注释
 *      写得很直白：得从外面再发一条命令才解得开。而 imapflow 默认在连接空闲
 *      autoIdleDelay 之后自动进入 IDLE，收信走 'exists' 事件就行。
 *
 *   2. 'error' 必须有人接。ImapFlow 是 EventEmitter，'error' 事件没有监听器会被
 *      Node 直接抛成未捕获异常，整个服务进程跟着崩。
 *
 *   3. imapflow 自己**不做重连**（官方文档原话：whenever a 'close' event occurs you
 *      must create a new connection yourself）。所以这里要自己退避重连。
 *
 * 另外，只有「插件页面正开着」时才有必要连：页面关了就全断掉，不白占邮箱服务器的
 * 连接数（QQ/163 对同账号的并发连接是有限制的）。角标那边本来就每 5 分钟拉一次，
 * 断掉不影响。
 */

import { rawAccounts } from '../store.js';
import { clientFor, resolveAccount, mapListItem } from './imap.js';
import { friendlyMessage } from '../util.js';

/** 重连退避：3s 起步，翻倍到 60s 封顶 */
const RECONNECT_MIN = 3000;
const RECONNECT_MAX = 60000;

/**
 * 每隔这么久主动断开并重新 IDLE 一次。
 * RFC 2177 建议客户端别把 IDLE 挂满 29 分钟，很多服务器会悄悄把超时连接切掉；
 * 8 分钟重来一次，代价只是一次 DONE + IDLE 往返，比「偶发断连」便宜得多。
 */
const MAX_IDLE_TIME = 8 * 60 * 1000;

/** 一次事件里最多拉多少封，防止首次同步或批量归档时一口气拉几百封标题 */
const MAX_BATCH = 20;

/** 心跳间隔：SSE 长时间没数据会被中间层掐掉，也顺便用来发现订阅方已经走了 */
const HEARTBEAT = 25000;

/** accountId -> watcher */
const watchers = new Map();
/** 订阅了推送的响应对象（SSE） */
const listeners = new Set();
let heartbeatTimer = null;

/* ------------------------------------------------------------------ */
/* 推送通道                                                            */
/* ------------------------------------------------------------------ */

function send(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(event, data) {
  for (const res of listeners) {
    if (!send(res, event, data)) listeners.delete(res);
  }
}

function broadcastStatus() {
  broadcast('status', { accounts: statusList() });
}

/** 给设置页/调试用的快照 */
export function statusList() {
  return [...watchers.values()].map((w) => ({
    accountId: w.accountId,
    label: w.label,
    state: w.state,
    error: w.error || '',
  }));
}

/**
 * 挂一个 SSE 订阅者。
 *
 * 第一个订阅者进来才真正开始连邮箱 —— 打开页面就连，最小化放着连，关掉就断。
 */
export function subscribe(res) {
  res.write('retry: 3000\n\n');
  send(res, 'status', { accounts: (listeners.size === 0 ? startAll() : statusList()) });

  listeners.add(res);

  const drop = () => {
    if (!listeners.delete(res)) return;
    if (listeners.size === 0) stopAll();
  };
  res.on('close', drop);
  res.on('error', drop);
}

/**
 * 进程退出前收尾：把常驻连接和订阅都断干净。
 *
 * 不这么做的话，注销/杀进程之后邮箱服务器那边会认为有僵尸连接占着，
 * 短时间内再连可能被拒（QQ 邮箱对此比较敏感）。
 */
export function stopIdle() {
  for (const res of listeners) {
    try {
      res.end();
    } catch {
      /* 已经断了 */
    }
  }
  listeners.clear();
  stopAll();
}

/* ------------------------------------------------------------------ */
/* 每个账户一条常驻连接                                                */
/* ------------------------------------------------------------------ */

function safeAccounts() {
  try {
    return rawAccounts() || [];
  } catch {
    return [];
  }
}

function startAll() {
  for (const a of safeAccounts()) watch(a.id);

  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    // 注释行（以冒号开头）是 SSE 的心跳，客户端会忽略
    for (const res of listeners) {
      try {
        res.write(': ping\n\n');
      } catch {
        listeners.delete(res);
      }
    }
    // 顺带对齐账户：用户可能在设置里加了或删了邮箱
    syncWatches();
  }, HEARTBEAT);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  return statusList();
}

function stopAll() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;

  for (const w of watchers.values()) {
    w.stopped = true;
    clearTimeout(w.timer);
    closeQuietly(w.client);
  }
  watchers.clear();
}

/** 账户增删之后对齐：新账户连上，删掉的断开 */
function syncWatches() {
  const ids = new Set(safeAccounts().map((a) => a.id));

  for (const [id, w] of watchers) {
    if (ids.has(id)) continue;
    w.stopped = true;
    clearTimeout(w.timer);
    closeQuietly(w.client);
    watchers.delete(id);
  }

  for (const id of ids) {
    if (!watchers.has(id)) watch(id);
  }
}

function closeQuietly(client) {
  if (!client) return;
  try {
    client.close();
  } catch {
    /* 已经断了 */
  }
}

function watch(accountId) {
  if (watchers.has(accountId)) return;

  const w = {
    accountId,
    label: '',
    state: 'pending',
    error: '',
    client: null,
    retry: 0,
    timer: null,
    busy: false,
    stopped: false,
  };
  watchers.set(accountId, w);
  connect(w);
}

async function connect(w) {
  if (w.stopped) return;

  let acct;
  try {
    acct = resolveAccount(w.accountId);
  } catch (err) {
    // 账户被删了或者授权码解不开，重连也没意义，等 syncWatches 把它清掉
    w.state = 'error';
    w.error = String((err && err.message) || err);
    broadcastStatus();
    return;
  }

  w.label = acct.label;
  w.state = 'connecting';
  w.error = '';
  broadcastStatus();

  const client = clientFor(acct, {
    maxIdleTime: MAX_IDLE_TIME,
    // 进 IDLE 快一点，用户感觉才像「实时」；默认值偏保守
    autoIdleDelay: 2000,
  });
  w.client = client;

  client.on('error', (err) => {
    // 只记录，不在这里重连：连接随后会触发 'close'，重连统一由那边做，避免重复排程
    w.error = friendlyMessage(err);
  });

  client.on('close', () => {
    if (w.client === client) w.client = null;
    if (w.stopped) return;
    w.state = 'error';
    w.error = w.error || '连接已断开';
    broadcastStatus();
    scheduleReconnect(w);
  });

  client.on('exists', (data) => {
    if (!data || data.path !== 'INBOX') return;
    pullNew(w, acct, client, data);
  });

  try {
    await client.connect();
    // 选中收件箱：只有 SELECTED 状态才会进 IDLE，也才有 'exists' 事件
    await client.mailboxOpen('INBOX');
    if (w.stopped) {
      closeQuietly(client);
      return;
    }
    w.state = 'live';
    w.error = '';
    w.retry = 0;
    broadcastStatus();
  } catch (err) {
    w.state = 'error';
    w.error = friendlyMessage(err);
    broadcastStatus();
    closeQuietly(client);
    scheduleReconnect(w);
  }
}

function scheduleReconnect(w) {
  if (w.stopped || w.timer) return;

  const delay = Math.min(RECONNECT_MIN * 2 ** w.retry, RECONNECT_MAX);
  w.retry += 1;

  w.timer = setTimeout(() => {
    w.timer = null;
    connect(w);
  }, delay);
  if (w.timer.unref) w.timer.unref();
}

/**
 * 拉取本次新增的邮件标题并广播出去。
 *
 * 用 prevCount / count 拿到「新增了几封」，只取这一段，不做全量重扫。
 */
async function pullNew(w, acct, client, data) {
  if (w.stopped || w.busy) return;

  const count = Number(data.count) || 0;
  const prevCount = Number(data.prevCount) || 0;
  if (count <= prevCount) return;

  w.busy = true;
  try {
    const from = Math.max(prevCount + 1, count - MAX_BATCH + 1);

    const msgs = [];
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch(
        `${from}:${count}`,
        { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true },
        { uid: false },
      )) {
        msgs.push(mapListItem(msg));
      }
    } finally {
      lock.release();
    }

    if (!msgs.length) return;
    msgs.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    broadcast('mail', {
      accountId: acct.id,
      accountLabel: acct.label,
      accountColor: acct.color,
      // 超过 MAX_BATCH 时这里会大于 messages.length，前端只拿来做提示文案
      count: count - prevCount,
      messages: msgs,
    });
  } catch (err) {
    w.error = friendlyMessage(err);
  } finally {
    w.busy = false;
  }
}
