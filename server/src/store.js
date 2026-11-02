import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

const file = path.join(dataDir, 'accounts.json');
let state = { accounts: [] };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
  } catch {
    state = { accounts: [] };
  }
}

function persist() {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

load();

/** 对外暴露时必须去掉 secretEnc */
export function sanitize(acct) {
  if (!acct) return null;
  const { secretEnc, ...rest } = acct;
  return rest;
}

export function listAccounts() {
  return state.accounts.map(sanitize);
}

export function rawAccounts() {
  return state.accounts.slice();
}

export function getAccount(id) {
  return state.accounts.find((a) => a.id === id) || null;
}

export function addAccount(acct) {
  state.accounts.push(acct);
  persist();
  return sanitize(acct);
}

export function updateAccount(id, patch) {
  const acct = getAccount(id);
  if (!acct) return null;
  Object.assign(acct, patch);
  persist();
  return sanitize(acct);
}

export function removeAccount(id) {
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.id !== id);
  if (state.accounts.length !== before) {
    persist();
    return true;
  }
  return false;
}
