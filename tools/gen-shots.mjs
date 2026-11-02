#!/usr/bin/env node
/**
 * 生成 README 用的界面截图（docs/screenshots/*.png）
 *
 * 做法：把 extension/src/app/app.html 的结构原样抄一份出来，**直接引用仓库里真实的
 * app.css / options.css**，只把 JS 会填的那部分内容换成下面 DEMO 里的假数据，
 * 然后用 Edge 无头模式截图。
 *
 * 所以图里的版式、间距、配色、字体全部是产品本身的样子，不是另外画的一张图；
 * 换来的代价是——样式改了以后这些 PNG 不会自己更新，得重新跑一次：
 *
 *     node tools/gen-shots.mjs
 *
 * 数据全部是编的（example.com / 20260101@qq.com 之类），不含任何真实邮件。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.shots'); // 临时目录，跑完就删
const outDir = path.join(root, 'docs', 'screenshots');
const EDGE =
  process.env.MSEDGE ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/* ============================ 演示数据 ============================ */

const ACCOUNTS = [
  { label: '工作邮箱', email: 'work@example.com', color: '#2563eb', unread: 3 },
  { label: 'QQ 邮箱', email: '20260101@qq.com', color: '#16a34a', unread: 2 },
  { label: '139 邮箱', email: 'demo@139.com', color: '#d97706', unread: 2 },
];

const MESSAGES = [
  { from: '阿里云备案', subj: '您的备案信息即将到期，请及时续费', date: '09:41', unread: 1, color: '#2563eb' },
  { from: 'GitHub', subj: '[cccppy/mailhub] 有人给这个仓库点了 Star', date: '09:12', unread: 1, color: '#16a34a' },
  { from: '张明远', subj: '关于下周客户拜访的行程安排', date: '昨天', unread: 1, color: '#2563eb', star: 1, att: 1 },
  { from: '财务共享中心', subj: '9 月报销单据已审批通过（单号 BX-20261017）', date: '昨天', unread: 0, color: '#2563eb', att: 1 },
  { from: '腾讯云', subj: '【账单】10 月账单已出，共计 ¥128.40', date: '10月31日', unread: 0, color: '#d97706' },
  { from: '李伟', subj: 'Re: 需求评审纪要（附流程图）', date: '10月31日', unread: 0, color: '#16a34a', att: 1 },
  { from: '铁路 12306', subj: '购票成功通知：G101 次 北京南 — 上海虹桥', date: '10月30日', unread: 0, color: '#d97706' },
  { from: '林小满', subj: '周末那本书我看完了，借你了', date: '10月29日', unread: 0, color: '#16a34a' },
];

/** 阅读区里那封打开的邮件正文（塞进 iframe 的 srcdoc） */
const EMAIL = `<div style="font:14px/1.75 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328;padding:24px 28px;max-width:680px">
<p>李经理，您好：</p>
<p>下周三家客户的拜访行程已经排好，具体时间见下表，麻烦帮忙确认一下有没有冲突。</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:13.5px">
<thead><tr style="background:#f6f8fa">
<th style="text-align:left;padding:8px 10px;border:1px solid #e3e7ec;font-weight:600">时间</th>
<th style="text-align:left;padding:8px 10px;border:1px solid #e3e7ec;font-weight:600">客户</th>
<th style="text-align:left;padding:8px 10px;border:1px solid #e3e7ec;font-weight:600">地点</th>
<th style="text-align:left;padding:8px 10px;border:1px solid #e3e7ec;font-weight:600">对接人</th>
</tr></thead>
<tbody>
<tr><td style="padding:8px 10px;border:1px solid #e3e7ec">11/09 周一 10:00</td><td style="padding:8px 10px;border:1px solid #e3e7ec">恒晟科技</td><td style="padding:8px 10px;border:1px solid #e3e7ec">杭州 · 滨江</td><td style="padding:8px 10px;border:1px solid #e3e7ec">王工</td></tr>
<tr><td style="padding:8px 10px;border:1px solid #e3e7ec">11/10 周二 14:00</td><td style="padding:8px 10px;border:1px solid #e3e7ec">南山数据</td><td style="padding:8px 10px;border:1px solid #e3e7ec">上海 · 张江</td><td style="padding:8px 10px;border:1px solid #e3e7ec">刘经理</td></tr>
<tr><td style="padding:8px 10px;border:1px solid #e3e7ec">11/11 周三 09:30</td><td style="padding:8px 10px;border:1px solid #e3e7ec">瑞和物流</td><td style="padding:8px 10px;border:1px solid #e3e7ec">南京 · 鼓楼</td><td style="padding:8px 10px;border:1px solid #e3e7ec">陈主任</td></tr>
</tbody></table>
<p>另外有两点需要提前准备：</p>
<ul style="margin:10px 0 10px;padding-left:20px">
<li>恒晟科技今年新增了专线需求，上次的报价单要更新一版；</li>
<li>南山数据要求带上网络安全服务的资质文件复印件。</li>
</ul>
<p>行程表在附件里，手机端也能直接看。有变动今天下班前跟我说一声，我来协调。</p>
<p style="margin-top:24px">张明远<br><span style="color:#656d76;font-size:13px">解决方案部 · 分机 8721</span></p>
</div>`;

/* ============================ 小工具 ============================ */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const dot = (c) => `<span class="dot" style="background:${c}"></span>`;

function navItem({ label, sub, color, count, active }) {
  return `<li${active ? ' class="active"' : ''}>${color ? dot(color) : ''}
<div class="nav-label"><div>${esc(label)}</div>${sub ? `<div class="nav-sub">${esc(sub)}</div>` : ''}</div>
<span class="count${count ? '' : ' zero'}">${count || 0}</span></li>`;
}

function msgRow(m, i, picked) {
  const cls = [m.unread ? 'unread' : '', picked ? 'picked' : ''].filter(Boolean).join(' ');
  return `<li${cls ? ` class="${cls}"` : ''}>
<input type="checkbox" class="pick"${picked ? ' checked' : ''} title="勾选后可批量操作">
<div class="row-1"><span class="acct-stripe" style="background:${m.color}"></span><span class="from">${esc(m.from)}</span></div>
<span class="date">${esc(m.date)}</span>
<div class="subject">${esc(m.subj)}</div>
<div class="flags">${m.star ? '<span class="flag-star">★</span>' : ''}${m.att ? '<span class="flag-attach">📎</span>' : ''}</div>
</li>`;
}

/* ============================ 主界面 ============================ */

function appPage({ picked = [], bulk = false, modal = false } = {}) {
  const total = ACCOUNTS.reduce((n, a) => n + a.unread, 0);
  const pickedSet = new Set(picked);

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="app.css">
<style>::-webkit-scrollbar{width:0!important;height:0!important}</style>
</head><body>
<div class="app">
  <header class="topbar">
    <div class="brand"><span class="logo">M</span><span>MailHub</span></div>
    <button class="primary">写邮件</button>
    <div class="search"><input type="search" placeholder="搜索主题或正文…"></div>
    <div class="spacer"></div>
    <span class="live" title="新邮件实时推送已连接"></span>
    <span class="ver">v1.1.7</span>
    <button><span class="ico">⟳</span>刷新</button>
    <button>设置</button>
  </header>

  <main class="layout">
    <aside class="sidebar">
      <div class="side-block">
        <div class="side-title">统一收件箱 <span class="pill">${total}</span></div>
        <ul class="nav">
          ${navItem({ label: '统一收件箱', sub: `${ACCOUNTS.length} 个账户合并`, count: total, active: true })}
          ${ACCOUNTS.map((a) => navItem({ label: a.label, sub: a.email, color: a.color, count: a.unread })).join('\n')}
        </ul>
        <button class="side-add">＋ 添加邮箱</button>
      </div>
    </aside>

    <section class="list-pane">
      <div class="list-head">
        <label class="pick-all"><input type="checkbox"${bulk ? ' checked' : ''}></label>
        <div id="list-title">统一收件箱</div>
        <div class="list-head-right">
          <label class="chk"><input type="checkbox"> 仅未读</label>
          <span class="dim">${MESSAGES.length} 封</span>
          <button class="mini-btn">⟳</button>
        </div>
      </div>
      ${bulk ? `<div class="bulk-bar"><span class="bulk-count">已选 ${picked.length} 封</span>
        <div class="bulk-actions"><button>标为已读</button><button>标为未读</button><button>加星标</button>
        <button>取消星标</button><button class="danger">删除</button><button class="ghost">取消选择</button></div></div>` : ''}
      <div class="list-scroll">
        <ul class="messages${bulk ? ' has-pick' : ''}">
          ${MESSAGES.map((m, i) => msgRow(m, i, pickedSet.has(i))).join('\n')}
        </ul>
      </div>
    </section>

    <section class="read-pane">
      <article class="reader">
        <header class="reader-head">
          <h1>关于下周客户拜访的行程安排</h1>
          <div class="reader-meta">
            <div class="avatar" style="background:#0f766e">张</div>
            <div class="meta-text">
              <div class="meta-line"><span class="strong">张明远</span><span class="dim">11 月 2 日 09:12</span></div>
              <div class="dim small">发给：我</div>
            </div>
            <span class="acct-chip">工作邮箱</span>
          </div>
          <div class="reader-actions">
            <button class="primary">回复</button><button>转发</button><button>标记未读</button>
            <button>加星标</button><button class="danger">删除</button>
          </div>
          <div class="attachments"><div class="att"><span>📎</span><span>客户拜访日程.xlsx</span><span class="att-size">18 KB</span></div></div>
        </header>
        <div class="reader-body"><iframe title="邮件正文" sandbox="allow-popups" srcdoc="${esc(EMAIL)}"></iframe></div>
      </article>
    </section>
  </main>
</div>
${modal ? composeModal() : ''}
</body></html>`;
}

function composeModal() {
  return `<div class="modal"><div class="modal-card">
  <header class="modal-head"><span>写邮件</span><button class="icon">×</button></header>
  <div class="modal-body">
    <div class="field"><label>发件账户</label><select><option>工作邮箱 &lt;work@example.com&gt;</option><option>QQ 邮箱 &lt;20260101@qq.com&gt;</option></select></div>
    <div class="field"><label>收件人</label><input value="wang.gong@example.com"></div>
    <div class="field"><label>抄送</label><input placeholder="可留空"></div>
    <div class="field"><label>主题</label><input value="Re: 关于下周客户拜访的行程安排"></div>
    <textarea>王工，您好：

行程表我收到了，11 月 9 日上午的时间没问题。专线那部分我这边先出一版初步方案，周一见面时一起过一遍。

另外想问一下，机房那边是否方便提前安排一次现场勘查？</textarea>
    <div class="field">
      <div class="attach-head">
        <span class="attach-title">附件</span>
        <span class="dim">共 2 个，合计 184.0 KB</span>
      </div>
      <button type="button" class="attach-btn">＋ 添加附件</button>
      <ul class="attach-list">
        <li class="attach-item"><span class="name">专线初步方案-v1.docx</span><span class="size">168.0 KB</span><button class="del">×</button></li>
        <li class="attach-item"><span class="name">机房勘查要点.txt</span><span class="size">16.0 KB</span><button class="del">×</button></li>
      </ul>
    </div>
  </div>
  <footer class="modal-foot"><button class="primary">发送</button><span class="dim"></span></footer>
</div></div>`;
}

/* ============================ 设置页 ============================ */

function optionsPage() {
  const chips = ['QQ 邮箱', '139 邮箱', '163 邮箱', '126 邮箱', 'Gmail', '其他邮箱'];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="options.css">
<style>::-webkit-scrollbar{width:0!important;height:0!important}</style>
</head><body><div class="wrap">
  <header class="page-head">
    <h1>邮箱助手</h1>
    <div class="conn-bar ok"><span class="bar-dot"></span><span>已连接 · 共 3 个邮箱</span></div>
  </header>

  <section class="card">
    <h2>添加一个邮箱</h2>
    <div class="chips">${chips.map((c, i) => `<button class="chip${i === 0 ? ' active' : ''}">${c}</button>`).join('')}</div>
    <div class="grid">
      <label>邮箱地址</label><input placeholder="例如 12345678（会自动补 @qq.com）">
      <label>授权码</label><input type="password" value="abcdefghijklmnop" placeholder="不是登录密码">
    </div>
    <p class="hint">QQ 邮箱网页版 → 设置 → 账号 → 开启「IMAP/SMTP 服务」→ 生成 16 位授权码。</p>
    <div class="actions"><button class="primary big">保存并测试</button><span class="status"></span></div>
  </section>

  <section class="card">
    <h2>我的邮箱</h2>
    <ul class="accounts">
      ${ACCOUNTS.map(
        (a) => `<li>${dot(a.color)}<div class="who"><div class="name">${esc(a.label)}</div><div class="addr">${esc(a.email)}</div></div>
<span class="srv">imap.${a.email.split('@')[1]}:993</span><button class="link">删除</button></li>`,
      ).join('\n')}
    </ul>
    <div class="actions"><button class="ghost">打开统一收件箱</button></div>
  </section>
</div></body></html>`;
}

/* ============================ 截图 ============================ */

const SHOTS = [
  { file: 'main.png', html: appPage(), size: '1400,880' },
  { file: 'bulk.png', html: appPage({ picked: [0, 1, 3], bulk: true }), size: '1400,880' },
  { file: 'compose.png', html: appPage({ modal: true }), size: '1400,960' },
  { file: 'settings.png', html: optionsPage(), size: '980,1120' },
];

fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
for (const css of ['app.css', 'options.css']) {
  fs.copyFileSync(
    path.join(root, 'extension', 'src', css === 'app.css' ? 'app' : 'options', css),
    path.join(stage, css),
  );
}

for (const s of SHOTS) {
  const htmlPath = path.join(stage, s.file.replace('.png', '.html'));
  fs.writeFileSync(htmlPath, s.html, 'utf8');
  const png = path.join(outDir, s.file);
  execFileSync(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=2',
      `--user-data-dir=${path.join(stage, 'profile')}`,
      `--window-size=${s.size}`,
      '--virtual-time-budget=4000',
      `--screenshot=${png}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ],
    { stdio: 'pipe' },
  );
  const kb = (fs.statSync(png).size / 1024).toFixed(0);
  console.log(`${s.file.padEnd(14)} ${s.size.padEnd(10)} ${kb} KB`);
}

fs.rmSync(stage, { recursive: true, force: true });
console.log(`\n输出目录：${path.relative(root, outDir)}`);
