#!/usr/bin/env node
// The TeX engines the client serves at /texwasm/ (tex-wasm/, published as a GitHub release): the
// files tex-wasm/release.json names, each checked against its SHA-256 there, kept in
// ~/.cache/overlyx/texwasm by hash so that builds do not fetch them again. A file whose hash differs
// is refused. Without the network the client is built without them — encrypted projects then cannot
// build PDFs, which this says loudly — rather than not at all.
//
//   TEXWASM_DIR=tex-wasm/dist node scripts/fetch-tex-wasm.mjs   takes them from a local build (checked too)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'tex-wasm/release.json'), 'utf8'));
const out = path.join(root, 'packages/client/public/texwasm');
const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'overlyx/texwasm');
const local = process.env.TEXWASM_DIR ? path.resolve(process.env.TEXWASM_DIR) : null;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function bytesOf(name, want) {
  const kept = path.join(cache, want);
  try { const b = fs.readFileSync(kept); if (sha(b) === want) return b; } catch { /* not kept */ }
  let b;
  if (local) b = fs.readFileSync(path.join(local, name));
  else {
    const res = await fetch(release.url + name, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    b = Buffer.from(await res.arrayBuffer());
  }
  if (sha(b) !== want) throw new Error(`${name}: SHA-256 ${sha(b)}, not ${want} as tex-wasm/release.json says`);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(kept, b);
  return b;
}

try {
  if (!release.files || !Object.keys(release.files).length) throw new Error('tex-wasm/release.json names no files yet');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, want] of Object.entries(release.files)) {
    const dest = path.join(out, name);
    try { if (sha(fs.readFileSync(dest)) === want) continue; } catch { /* not there */ }
    fs.writeFileSync(dest, await bytesOf(name, want));
  }
  fs.writeFileSync(path.join(out, 'engines.json'), JSON.stringify({ release: release.release }) + '\n');
  console.log(`TeX engines: ${release.release}`);
} catch (e) {
  console.warn(`\n*** TeX engines (tex-wasm) not available: ${e.message}\n*** End-to-end encrypted projects cannot build PDFs with this client build.\n`);
}
