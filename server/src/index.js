import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { port, bindHost, allowedOrigins, authToken, dataDir } from './config.js';
import accountsRouter from './routes/accounts.js';
import messagesRouter from './routes/messages.js';
import sendRouter from './routes/send.js';
import eventsRouter from './routes/events.js';
import { stopIdle } from './mail/idle.js';
import { friendlyMessage } from './util.js';

const VERSION = '1.1.8';
const app = express();
const baseUrl = `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${port}`;

app.disable('x-powered-by');

/* ------------------------------------------------------------------ */
/* 连接诊断日志：插件连不上时，这里能看出请求到底有没有到服务端         */
/* 放在 CORS 之前，连被拦下的预检请求也能记下来                        */
/* ------------------------------------------------------------------ */

const diagFile = path.join(dataDir, 'diag.log');
const DIAG_MAX = 256 * 1024;

app.use('/api', (req, res, next) => {
  const line = [
    new Date().toISOString(),
    req.method,
    req.originalUrl,
    `origin=${req.get('origin') || '-'}`,
    `client=${req.get('x-mailhub-client') || '-'}`,
    `pna=${req.get('access-control-request-private-network') || '-'}`,
    `ip=${req.socket.remoteAddress}`,
    `ua=${(req.get('user-agent') || '-').slice(0, 60)}`,
  ].join(' ');
  try {
    if (fs.existsSync(diagFile) && fs.statSync(diagFile).size > DIAG_MAX) {
      const keep = fs
        .readFileSync(diagFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-200)
        .join('\n');
      fs.writeFileSync(diagFile, `${keep}\n`);
    }
    fs.appendFileSync(diagFile, `${line}\n`);
  } catch {
    /* 日志写不进去不影响业务 */
  }
  next();
});

// Chrome 的 Private Network Access：插件页访问本地服务时，会先发预检并带上
// Access-Control-Request-Private-Network，服务端必须明确回允许，否则请求被拦。
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' && req.get('access-control-request-private-network') === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      // 插件页面 / curl 等无 Origin 的请求直接放行
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'X-MailHub-Client'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }),
);
app.use(express.json({ limit: '25mb' }));



app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'MailHub', version: VERSION });
});

/* ------------------------------------------------------------------ */
/* 一键连接                                                            */
/* ------------------------------------------------------------------ */

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * 插件页面首次打开时自动领取访问令牌，省掉「复制令牌再粘贴」这一步。
 *
 * 两道闸门：
 *   1. 必须是本机回环连接 —— 别的机器连不上来；
 *   2. 有 Origin 的话，必须是 chrome-extension://。
 *
 * 关于第 2 条为什么要放过「没有 Origin」的情况：
 * 浏览器发起跨源请求一定会带 Origin（恶意站点也一样，藏不掉）；
 * 反过来，没有 Origin 说明请求不是浏览器跨源发起的，只可能是本机程序，
 * 而本机程序本来就能直接读 data/token.txt。所以这么放行不会降低安全边界，
 * 又能兼容个别浏览器版本不发 Origin 的情况。
 * 注意 Origin: null（file:// 页面）不等于没有 Origin，照样拒绝。
 *
 * 换句话说，它的安全边界和「读 data/token.txt」是同一级别。
 */
app.get('/api/handshake', (req, res) => {
  if (!isLoopback(req)) {
    return res.status(403).json({ error: '只允许本机访问' });
  }
  const origin = req.get('origin');
  if (origin && !origin.startsWith('chrome-extension://')) {
    return res.status(403).json({ error: '只允许浏览器插件页面调用' });
  }
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.json({ token: authToken, serverUrl: baseUrl, version: VERSION });
});

// 访问令牌校验
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!authToken || token === authToken) return next();
  res.status(401).json({ error: '访问令牌无效，请在插件设置里点「重新连接」' });
});

app.use('/api/accounts', accountsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api', sendRouter);
app.use('/api', eventsRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` });
});

/* ------------------------------------------------------------------ */
/* 启动页：双击启动脚本后浏览器会自动打开这一页                        */
/* ------------------------------------------------------------------ */

const WELCOME_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>邮箱助手已启动</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    background:#f4f6fa; color:#1a2330; padding:24px; }
  .card { width:min(560px,100%); background:#fff; border-radius:16px; padding:36px 34px 30px;
    box-shadow:0 6px 32px rgba(20,40,80,.09); border:1px solid #e6ebf3; }
  .tick { width:56px; height:56px; border-radius:50%; background:#e7f8ee; color:#1a9e5c;
    display:grid; place-items:center; font-size:30px; font-weight:700; margin-bottom:18px; }
  h1 { font-size:21px; margin:0 0 6px; letter-spacing:.2px; }
  .sub { color:#5f6d7e; margin:0 0 26px; font-size:14px; }
  ol { margin:0; padding-left:0; list-style:none; counter-reset:s; }
  ol li { position:relative; padding:12px 0 12px 44px; border-top:1px solid #eef1f6; font-size:14px; }
  ol li:first-child { border-top:0; }
  ol li::before { counter-increment:s; content:counter(s); position:absolute; left:0; top:12px;
    width:26px; height:26px; border-radius:50%; background:#2563eb; color:#fff;
    font-size:13px; font-weight:600; display:grid; place-items:center; }
  b { color:#1a2330; }
  .foot { margin-top:24px; padding-top:18px; border-top:1px solid #eef1f6;
    font-size:12.5px; color:#8894a4; line-height:1.8; }
  code { background:#f1f4f9; padding:1px 5px; border-radius:4px; font-size:12px; color:#3b4a5c; }
</style></head>
<body><div class="card">
  <div class="tick">✓</div>
  <h1>本地服务已就绪</h1>
  <p class="sub">服务在后台运行，没有窗口，不用管它。要停掉就在项目文件夹里双击「停止邮箱助手.bat」。</p>
  <ol>
    <li>点浏览器右上角的 <b>MailHub 图标</b>，打开统一收件箱。</li>
    <li>第一次用会引导你添加邮箱，只需要 <b>邮箱地址 + 授权码</b> 两样东西。</li>
    <li>想加第二个、第三个邮箱，随时在面板左下角点「＋ 添加邮箱」。</li>
  </ol>
  <div class="foot">
    这个页面看完就可以关掉了。<br>
    访问令牌保存在 <code>server/data/token.txt</code>，邮箱授权码加密后存在 <code>server/data/accounts.json</code>，都在你自己电脑上。
  </div>
</div></body></html>`;

app.get('/', (req, res) => {
  res.type('html').send(WELCOME_HTML);
});

// 统一错误处理
app.use((err, req, res, next) => {
  let status = err.status;
  if (!status) status = err.authenticationFailed ? 401 : 500;

  // 我们自己抛的 HttpError 文案是写好的，直接用；
  // 其余都是底层库的原始报错，翻译成人话再返回。
  const message = status < 500 ? err.message : friendlyMessage(err);
  if (status >= 500) console.error('[MailHub]', err);
  res.status(status).json({ error: message });
});

const server = app.listen(port, bindHost, () => {
  // 记下进程号，供「停止邮箱助手.bat」使用
  try {
    fs.writeFileSync(path.join(dataDir, 'server.pid'), String(process.pid));
  } catch {
    /* 写不进去不影响运行 */
  }

  console.log('');
  console.log('  ┌────────────────────────────────────────────────┐');
  console.log('  │  MailHub 统一邮箱 · 本地服务已启动             │');
  console.log('  └────────────────────────────────────────────────┘');
  console.log(`  服务地址   ${baseUrl}`);
  console.log(`  数据目录   ${dataDir}`);
  console.log(`  进程号     ${process.pid}`);
  console.log('');
  console.log('  ▶ 现在点浏览器右上角的 MailHub 图标就能用了，');
  console.log('    插件会自动连上这里，不需要手动填地址和令牌。');
  console.log('');
  console.log('  ▶ 这个是后台服务，没有窗口可以关；要停掉它，');
  console.log('    双击项目根目录的「停止邮箱助手.bat」。');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ✗ 端口 ${port} 已被占用，可能是服务已经在运行了。`);
    console.error('    直接点浏览器里的 MailHub 图标试试；');
    console.error('    如果确实是别的程序占了端口，改 server/.env 里的 PORT。');
    console.error('');
    process.exit(2);
  }
  throw err;
});

/* ------------------------------------------------------------------ */
/* 退出清理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 实时推送给每个邮箱维持着一条常驻连接，正常退出时得把它们 logout 掉。
 * 直接 process.exit() 会让服务器那边留下一堆「假在线」，短时间内重连容易被拒。
 */
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  stopIdle();
  server.close(() => process.exit(0));
  // close() 会等长连接自己断，这里最多等 3 秒就走人
  setTimeout(() => process.exit(0), 3000).unref();
  if (signal) console.log(`  收到 ${signal}，已断开实时推送连接。`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
