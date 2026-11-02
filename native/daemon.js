/**
 * MailHub 服务守护进程。
 *
 * 存在意义：让「本地服务」变成一直活着的东西，用户不用再双击 bat。
 *
 *   1. 单实例：靠 data/daemon.pid 判断，重复启动会直接退出；
 *   2. 自动重启：node 服务不管因为什么退出（崩了、被杀了、网络抖动），
 *      3 秒后重新拉起来；连续秒退就退避，避免死循环刷日志；
 *   3. 优雅停止：data/stop.flag 一出现，循环结束，服务不再拉起。
 *
 * 所有输出都写进 data/service.log，因为这个进程是用隐藏窗口跑的，没有控制台。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here); // D:\email-hub
const SERVER_DIR = path.join(ROOT, 'server');
const ENTRY = path.join(SERVER_DIR, 'src', 'index.js');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const STOP_FLAG = path.join(DATA_DIR, 'stop.flag');
const LOG_FILE = path.join(DATA_DIR, 'service.log');
const LOG_MAX = 512 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- 日志 ---------------- */

function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size > LOG_MAX) {
      const keep = fs
        .readFileSync(LOG_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-300)
        .join('\n');
      fs.writeFileSync(LOG_FILE, `${keep}\n`);
    }
  } catch {
    /* 文件不存在或读不了，无所谓 */
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* 写不进日志也不能影响服务 */
  }
}

/* ---------------- 单实例 ---------------- */

function alivePid(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function existingDaemon() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (alivePid(pid) && pid !== process.pid) return pid;
  } catch {
    /* 没有 pid 文件 */
  }
  return 0;
}

const running = existingDaemon();
if (running) {
  log(`已有守护进程在跑（pid=${running}），本次启动退出`);
  process.exit(0);
}

// 这次是用户主动启动的，把上次「停止」留下的标记清掉，否则刚起来就退出
try {
  fs.unlinkSync(STOP_FLAG);
} catch {
  /* 本来就没有 */
}

fs.writeFileSync(PID_FILE, String(process.pid));
rotateLog();
log(`守护进程启动 pid=${process.pid} node=${process.execPath}`);

/* ---------------- 主循环 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  try {
    if (Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {
    /* 忽略 */
  }
  log('守护进程退出');
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => shutdown(0));
}

// 连续「起来就挂」的次数，用来退避
let crashStreak = 0;

async function main() {
  for (;;) {
    if (stopping) break;

    if (fs.existsSync(STOP_FLAG)) {
      log('检测到 stop.flag，停止守护');
      try {
        fs.unlinkSync(STOP_FLAG);
      } catch {
        /* 忽略 */
      }
      shutdown(0);
      return;
    }

    const startedAt = Date.now();
    log('启动服务…');

    const child = spawn(process.execPath, [ENTRY], {
      cwd: SERVER_DIR,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, MAILHUB_DAEMON: '1' },
    });

    const code = await new Promise((resolve) => {
      child.on('error', (err) => {
        log(`拉不起服务进程：${err.message}`);
        resolve(-1);
      });
      child.on('exit', (c, sig) => resolve(c == null ? -1 : c));
    });

    const lived = Date.now() - startedAt;
    // Windows 上被强杀的进程会拿到 0xFFFFFFFF 这种巨值，直接打出来看不懂
    const why = code === 0 ? '正常退出' : code === -1 ? '未能启动' : code > 0x7fffffff ? '被强制结束' : `退出码 ${code}`;
    log(`服务${why}，存活 ${Math.round(lived / 1000)} 秒`);

    // 退出码 2 = 端口被占用，说明已经有一个服务在跑了，守护进程没必要继续
    if (code === 2) {
      log('端口已被占用，判定已有服务在运行，守护进程退出');
      shutdown(0);
      return;
    }

    // 用户点了「停止」时可能把服务一起杀了，这时不该再拉起来
    if (fs.existsSync(STOP_FLAG)) continue;

    crashStreak = lived < 8000 ? crashStreak + 1 : 0;
    const wait = crashStreak === 0 ? 3000 : Math.min(3000 * crashStreak, 20000);
    if (crashStreak > 0) log(`服务起来很快就退了（第 ${crashStreak} 次），${wait / 1000} 秒后再试`);
    await sleep(wait);
  }
  shutdown(0);
}

main().catch((err) => {
  log(`守护进程异常：${err && err.stack ? err.stack : err}`);
  shutdown(1);
});
