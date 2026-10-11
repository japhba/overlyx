/**
 * Limits that keep one request or one document from reaching other users' data or knocking the
 * server over (pre-beta audit, 11 Oct 2026): a zip never inflates past the size it declares (zip.ts),
 * a deliverable's zip stays in its project (deliverables.ts), sandboxed tools get a file-size limit
 * and a project's build a cgroup of its own (sandbox.ts), and a build cannot read the shared cache.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

// (before any server module: config.ts would otherwise point at the real data directory)
const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), `overlyx-security-limits-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
const { config } = await import('../packages/server/src/config.ts');
const { readZip, extractZip } = await import('../packages/server/src/zip.ts');
const { sandboxed, MAX_FILE_BYTES } = await import('../packages/server/src/sandbox.ts');
const { deliverableZip } = await import('../packages/server/src/deliverables.ts');

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

/** a zip of one entry whose central directory declares `declared` bytes for `data` (deflated when `deflate`) */
function zipOf(name: string, data: Buffer, declared: number, deflate = true): Buffer {
  const body = deflate ? zlib.deflateRawSync(data) : data;
  const n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(body.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + n.length + body.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, body, central, n, eocd]);
}

describe('zip bombs', () => {
  it('an entry never inflates past the size the archive declares', () => {
    expect(config.dataDir).toBe(join(ROOT, 'data'));
    const bomb = zipOf('a.tex', Buffer.alloc(8 * 1024 * 1024), 1);   // 8 MB of zeros declared as 1 byte
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => readZip(bomb)[0].data()).toThrow(/not the size it declares/);
    expect(() => extractZip(bomb, join(ROOT, 'out1'))).toThrow();
    expect(existsSync(join(ROOT, 'out1', 'a.tex'))).toBe(false);
  });
  it('a stored entry must be as long as it says', () => {
    expect(() => readZip(zipOf('b.txt', Buffer.from('hello world'), 5, false))[0].data()).toThrow(/not the size it declares/);
  });
  it('honest archives still unpack', () => {
    const r = extractZip(zipOf('dir/c.tex', Buffer.from('\\documentclass{article}'), 23), join(ROOT, 'out2'));
    expect(r.files).toEqual(['c.tex']);   // (a single top folder is stripped)
    expect(readFileSync(join(ROOT, 'out2', 'c.tex'), 'utf8')).toBe('\\documentclass{article}');
  });
});

describe('deliverable zips', () => {
  it('stay inside their project: no `..`, no sibling project with a longer name', async () => {
    mkdirSync(join(ROOT, 'projects', 'bob', 'talk'), { recursive: true });
    mkdirSync(join(ROOT, 'projects', 'bob', 'talk2'), { recursive: true });
    writeFileSync(join(ROOT, 'projects', 'bob', 'talk', 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(join(ROOT, 'projects', 'bob', 'talk2', 'secret.txt'), 'private');
    for (const rel of ['../talk2/index.html', '../../bob/talk2/index.html', 'a/../../talk2/index.html', '/etc/index.html'])
      await expect(deliverableZip('bob/talk', rel, join(ROOT, 'dist')), rel).rejects.toThrow(/bad folder/);
  });
  it('are the page as published: suggestions accepted, comments left out (core html/review.ts)', async () => {
    mkdirSync(join(ROOT, 'projects', 'bob', 'rv'), { recursive: true });
    mkdirSync(join(ROOT, 'dist', '_ol', 'mathjax'), { recursive: true });
    writeFileSync(join(ROOT, 'dist', '_ol', 'runtime.js'), '');
    writeFileSync(join(ROOT, 'projects', 'bob', 'rv', 'index.html'), `<!doctype html><html><head><meta name="overlyx" content="deck"><title>t</title></head><body>
<section class="slide" data-ol-comments='[{"id":"c1","by":"Kim","at":"2026-10-11 10:00","text":"internal remark"}]'>
  <p>The <del data-ol-by="Kim|2026-10-11 10:00">old</del><ins data-ol-by="Kim|2026-10-11 10:00">new</ins> words</p>
  <img src="x.png" data-ol-del="Kim|2026-10-11 10:00">
</section></body></html>`);
    const { entries } = await deliverableZip('bob/rv', 'index.html', join(ROOT, 'dist'));
    const html = entries.find(e => e.name === 'index.html')!.data.toString('utf8');
    expect(html).toContain('<p>The new words</p>');
    expect(html).not.toMatch(/data-ol-|internal remark|x\.png/);
  });
});

describe('sandboxed tools', () => {
  const haveBwrap = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some(existsSync);
  const havePrlimit = ['/usr/bin/prlimit', '/bin/prlimit'].some(existsSync);
  it.skipIf(!haveBwrap || !havePrlimit)('cannot write a file past MAX_FILE_BYTES', () => {
    const dir = join(ROOT, 'fsize'); mkdirSync(dir, { recursive: true });
    const s = sandboxed('sh', ['-c', 'ulimit -f'], { rw: [dir], cwd: dir, env: {}, home: false });
    expect(s.args).toContain(`--fsize=${MAX_FILE_BYTES}`);
    const r = spawnSync(s.cmd, s.args, { env: s.env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    // ulimit -f counts 512-byte blocks in sh
    expect(Number(r.stdout.trim()) * 512).toBe(MAX_FILE_BYTES);
  });
  it.skipIf(!haveBwrap || process.getuid?.() !== 0 || !existsSync('/run/systemd/system'))('a project\'s build runs in a cgroup with a process limit', async () => {
    const dir = join(ROOT, 'cg'); mkdirSync(dir, { recursive: true });
    const s = sandboxed('sleep', ['3'], { rw: [dir], cwd: dir, env: {}, home: false, cgroup: { memoryMB: 300, tasks: 32 } });
    expect(s.cmd).toBe('systemd-run');
    const child = spawn(s.cmd, s.args, { env: s.env, stdio: 'ignore' });
    // (inside, the sandbox's cgroup namespace shows "/": look from outside, at the process systemd-run became)
    await new Promise(r => setTimeout(r, 1500));
    const cg = readFileSync(`/proc/${child.pid}/cgroup`, 'utf8');
    const scope = /\/(run-[^/\n]*\.scope)/.exec(cg)?.[1];
    expect(scope).toBeTruthy();
    expect(spawnSync('systemctl', ['show', scope!, '-p', 'TasksMax', '--value'], { encoding: 'utf8' }).stdout.trim()).toBe('32');
    child.kill('SIGKILL');
  });
  it.skipIf(!haveBwrap)('the shared cache is not inside a build\'s sandbox', () => {
    const src = readFileSync(join(__dirname, '../packages/server/src/export.ts'), 'utf8');
    expect(src).not.toMatch(/ro: \[projectDir\(project\), cacheDir\]/);
    expect(readFileSync(join(__dirname, '../packages/server/src/snippets.ts'), 'utf8')).not.toMatch(/cacheDir\]/);
  });
});
