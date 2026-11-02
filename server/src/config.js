import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

export const port = Number(process.env.PORT || 8787);
export const bindHost = process.env.HOST || '127.0.0.1';
export const dataDir = path.resolve(rootDir, process.env.DATA_DIR || 'data');
export const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

fs.mkdirSync(dataDir, { recursive: true });

/** 32 字节主密钥，用于加密账户授权码，落盘在 data/secret.key */
function loadSecretKey() {
  const file = path.join(dataDir, 'secret.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (hex.length === 64) return Buffer.from(hex, 'hex');
  } catch {
    /* 首次运行 */
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

/** 插件调用服务端时使用的访问令牌 */
function loadToken() {
  const fromEnv = String(process.env.TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'token.txt');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    /* 首次运行 */
  }
  const token = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export const secretKey = loadSecretKey();
export const authToken = loadToken();
