import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxed, sandboxAvailable } from '../packages/server/src/sandbox.ts';
import { config } from '../packages/server/src/config.ts';

const haveBwrap = ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some(existsSync);

describe('sandbox', () => {
  it.skipIf(!haveBwrap)('wraps the command in bwrap with only the requested directories writable', () => {
    expect(sandboxAvailable()).toBe(true);
    const s = sandboxed('latexmk', ['-pdf', 'main.tex'], { rw: ['/tmp/ol-build'], ro: ['/usr'], cwd: '/tmp/ol-build', env: { TEXINPUTS: '/tmp/ol-build:' } });
    expect(s.cmd).toBe('bwrap');
    const a = s.args;
    // the command comes last, after the separator
    expect(a.slice(-3)).toEqual(['--', 'latexmk', '-pdf', 'main.tex'].slice(-3));
    expect(a[a.indexOf('--') + 1]).toBe('latexmk');
    // system read-only, build dir read-write, no network / pids, clean environment
    if (process.getuid?.() === 0) {
      // as root: no user namespace (files owned by other users must stay readable), no capabilities but reading
      for (const f of ['--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts']) expect(a).toContain(f);
      expect(a.slice(a.indexOf('--cap-drop'), a.indexOf('--cap-drop') + 4)).toEqual(['--cap-drop', 'ALL', '--cap-add', 'CAP_DAC_READ_SEARCH']);
      expect(a).not.toContain('--unshare-user');
    } else expect(a).toContain('--unshare-all');
    expect(a).toContain('--clearenv');
    expect(a).toContain('--die-with-parent');
    const bind = a.indexOf('--bind', a.indexOf('--tmpfs'));
    expect(a.slice(bind, bind + 3).includes('/tmp/ol-build') || a.includes('/tmp/ol-build')).toBe(true);
    const rw = [] as string[];
    for (let i = 0; i < a.length; i++) if (a[i] === '--bind') rw.push(a[i + 1]);
    expect(rw).toContain('/tmp/ol-build');
    expect(rw.some(d => d === '/usr' || d === '/etc')).toBe(false);
    const env = [] as string[];
    for (let i = 0; i < a.length; i++) if (a[i] === '--setenv') env.push(a[i + 1]);
    expect(env).toContain('TEXINPUTS');
    expect(env).toContain('HOME');
  });

  it.skipIf(!haveBwrap)('really confines writes and the network', () => {
    const rwDir = mkdtempSync(join(tmpdir(), 'ol-sb-rw-'));
    const roDir = mkdtempSync(join(tmpdir(), 'ol-sb-ro-'));
    writeFileSync(join(roDir, 'secret.txt'), 'top secret');
    try {
      const script = `cat ${roDir}/secret.txt > ${rwDir}/copy.txt; echo x > ${roDir}/leak.txt 2>/dev/null && echo LEAKED || echo ro-ok; (test -e ${config.dataDir}/secret.key || test -e ${config.dataDir}/overlyx.sqlite) && echo DATA-VISIBLE || echo data-hidden; env | grep -q '^OL_SECRET=' && echo ENV-LEAKED || echo env-ok`;
      const s = sandboxed('sh', ['-c', script], { rw: [rwDir], ro: [roDir], cwd: rwDir, env: {} });
      const r = spawnSync(s.cmd, s.args, { env: { ...process.env, OL_SECRET: '1' }, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(readFileSync(join(rwDir, 'copy.txt'), 'utf8')).toBe('top secret');   // read-only binds are readable
      expect(r.stdout).toContain('ro-ok');                                          // ...but not writable
      expect(r.stdout).toContain('data-hidden');                                    // the server's secret / database are not mounted
      expect(r.stdout).toContain('env-ok');                                         // the server's environment is not passed on
      expect(existsSync(join(roDir, 'leak.txt'))).toBe(false);
    } finally {
      rmSync(rwDir, { recursive: true, force: true });
      rmSync(roDir, { recursive: true, force: true });
    }
  });
});
