import crypto from 'node:crypto';
import { secretKey } from './config.js';

/**
 * AES-256-GCM 加密。授权码绝不以明文落盘。
 * 输出格式：v1.<iv>.<tag>.<密文>（均为 base64url）
 */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(payload) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('授权码数据格式异常');
  const [, iv, tag, data] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
