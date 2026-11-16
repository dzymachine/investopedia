// Linked Plaid items and passkeys on local disk, owner-only permissions.
// Access tokens are encrypted with TOKEN_KEY when it is set.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encrypt, decrypt } from './secure.js';

const DIR = resolve(process.env.DATA_DIR || join(import.meta.dirname, '..', 'data'));
const TOKEN_KEY = process.env.TOKEN_KEY || '';

export function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(join(DIR, name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeJson(name, value) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = join(DIR, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function loadItems() {
  return (readJson('items.json', {}).items ?? [])
    .map((i) => ({ ...i, access_token: decrypt(i.access_token, TOKEN_KEY) }));
}

export function saveItems(items) {
  writeJson('items.json', {
    items: items.map((i) => ({ ...i, access_token: TOKEN_KEY ? encrypt(i.access_token, TOKEN_KEY) : i.access_token })),
  });
}
