/**
 * Native Messaging 主机：让插件点一下图标就能把本地服务拉起来。
 *
 * 浏览器插件本身没有权限启动本地进程，Windows 上唯一的正规通道就是
 * Native Messaging：插件 connectNative(名字) → 浏览器去注册表里找到本文件对应的
 * bat → 起一个进程 → 双方用 stdin/stdout 上的「4 字节长度 + JSON」通信。
 *
 * 这个进程只干一件事：
 *   端口已经有人听着  → 回一句「本来就在跑」
 *   端口没人听着      → 直接拉起守护进程（detached，浏览器关了也不受影响）
 *
 * 无论哪种情况都立刻返回并退出，绝不在这里常驻 —— 常驻的是 daemon.js。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
const SERVER_DIR = path.join(ROOT, 'server');
const DAEMON = path.join(here, 'daemon.js');

/** 端口以 server/.env 为准，没写就是 8787 */
function readPort() {
  try {
    const m = /^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8'));
    if (m) return Number(m[1]);
  } catch {
    /* 没有 .env */
  }
  return 8787;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(800);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 按 Native Messaging 协议回一条消息：uint32 小端长度 + UTF-8 JSON */
function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  try {
    process.stdout.write(Buffer.concat([head, body]));
  } catch {
    /* 管道已断，无妨 */
  }
}

function launchDaemon() {
  if (!fs.existsSync(DAEMON)) return { ok: false, error: 'native/daemon.js 不存在' };
  const child = spawn(process.execPath, [DAEMON], {
    cwd: SERVER_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true };
}

async function main() {
  const port = readPort();

  if (await portOpen(port)) {
    reply({ ok: true, started: false, port, reason: 'already-running' });
    return;
  }

  const r = launchDaemon();
  reply({ ok: r.ok, started: r.ok, port, ...(r.error ? { error: r.error } : {}) });
}

main()
  .catch((err) => reply({ ok: false, error: String((err && err.message) || err) }))
  .finally(() => {
    // 给 stdout 一点时间把字节刷进管道，然后干净退出
    setTimeout(() => process.exit(0), 120);
  });
