import { api, isConfigured, tryAutoConnect, getConfig, APP_PAGE } from './lib/api.js';

const ALARM = 'mailhub-refresh-badge';
const APP_URL = chrome.runtime.getURL(APP_PAGE);
const TAB_KEY = 'mailhubAppTabId';

/**
 * 本地服务的启动通道。
 * 名字必须和 native/com.mailhub.launcher.json 里的 name 完全一致，
 * 也要和注册表里 HKCU\...\NativeMessagingHosts\ 下面的子键名一致。
 */
const NATIVE_HOST = 'com.mailhub.launcher';

/* ---------- 拉起本地服务 ---------- */

/** 健康检查：1.2 秒内没回应就当服务不在 */
async function serviceAlive() {
  const { serverUrl } = await getConfig();
  const base = String(serverUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`${base}/api/health`, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过 Native Messaging 让系统帮我们把服务拉起来。
 * 插件自己没法启动进程，这是浏览器给的唯一正规通道。
 * 没注册过（返回 forbidden / not found）时安静地失败，交给页面上的提示兜底。
 */
function launchNative() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || '无法连接本地启动器' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        port.disconnect();
      } catch {
        /* 已经断了 */
      }
      resolve(result);
    };

    port.onMessage.addListener((msg) => finish({ ok: Boolean(msg && msg.ok), detail: msg }));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish({ ok: false, error: (err && err.message) || '启动器已退出' });
    });

    // 宿主拿到消息就开始干活；它不等这条消息也会动手，发了只是让协议更完整
    try {
      port.postMessage({ cmd: 'start' });
    } catch {
      /* 宿主可能已经退出了，不影响后面轮询结果 */
    }

    setTimeout(() => finish({ ok: false, error: '等待启动器超时' }), 5000);
  });
}

/**
 * 确保服务可用：已经在跑就直接返回；不在就跑起来并等它就绪。
 * @param {{ wait?: number }} opts wait —— 最多等多久（毫秒）
 */
async function ensureService({ wait = 10000 } = {}) {
  if (await serviceAlive()) return true;

  const launched = await launchNative();
  if (!launched.ok) {
    console.warn('[MailHub] 自动拉起服务失败：', launched.error || launched.detail);
  }

  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (await serviceAlive()) return true;
  }
  return false;
}

/* ---------- 打开 / 聚焦统一收件箱 ---------- */

/**
 * 用 storage.session 记住上次打开的面板标签页，避免每次点击都新开一个。
 * 这样就不需要申请 "tabs" 权限去读浏览记录。
 */
async function openApp() {
  const { [TAB_KEY]: tabId } = await chrome.storage.session.get(TAB_KEY);

  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // 标签页已被关掉，往下走新建
    }
  }

  const created = await chrome.tabs.create({ url: APP_URL });
  await chrome.storage.session.set({ [TAB_KEY]: created.id });
}

chrome.action.onClicked.addListener(() => {
  // 点图标必须「立刻有反应」，所以先开页面；
  // 服务没起来的话，页面里的自动重连会等它，这里并行去把服务拉起来。
  openApp();
  ensureService();
});

/* ---------- 未读角标 ---------- */

/** 没配置过就先自动领令牌，省得用户去设置页手动填 */
async function ensureConnected() {
  if (await isConfigured()) return true;
  return Boolean(await tryAutoConnect());
}

async function updateBadge() {
  try {
    if (!(await ensureConnected())) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const data = await api.unread();
    const total = Number(data.unseen) || 0;
    await chrome.action.setBadgeText({ text: total > 0 ? (total > 99 ? '99+' : String(total)) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d1242f' });
  } catch {
    // 服务没开或网络不通时静默失败，不打扰用户
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
}

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) updateBadge();
});

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  // 装完插件就把服务拉起来，省得用户还得回去双击脚本
  ensureService().then(updateBadge);
  // 首次安装直接把收件箱打开，用户不用自己找入口
  if (details.reason === 'install') openApp();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureService().then(updateBadge);
});

// 设置页保存了新地址或令牌后立刻重算角标
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.serverUrl || changes.token)) updateBadge();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'open-app') {
    openApp().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'ensure-service') {
    ensureService().then((ok) => sendResponse({ ok }));
    return true;
  }
  return false;
});

// Service Worker 每次唤醒都校准一次
ensureAlarm();
ensureService().then(updateBadge);
