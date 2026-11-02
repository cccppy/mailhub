import {
  api,
  getConfig,
  tryAutoConnect,
  autoRetryConnect,
  fetchAttachment,
  saveBlob,
  connectHint,
} from '../lib/api.js';
import { buildEmailDocument, countRemoteImages } from '../lib/sanitize.js';
import {
  formatSize,
  formatListDate,
  formatFullDate,
  formatAddresses,
  firstAddress,
  initialsOf,
  debounce,
} from '../lib/util.js';

const $ = (id) => document.getElementById(id);

/** 连不上时的自动重试开关（取消函数） */
let stopRetry = null;

const state = {
  accounts: [],
  folders: [],
  view: { accountId: null, mailbox: 'INBOX', unread: false, q: '' },
  messages: [],
  limit: 40,
  offset: 0,
  selectedKey: null,
  detail: null,
  /**
   * 是否放行远程图片。
   *
   * 默认 true：邮件打开就该是完整的图文，不该是一排灰框等用户去点。
   * 真值由 boot() 里的 loadImagePref() 从 chrome.storage.local 读回来，会被覆盖；
   * 这里给 true 只是保证万一读失败，也不会平白无故把图拦掉。
   */
  showImages: true,
  loading: false,
  unread: {}, // accountId -> unseen
  /** 已勾选邮件的 key（accountId|mailbox|uid），批量操作的依据 */
  picked: new Set(),
};

/* ============================ 工具 ============================ */

function avatarColor(seed) {
  const s = String(seed || '?');
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) % 100000;
  return `hsl(${hash % 360} 58% 45%)`;
}

function msgKey(m) {
  return `${m.accountId}|${m.mailbox || 'INBOX'}|${m.uid}`;
}

function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, 3600);
}

function accountById(id) {
  return state.accounts.find((a) => a.id === id) || null;
}

/** 焦点是不是在能打字的控件里（决定快捷键该不该让位） */
function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || '').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return false;
}

function setListStatus(text) {
  $('list-status').textContent = text || '';
}

/** 「还没有添加邮箱」的大引导卡片 */
function setListEmpty(show) {
  $('list-empty').hidden = !show;
  $('message-list').hidden = show;
  $('list-status').hidden = show;
  if (show) $('list-count').textContent = '';
}

/* ============================ 侧栏 ============================ */

function totalUnread() {
  return Object.values(state.unread).reduce((n, v) => n + (Number(v) || 0), 0);
}

function renderAccounts() {
  const ul = $('account-list');
  ul.textContent = '';

  // 统一收件箱
  ul.appendChild(
    navItem({
      label: '统一收件箱',
      sub: state.accounts.length ? `${state.accounts.length} 个账户合并` : '还没有添加账户',
      count: totalUnread(),
      active: state.view.accountId === null,
      onClick: () => selectAccount(null),
    }),
  );

  for (const acct of state.accounts) {
    ul.appendChild(
      navItem({
        label: acct.label,
        sub: acct.email,
        dot: acct.color,
        count: state.unread[acct.id],
        active: state.view.accountId === acct.id,
        onClick: () => selectAccount(acct.id),
      }),
    );
  }

  const pill = $('total-unread');
  const total = totalUnread();
  pill.hidden = total === 0;
  pill.textContent = String(total);
}

function navItem({ label, sub, dot, count, active, onClick }) {
  const li = document.createElement('li');
  if (active) li.classList.add('active');

  if (dot) {
    const d = document.createElement('span');
    d.className = 'dot';
    d.style.background = dot;
    li.appendChild(d);
  }

  const text = document.createElement('div');
  text.className = 'nav-label';
  const name = document.createElement('div');
  name.textContent = label;
  text.appendChild(name);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'nav-sub';
    s.textContent = sub;
    text.appendChild(s);
  }
  li.appendChild(text);

  if (count !== undefined && count !== null) {
    const c = document.createElement('span');
    const n = Number(count) || 0;
    c.className = `count${n === 0 ? ' zero' : ''}`;
    c.textContent = String(n);
    li.appendChild(c);
  }

  li.addEventListener('click', onClick);
  return li;
}

const FOLDER_ICON = {
  '\\Inbox': '📥',
  '\\Sent': '📤',
  '\\Drafts': '📝',
  '\\Trash': '🗑',
  '\\Junk': '🚫',
  '\\Archive': '📦',
};

function renderFolders() {
  const block = $('folder-block');
  const ul = $('folder-list');
  ul.textContent = '';

  if (!state.view.accountId) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  $('folder-account-name').textContent = accountById(state.view.accountId)?.label || '文件夹';

  if (!state.folders.length) {
    const li = document.createElement('li');
    li.className = 'dim small';
    li.textContent = '正在读取文件夹…';
    ul.appendChild(li);
    return;
  }

  for (const f of state.folders) {
    const li = document.createElement('li');
    if (f.path === state.view.mailbox) li.classList.add('active');

    const icon = document.createElement('span');
    icon.textContent = FOLDER_ICON[f.specialUse] || '📁';
    li.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'nav-label';
    name.textContent = f.name;
    li.appendChild(name);

    const c = document.createElement('span');
    const n = Number(f.unseen) || 0;
    c.className = `count${n === 0 ? ' zero' : ''}`;
    c.textContent = String(n);
    li.appendChild(c);

    li.addEventListener('click', () => {
      state.view.mailbox = f.path;
      $('list-title').textContent = `${accountById(state.view.accountId)?.label || ''} · ${f.name}`;
      renderFolders();
      loadList({ reset: true });
    });

    ul.appendChild(li);
  }
}

function selectAccount(accountId) {
  state.view.accountId = accountId;
  state.view.mailbox = 'INBOX';
  state.folders = [];
  $('list-title').textContent = accountId
    ? `${accountById(accountId)?.label || ''} · 收件箱`
    : '统一收件箱';
  renderAccounts();
  renderFolders();
  clearReader();
  loadList({ reset: true });
  if (accountId) loadFolders(accountId);
}

/* ============================ 数据加载 ============================ */

async function loadAccounts() {
  const data = await api.listAccounts();
  state.accounts = data.accounts || [];
  renderAccounts();
  renderComposeAccounts();
}

async function loadFolders(accountId) {
  try {
    const data = await api.folders(accountId);
    // 已经切到别的邮箱了，这份文件夹列表作废
    if (state.view.accountId !== accountId) return;
    state.folders = data.folders || [];
    renderFolders();
  } catch (err) {
    if (state.view.accountId !== accountId) return;
    state.folders = [];
    renderFolders();
    toast(`读取文件夹失败：${err.message}`, 'error');
  }
}

/**
 * 列表请求序号。
 *
 * 以前这里是一把「正在加载就 return」的布尔锁，结果是：QQ 那次请求还在飞的时候
 * 点 139，139 的请求被直接丢掉，界面就一直是 QQ 的邮件 —— 用户看到的就是
 * 「点了 139 却显示 QQ 的内容」。现在改成只认最后一次请求：每次进来序号 +1，
 * 回包时序号对不上就整份丢弃，绝不回填到已经切走的那个视图上。
 */
let listSeq = 0;

function setRefreshBusy(busy) {
  const top = $('btn-refresh');
  const mini = $('btn-list-refresh');
  const label = $('refresh-label');
  const ico = $('refresh-ico');
  if (top) {
    top.disabled = busy;
    top.classList.toggle('busy', busy);
  }
  if (label) label.textContent = busy ? '刷新中…' : '刷新';
  if (ico) ico.classList.toggle('spin', busy);
  if (mini) {
    mini.disabled = busy;
    mini.classList.toggle('spin', busy);
  }
}

/**
 * 取一页邮件。
 * @returns {Promise<'ok'|'stale'|'error'|'empty'>} stale 表示这次回包已经被更新的请求取代
 */
async function loadList({ reset = true, busyText = '正在收取邮件…' } = {}) {
  if (!state.accounts.length) {
    state.loading = false;
    state.messages = [];
    renderList();
    setListEmpty(true);
    setListStatus('');
    $('btn-more').hidden = true;
    setRefreshBusy(false);
    return 'empty';
  }

  const seq = ++listSeq;
  // 冻结这次请求要的参数：await 期间 state.view 可能被用户改掉
  const snap = { ...state.view };

  state.loading = true;
  setListEmpty(false);
  setRefreshBusy(true);
  $('btn-more').hidden = true;
  setListStatus(busyText);
  $('list-errors').hidden = true;

  if (reset) {
    state.offset = 0;
    state.messages = [];
    // 换了一批邮件，之前的勾选就没有意义了，一并清掉
    state.picked.clear();
    lastPickKey = null;
    // 关键：立刻重绘，旧账户的邮件马上从屏幕上消失，换成骨架占位。
    // 否则在等待新账户回包的几秒里，用户看到的还是上一个邮箱的内容。
    renderList();
  }

  try {
    const data = await api.list({
      accountId: snap.accountId,
      mailbox: snap.mailbox,
      limit: state.limit,
      offset: state.offset,
      unread: snap.unread,
      q: snap.q,
    });

    if (seq !== listSeq) return 'stale';

    const incoming = data.messages || [];
    state.messages = reset ? incoming : state.messages.concat(incoming);
    state.loading = false;
    renderList();
    renderErrors(data.errors || []);

    if (incoming.length >= state.limit) {
      $('btn-more').hidden = false;
    }
    setListStatus(state.messages.length ? '' : '这里没有邮件');
    refreshUnread();
    return 'ok';
  } catch (err) {
    if (seq !== listSeq) return 'stale';
    state.loading = false;
    renderList();
    setListStatus('');
    renderErrors([{ label: '请求失败', error: err.message }]);
    return 'error';
  } finally {
    if (seq === listSeq) {
      state.loading = false;
      setRefreshBusy(false);
    }
  }
}

/** 顶部刷新按钮 / 列表头刷新按钮 / F5 都走这里，给出明确反馈 */
async function refreshNow() {
  const r = await loadList({ reset: true, busyText: '正在刷新…' });
  if (r === 'stale') return;
  if (r === 'ok') {
    toast(`已刷新 · ${state.messages.length} 封`, 'ok');
    if (state.view.accountId) loadFolders(state.view.accountId);
    else refreshUnread();
  } else if (r === 'error') {
    toast('刷新失败，看列表顶部的红色提示', 'error');
  }
}

async function refreshUnread() {
  try {
    const data = await api.unread();
    const map = {};
    for (const a of data.accounts || []) map[a.accountId] = a.unseen || 0;
    state.unread = map;
    renderAccounts();
    // 同步文件夹未读数
    if (state.view.accountId && state.folders.length) {
      const inboxUnread = map[state.view.accountId] || 0;
      state.folders = state.folders.map((f) =>
        f.specialUse === '\\Inbox' || f.path === 'INBOX' ? { ...f, unseen: inboxUnread } : f,
      );
      renderFolders();
    }
  } catch {
    /* 角标失败不影响主流程 */
  }
}

/* ============================ 列表渲染 ============================ */

function renderErrors(errors) {
  const box = $('list-errors');
  box.textContent = '';
  if (!errors.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const e of errors) {
    const div = document.createElement('div');
    div.textContent = `${e.label || '某个账户'}：${e.error}`;
    box.appendChild(div);
  }
}

/** 加载中的骨架行，代替一片空白，让用户知道「在换、不是坏了」 */
function skeletonRow() {
  const li = document.createElement('li');
  li.className = 'skeleton';
  const a = document.createElement('span');
  a.className = 'sk-line w35';
  const b = document.createElement('span');
  b.className = 'sk-line w80';
  li.appendChild(a);
  li.appendChild(b);
  return li;
}

function renderList() {
  const ul = $('message-list');
  ul.textContent = '';

  // 只有在「当前没有任何邮件可显示」时才铺骨架：切账户、首次加载会走这里；
  // 翻页、后台刷新、加星标这些已有列表的场景照常显示原内容。
  if (state.loading && !state.messages.length) {
    for (let i = 0; i < 6; i += 1) ul.appendChild(skeletonRow());
    ul.classList.remove('has-pick');
    $('list-count').textContent = '';
    syncPickUI();
    return;
  }

  $('list-count').textContent = state.messages.length ? `${state.messages.length} 封` : '';

  for (const m of state.messages) {
    const li = document.createElement('li');
    const key = msgKey(m);
    if (!m.seen) li.classList.add('unread');
    if (key === state.selectedKey) li.classList.add('active');
    if (state.picked.has(key)) li.classList.add('picked');

    // 勾选框：默认藏着，鼠标移到行上才浮出来（样式在 CSS 里控制），
    // 位置正好压在未读圆点上，不多占一点内容宽度。
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pick';
    box.checked = state.picked.has(key);
    box.title = '勾选后可批量操作';
    box.addEventListener('click', (e) => {
      e.stopPropagation(); // 别让勾选顺带把邮件打开
      onPickClick(m, e);
    });
    li.appendChild(box);

    const row1 = document.createElement('div');
    row1.className = 'row-1';

    const stripe = document.createElement('span');
    stripe.className = 'acct-stripe';
    stripe.style.background = m.accountColor || '#c9d1d9';
    stripe.title = m.accountLabel || '';
    row1.appendChild(stripe);

    const from = document.createElement('span');
    from.className = 'from';
    const f = firstAddress(m.from);
    from.textContent = f.name || f.address || '(未知发件人)';
    row1.appendChild(from);
    li.appendChild(row1);

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatListDate(m.date);
    li.appendChild(date);

    const subject = document.createElement('div');
    subject.className = 'subject';
    subject.textContent = m.subject || '(无主题)';
    li.appendChild(subject);

    const flags = document.createElement('div');
    flags.className = 'flags';
    if (m.flagged) {
      const s = document.createElement('span');
      s.className = 'flag-star';
      s.textContent = '★';
      flags.appendChild(s);
    }
    if (m.hasAttachment) {
      const a = document.createElement('span');
      a.className = 'flag-attach';
      a.textContent = '📎';
      flags.appendChild(a);
    }
    li.appendChild(flags);

    li.addEventListener('click', () => openMessage(m));
    ul.appendChild(li);
  }

  syncPickUI();
}

/* ============================ 多选与批量操作 ============================ */

/** 上一次点过的行，用来支撑 Shift 连选 */
let lastPickKey = null;

const BULK_LABEL = {
  read: '已标为已读',
  unread: '已标为未读',
  flag: '已加星标',
  unflag: '已取消星标',
  trash: '已删除',
  delete: '已永久删除',
};

/** 把已勾选的 key 还原成邮件对象（按列表顺序） */
function pickedMessages() {
  return state.messages.filter((m) => state.picked.has(msgKey(m)));
}

/** 让全选框、批量条、「已选 N 封」跟 state.picked 保持一致 */
function syncPickUI() {
  const n = state.picked.size;
  const total = state.messages.length;

  const bar = $('bulk-bar');
  if (bar) bar.hidden = n === 0;
  if ($('bulk-count')) $('bulk-count').textContent = `已选 ${n} 封`;

  const ul = $('message-list');
  if (ul) ul.classList.toggle('has-pick', n > 0);

  const all = $('pick-all');
  if (all) {
    all.disabled = total === 0;
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
  }
}

/** 清空选择（切账户、刷新列表、操作完成后都走这里） */
function clearPick() {
  state.picked.clear();
  lastPickKey = null;
  renderList();
}

/**
 * 点一行里的勾选框。
 * 按住 Shift 时按「上一次点的行 → 这一行」的范围整段勾上/取消，
 * 处理几十封邮件时不用一个个点。
 */
function onPickClick(m, e) {
  const key = msgKey(m);
  const checked = e.target.checked;

  if (e.shiftKey && lastPickKey && lastPickKey !== key) {
    const keys = state.messages.map(msgKey);
    const a = keys.indexOf(lastPickKey);
    const b = keys.indexOf(key);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i += 1) {
        if (checked) state.picked.add(keys[i]);
        else state.picked.delete(keys[i]);
      }
      lastPickKey = key;
      renderList();
      return;
    }
  }

  if (checked) state.picked.add(key);
  else state.picked.delete(key);
  lastPickKey = key;
  renderList();
}

function togglePickAll(checked) {
  state.picked.clear();
  if (checked) for (const m of state.messages) state.picked.add(msgKey(m));
  lastPickKey = null;
  renderList();
}

/** 当前所在文件夹是不是「已删除」——在里面点删除才是真删，文案得说清楚 */
function inTrashFolder() {
  const f = state.folders.find((x) => x.path === state.view.mailbox);
  if (f && f.specialUse === '\\Trash') return true;
  return /trash|deleted|已删除|垃圾桶|回收站/i.test(state.view.mailbox || '');
}

/** 批量条上的按钮在跑请求期间禁用，避免连点 */
function setBulkBusy(busy) {
  for (const b of document.querySelectorAll('#bulk-bar button')) b.disabled = busy;
}

/**
 * 执行批量操作。
 * 一次请求把整批交给后端，后端按账户分组各发一条 IMAP 命令，
 * 所以勾 40 封也只是两三次往返，不会一封一封地磨。
 */
async function runBulk(action) {
  const items = pickedMessages();
  if (!items.length) {
    toast('先在列表里勾几封邮件', 'error');
    return;
  }

  const n = items.length;
  const purging = action === 'trash' && inTrashFolder();

  if (action === 'trash') {
    const msg = purging
      ? `这 ${n} 封已经在「已删除」里了，彻底删除后无法恢复。\n\n继续吗？`
      : `把选中的 ${n} 封邮件移到「已删除」文件夹？\n\n移过去之后还能从「已删除」里找回来。`;
    if (!confirm(msg)) return;
  }

  const payload = items.map((m) => ({
    accountId: m.accountId,
    mailbox: m.mailbox || 'INBOX',
    uid: m.uid,
  }));

  setBulkBusy(true);
  try {
    const data = await api.bulk(action, payload);
    const failed = (data.results || []).filter((r) => !r.ok);
    const okCount = Number(data.done) || (failed.length ? 0 : n);

    applyBulkLocally(action, items);

    if (failed.length) {
      toast(`部分失败：${failed.map((f) => f.error).join('；')}`, 'error');
    } else {
      const moved = (data.results || []).find((r) => r.moved);
      const marked = (data.results || []).find((r) => r.marked);
      let text = `${BULK_LABEL[action] || '已完成'} · ${okCount} 封`;
      if (action === 'trash') {
        if (purging) text = `已彻底删除 ${okCount} 封`;
        else if (marked) text = `已在服务器上标记删除 ${okCount} 封（这个邮箱没有「已删除」文件夹）`;
        else if (moved) text = `已移入「${moved.folder}」· ${okCount} 封`;
      }
      toast(text, 'ok');
    }

    clearPick();
    refreshUnread();
  } catch (err) {
    toast(`操作失败：${err.message}`, 'error');
  } finally {
    setBulkBusy(false);
  }
}

/** 请求成功后只改本地数据，不再整表重拉——省掉一轮几秒的 IMAP 往返 */
function applyBulkLocally(action, items) {
  const keys = new Set(items.map(msgKey));

  if (action === 'read' || action === 'unread') {
    const seen = action === 'read';
    for (const m of state.messages) {
      if (keys.has(msgKey(m))) m.seen = seen;
    }
    return;
  }

  if (action === 'flag' || action === 'unflag') {
    const flagged = action === 'flag';
    for (const m of state.messages) {
      if (keys.has(msgKey(m))) m.flagged = flagged;
    }
    return;
  }

  // 删除：从列表里拿掉，阅读区如果正开着被删的那封就一起收起来
  state.messages = state.messages.filter((m) => !keys.has(msgKey(m)));
  if (keys.has(state.selectedKey)) {
    state.selectedKey = null;
    clearReader();
  }
}

/* ============================ 阅读 ============================ */

/**
 * 正文 iframe 的渲染：现在是一条直路，没有兜底，也不需要兜底。
 *
 * 原来这里有个 2.2 秒的看门狗：srcdoc 写进去 2.2 秒还没等到 load，就把纯文本铺在
 * 阅读区上、把 iframe 藏起来。初衷是「无论渲染层出什么岔子，用户都不会对着白板发呆」。
 *
 * 但 1.1.5 放开远程图片之后它就出事了：srcdoc iframe 的 load 事件要等**所有子资源**
 * 加载完才触发，一封营销邮件里几十张外部图，只要有一张慢、被墙、或者图床挂死，
 * load 就迟迟不来；2.2 秒的定时器反而先到，把已经渲染好的正文整个藏起来 ——
 * 于是一封本来能看的邮件又变成一片空白。兜底兜出了新 bug。
 *
 * 而且它的判据本身就站不住：定时器到点只能说明「图还没加载完」，可图还没加载完
 * 恰恰是最正常的情况，和「渲染失败」根本不是一回事。1.1.2 那个白板的真正根因是
 * iframe 高度层层继承失败，早已由 #r-frame 的绝对定位（inset: 0）根治，
 * 不需要再拿定时器兜着。
 *
 * 所以连纯文本兜底层一起拆了：定时器、showFallback()、stripTags()、那段 DOM 和样式，
 * 全都不留。留着一段永远不会执行的「兜底」比没有更糟 —— 下一个看代码的人会以为白板
 * 还有第二道保险，实际上并没有。
 *
 * 正文真出了状况，顶栏和列表头都有「刷新」，点一次会重新拉取并重绘。
 *
 * 下面这两件事就是阅读区渲染的全部：写 srcdoc、清空 srcdoc。
 */
function paintFrame(html) {
  $('r-frame').srcdoc = html;
}

function clearReader() {
  state.selectedKey = null;
  state.detail = null;
  $('reader').hidden = true;
  $('read-empty').hidden = false;
  $('r-frame').srcdoc = '';
}

/** 详情也有竞态：连点两封时，先发的那封可能后回来，把新的盖掉 */
let detailSeq = 0;

async function openMessage(item) {
  const seq = ++detailSeq;

  state.selectedKey = msgKey(item);
  renderList();

  $('read-empty').hidden = true;
  $('reader').hidden = false;

  // 先用列表里的信息把头部填上，读正文是异步的
  paintReaderHeader(item, null);
  // 正文还没到，先别让上一封的「显示图片」按钮留在那儿误导人
  $('r-images').hidden = true;
  paintFrame('<!doctype html><html><body style="font:13px sans-serif;color:#8b949e;padding:20px">正在读取正文…</body></html>');

  try {
    const data = await api.detail(item.accountId, item.uid, item.mailbox || 'INBOX');
    if (seq !== detailSeq) return; // 用户已经点了别的邮件
    state.detail = data.message;
    paintReaderHeader(state.detail, data.message);
    paintReaderBody();
  } catch (err) {
    if (seq !== detailSeq) return;
    state.detail = null;
    paintFrame(
      `<!doctype html><html><body style="font:13px sans-serif;color:#b3261e;padding:20px">读取失败：${escapeForFrame(err.message)}</body></html>`,
    );
    return;
  }

  if (!item.seen) {
    item.seen = true;
    renderList();
    api
      .setFlags(item.accountId, { mailbox: item.mailbox || 'INBOX', uid: item.uid, seen: true })
      .then(() => {
        state.unread[item.accountId] = Math.max(0, (state.unread[item.accountId] || 0) - 1);
        renderAccounts();
      })
      .catch(() => {});
  }
}

function escapeForFrame(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function paintReaderHeader(item, detail) {
  $('r-subject').textContent = item.subject || '(无主题)';

  const from = firstAddress(item.from);
  $('r-from').textContent = from.name ? `${from.name} <${from.address}>` : from.address || '(未知发件人)';

  const av = $('r-avatar');
  av.textContent = initialsOf(from);
  av.style.background = avatarColor(from.address || from.name || '?');

  $('r-date').textContent = formatFullDate(item.date);

  const toLine = $('r-to');
  if (detail) {
    const parts = [`收件人：${formatAddresses(detail.to)}`];
    if (detail.cc && detail.cc.length) parts.push(`抄送：${formatAddresses(detail.cc)}`);
    toLine.textContent = parts.join('　|　');
  } else {
    toLine.textContent = '';
  }

  const chip = $('r-account');
  chip.textContent = item.accountLabel || '';
  chip.style.background = `${item.accountColor || '#2563eb'}1a`;
  chip.style.color = item.accountColor || '#2563eb';

  $('r-flag').textContent = item.flagged ? '取消星标' : '加星标';

  const attBox = $('r-attachments');
  attBox.textContent = '';
  // 正文里引用的内嵌图不算附件，别把它们混进下载列表
  const atts = ((detail && detail.attachments) || []).filter((a) => !a.inline);
  if (!atts.length) {
    attBox.hidden = true;
  } else {
    attBox.hidden = false;
    for (const att of atts) {
      const btn = document.createElement('button');
      btn.className = 'att';
      btn.type = 'button';

      const name = document.createElement('span');
      name.textContent = `📎 ${att.filename}`;
      btn.appendChild(name);

      const size = document.createElement('span');
      size.className = 'att-size';
      size.textContent = formatSize(att.size);
      btn.appendChild(size);

      btn.addEventListener('click', () => downloadAttachment(att));
      attBox.appendChild(btn);
    }
  }
}

/**
 * 远程图片放不放行的**全局**设置，设置页里那个单选改的是同一个键。
 *
 * 默认放行。以前它是「每封信的临时开关」，每打开一封就重置成 false，结果每封
 * 带图的邮件都变成一排「图片已拦截」的灰框 —— 用户要的是看图，不是看占位框。
 * 现在只有一个值、默认 'allow'，想拦的人在设置页里选一下即可。
 *
 * 换了新键名（原来那个 showRemoteImages 是布尔值，语义已经被老逻辑污染过，
 * 里面可能躺着一个不该被当成「用户意愿」的 false），一次换干净。
 */
const IMAGE_MODE_KEY = 'imageMode';

async function loadImagePref() {
  try {
    const got = await chrome.storage.local.get(IMAGE_MODE_KEY);
    // 只有明确选了 block 才拦，其他情况（没存过、存坏了）一律放行
    state.showImages = String((got || {})[IMAGE_MODE_KEY] || '') !== 'block';
  } catch {
    state.showImages = true;
  }
}

function saveImagePref(value) {
  try {
    chrome.storage.local.set({ [IMAGE_MODE_KEY]: value ? 'allow' : 'block' });
  } catch {
    /* 存不下就算了，不影响本次显示 */
  }
}

/** 设置页改了同一个键，这边正好开着的话要跟着变，否则用户以为没生效 */
function watchImagePref() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[IMAGE_MODE_KEY]) return;
      const next = String(changes[IMAGE_MODE_KEY].newValue || '') !== 'block';
      if (next === state.showImages) return;
      state.showImages = next;
      if (state.detail) paintReaderBody();
    });
  } catch {
    /* 老版本浏览器没有 onChanged 就算了 */
  }
}

function paintReaderBody() {
  const d = state.detail;
  if (!d) return;

  // 服务端已经把正文里 cid: 引用的内嵌图转成 data: URL 一起带回来了。
  // 用 Map 包一层，sanitize.js 那边只认 Map。
  const cidMap = new Map(Object.entries(d.inlineImages || {}));

  paintFrame(
    buildEmailDocument(d.html, {
      text: d.text,
      showImages: state.showImages,
      cidMap,
    }),
  );

  // 只有「需要联网的图」才需要这个开关；内嵌图跟着邮件来，自动显示
  const remote = countRemoteImages(d.html);
  const btn = $('r-images');
  btn.hidden = remote === 0;
  // 拦着的时候把它标出来，别再让它混在「回复」「转发」中间当隐形人
  btn.classList.toggle('warn', !state.showImages && remote > 0);
  btn.textContent = state.showImages
    ? '隐藏远程图片'
    : remote > 0
      ? `显示远程图片（${remote}）`
      : '显示远程图片';
  btn.title = state.showImages
    ? '重新拦截远程图片。加载远程图片等于告诉发件人你已经读过这封信。'
    : `这封信里有 ${remote} 张图片需要联网获取，加载它们等于告诉发件人你已经读过。`;
}

async function downloadAttachment(att) {
  const d = state.detail;
  if (!d) return;
  try {
    toast(`正在下载 ${att.filename}…`);
    const { blob, filename } = await fetchAttachment(d.accountId, {
      mailbox: d.mailbox || 'INBOX',
      uid: d.uid,
      index: att.index,
    });
    saveBlob(blob, filename || att.filename);
  } catch (err) {
    toast(`下载失败：${err.message}`, 'error');
  }
}

/* ============================ 操作 ============================ */

async function toggleFlag() {
  const item = state.messages.find((m) => msgKey(m) === state.selectedKey);
  if (!item) return;
  const next = !item.flagged;
  try {
    await api.setFlags(item.accountId, { mailbox: item.mailbox || 'INBOX', uid: item.uid, flagged: next });
    item.flagged = next;
    if (state.detail) state.detail.flagged = next;
    renderList();
    paintReaderHeader(item, state.detail);
    toast(next ? '已加星标' : '已取消星标', 'ok');
  } catch (err) {
    toast(`操作失败：${err.message}`, 'error');
  }
}

async function markUnread() {
  const item = state.messages.find((m) => msgKey(m) === state.selectedKey);
  if (!item) return;
  try {
    await api.setFlags(item.accountId, { mailbox: item.mailbox || 'INBOX', uid: item.uid, seen: false });
    item.seen = false;
    renderList();
    state.unread[item.accountId] = (state.unread[item.accountId] || 0) + 1;
    renderAccounts();
    clearReader();
    toast('已标记为未读', 'ok');
  } catch (err) {
    toast(`操作失败：${err.message}`, 'error');
  }
}

async function deleteMessage() {
  const item = state.messages.find((m) => msgKey(m) === state.selectedKey);
  if (!item) return;

  const purging = inTrashFolder();
  const subject = item.subject || '(无主题)';
  const ask = purging
    ? `这封邮件已经在「已删除」里了，彻底删除后无法恢复。\n\n${subject}\n\n继续吗？`
    : `把「${subject}」移到「已删除」文件夹？\n\n之后还能从「已删除」里找回来。`;
  if (!confirm(ask)) return;

  try {
    const r = await api.bulk('trash', [
      { accountId: item.accountId, mailbox: item.mailbox || 'INBOX', uid: item.uid },
    ]);
    const failed = (r.results || []).find((x) => !x.ok);
    if (failed) throw new Error(failed.error);

    applyBulkLocally('trash', [item]);
    renderList();
    refreshUnread();

    const one = (r.results || [])[0] || {};
    let text = '已删除';
    if (purging) text = '已彻底删除';
    else if (one.marked) text = '已在服务器上标记删除（这个邮箱没有「已删除」文件夹）';
    else if (one.moved) text = `已移入「${one.folder}」`;
    toast(text, 'ok');
  } catch (err) {
    toast(`删除失败：${err.message}`, 'error');
  }
}

/* ============================ 写邮件 ============================ */

let composeMode = 'new';

function renderComposeAccounts(preferId) {
  const sel = $('c-account');
  const current = preferId || sel.value || (state.messages.find((m) => msgKey(m) === state.selectedKey) || {}).accountId;
  sel.textContent = '';
  for (const a of state.accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.label} <${a.email}>`;
    sel.appendChild(opt);
  }
  if (current && state.accounts.some((a) => a.id === current)) sel.value = current;
}

function openCompose(mode = 'new', ctx = {}) {
  if (!state.accounts.length) {
    toast('请先在设置里添加一个邮箱账户', 'error');
    return;
  }
  composeMode = mode;
  const title = mode === 'reply' ? '回复' : mode === 'forward' ? '转发' : '写邮件';
  $('c-title').textContent = title;

  renderComposeAccounts(ctx.accountId);

  if (mode === 'reply' && ctx.message) {
    const d = ctx.message;
    const f = firstAddress(d.from);
    $('c-to').value = f.address || '';
    $('c-cc').value = '';
    $('c-subject').value = /^re:/i.test(d.subject || '') ? d.subject : `Re: ${d.subject || ''}`;
    $('c-body').value = `${quoteOriginal(d)}`;
  } else if (mode === 'forward' && ctx.message) {
    const d = ctx.message;
    $('c-to').value = '';
    $('c-cc').value = '';
    $('c-subject').value = /^fwd:/i.test(d.subject || '') ? d.subject : `Fwd: ${d.subject || ''}`;
    $('c-body').value = `\n\n---------- 转发邮件 ----------\n${quoteOriginal(d)}`;
  } else {
    $('c-to').value = '';
    $('c-cc').value = '';
    $('c-subject').value = '';
    $('c-body').value = '';
  }

  $('c-status').textContent = '';
  $('compose-modal').hidden = false;
  setTimeout(() => $(mode === 'new' ? 'c-to' : 'c-body').focus(), 30);
}

function quoteOriginal(d) {
  const from = firstAddress(d.from);
  const head = [
    `发件人: ${from.name ? `${from.name} <${from.address}>` : from.address}`,
    `时间: ${formatFullDate(d.date)}`,
    `主题: ${d.subject || ''}`,
  ].join('\n');
  const body = (d.text || '').trim() || '(该邮件为 HTML 格式，请到原邮件查看排版内容)';
  return `\n\n\n------------ 原始邮件 ------------\n${head}\n\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`;
}

async function sendCompose() {
  const accountId = $('c-account').value;
  const to = $('c-to').value.trim();
  if (!accountId) return toast('请选择发件账户', 'error');
  if (!to) return toast('请填写收件人', 'error');

  const btn = $('c-send');
  btn.disabled = true;
  $('c-status').textContent = '正在发送…';

  const d = composeMode !== 'new' ? state.detail : null;
  const payload = {
    accountId,
    to,
    cc: $('c-cc').value.trim(),
    subject: $('c-subject').value.trim() || '(无主题)',
    text: $('c-body').value,
  };
  if (composeMode === 'reply' && d) {
    if (d.messageId) payload.inReplyTo = d.messageId;
    const refs = [].concat(d.references || []);
    if (d.messageId && !refs.includes(d.messageId)) refs.push(d.messageId);
    if (refs.length) payload.references = refs;
  }

  try {
    await api.send(payload);
    $('compose-modal').hidden = true;
    toast('邮件已发送', 'ok');
    loadList({ reset: true });
  } catch (err) {
    $('c-status').textContent = '';
    toast(`发送失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ============================ 初始化 ============================ */

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function bindEvents() {
  $('btn-compose').addEventListener('click', () => openCompose('new'));
  $('btn-refresh').addEventListener('click', refreshNow);
  $('btn-list-refresh').addEventListener('click', refreshNow);
  $('btn-settings').addEventListener('click', openOptions);

  $('btn-add-account').addEventListener('click', openOptions);
  $('btn-empty-add').addEventListener('click', openOptions);
  $('btn-reconnect').addEventListener('click', reconnect);

  $('search').addEventListener(
    'input',
    debounce((e) => {
      state.view.q = e.target.value.trim();
      loadList({ reset: true });
    }, 420),
  );

  $('only-unread').addEventListener('change', (e) => {
    state.view.unread = e.target.checked;
    loadList({ reset: true });
  });

  $('btn-more').addEventListener('click', () => {
    state.offset += state.limit;
    loadList({ reset: false });
  });

  /* 多选 */
  $('pick-all').addEventListener('change', (e) => togglePickAll(e.target.checked));
  $('bulk-clear').addEventListener('click', () => clearPick());
  for (const btn of document.querySelectorAll('#bulk-bar [data-bulk]')) {
    btn.addEventListener('click', () => runBulk(btn.dataset.bulk));
  }

  $('r-reply').addEventListener('click', () => openCompose('reply', { message: state.detail, accountId: (state.detail || {}).accountId }));
  $('r-forward').addEventListener('click', () => openCompose('forward', { message: state.detail, accountId: (state.detail || {}).accountId }));
  $('r-flag').addEventListener('click', toggleFlag);
  $('r-unread').addEventListener('click', markUnread);
  $('r-delete').addEventListener('click', deleteMessage);
  $('r-images').addEventListener('click', () => {
    state.showImages = !state.showImages;
    saveImagePref(state.showImages);
    paintReaderBody();
    toast(
      state.showImages
        ? '已显示远程图片，以后所有邮件都直接显示（可在设置页改回去）'
        : '已重新拦截远程图片，以后所有邮件都先拦住',
      'ok',
    );
  });

  $('c-close').addEventListener('click', () => {
    $('compose-modal').hidden = true;
  });
  $('c-send').addEventListener('click', sendCompose);
  $('compose-modal').addEventListener('click', (e) => {
    if (e.target === $('compose-modal')) $('compose-modal').hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('compose-modal').hidden) {
      $('compose-modal').hidden = true;
      return;
    }
    // F5 在插件页里不一定生效，手动兜一个
    if (e.key === 'F5' && $('compose-modal').hidden) {
      e.preventDefault();
      refreshNow();
      return;
    }
    // Ctrl/Cmd + A 全选当前列表（光标在输入框里时让位给「全选文字」）
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a' && !isTyping(e.target)) {
      if (state.messages.length && $('compose-modal').hidden) {
        e.preventDefault();
        togglePickAll(true);
      }
    }
  });

  // 设置页改过地址/令牌后自动重连
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.serverUrl || changes.token)) boot();
  });
}

function showBanner(title, text) {
  $('banner-title').textContent = title;
  $('banner-text').textContent = text;
  $('not-configured').hidden = false;
}

/** 重新连一次：先自动领取令牌，再拉数据 */
async function reconnect() {
  const btn = $('btn-reconnect');
  btn.disabled = true;
  btn.textContent = '连接中…';
  try {
    const cfg = await getConfig();
    await tryAutoConnect(cfg.serverUrl);
    await boot();
  } finally {
    btn.disabled = false;
    btn.textContent = '重新连接';
  }
}

async function boot() {
  let cfg = await getConfig();
  await loadImagePref();
  watchImagePref();

  // 没有令牌就先自动领一个，用户不需要手动复制
  if (!cfg.token) {
    await tryAutoConnect(cfg.serverUrl);
    cfg = await getConfig();
  }

  if (!cfg.serverUrl || !cfg.token) {
    // 先请后台去把本地服务拉起来（插件自己没权限启动进程，得走 Native Messaging）
    chrome.runtime.sendMessage({ type: 'ensure-service' }).catch(() => {});
    showBanner('正在启动本地服务', `${connectHint()} 不用你做别的，等几秒就好。`);
    // 服务起来需要几秒，页面自己轮询恢复，用户不用刷新
    if (!stopRetry) stopRetry = autoRetryConnect(() => boot());
    return;
  }

  try {
    await loadAccounts();
    renderFolders();
    await loadList({ reset: true });
    $('not-configured').hidden = true;
    if (stopRetry) {
      stopRetry();
      stopRetry = null;
    }
  } catch (err) {
    showBanner(
      '有点问题',
      err.status === 401 ? '访问令牌失效了，点右边重新连接就好。' : err.message,
    );
    toast(err.message, 'error');
  }
}

/** 把版本号显示在顶栏：一眼就能看出「重新加载扩展」到底生效了没有 */
function showVersion() {
  try {
    const el = $('app-version');
    if (el) el.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    /* 非插件环境忽略 */
  }
}

showVersion();
bindEvents();
boot();
