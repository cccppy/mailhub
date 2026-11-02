#!/usr/bin/env node
/**
 * 生成 Native Messaging 宿主清单：native/com.mailhub.launcher.json
 *
 * 这份清单里有两样东西是「只有本机才有意义」的：
 *
 *   path             宿主可执行文件的**绝对路径**（浏览器只认绝对路径）
 *   allowed_origins  未打包扩展的 ID，而它是由扩展目录的绝对路径算出来的
 *
 * 所以清单不能跟着仓库走 —— 我机器上是 D 盘，别人克隆到 C 盘，两个值就都错了，
 * 表现是「点插件图标没反应」，还很难查。改成安装时按当前目录现算一份。
 *
 * 由 启动邮箱助手.bat 的注册段调用：搬动项目目录之后双击一次，清单会自动修正。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extDir = path.join(root, 'extension');
const hostPath = path.join(root, 'native', 'launcher.bat');

/**
 * Chrome 给「加载已解压的扩展程序」分配 ID 的规则：
 * 把扩展目录的绝对路径按 UTF-16LE 编码，做 sha256，取前 16 字节，
 * 再把每个十六进制字符 0-f 映射成 a-p（0→a、9→j、a→k、f→p）。
 * 结论就是：ID 跟着路径走，路径一变 ID 就变。
 */
function extensionId(dir) {
  const hex = crypto
    .createHash('sha256')
    .update(Buffer.from(dir, 'utf16le'))
    .digest('hex')
    .slice(0, 32);
  return hex
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

const manifest = {
  name: 'com.mailhub.launcher',
  description: 'MailHub local service launcher',
  path: hostPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId(extDir)}/`],
};

const out = path.join(root, 'native', 'com.mailhub.launcher.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
// 必须 UTF-8 且**无 BOM** —— 带 BOM 的清单浏览器直接读不出来，报错还很不明确
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`host  -> ${manifest.path}`);
console.log(`ext   -> ${manifest.allowed_origins[0]}`);
