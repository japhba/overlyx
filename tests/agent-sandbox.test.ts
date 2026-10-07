/**
 * The Agent panel's sandbox against the real codex (scripts/codex-sandbox-check.mts, which also
 * guards codex updates): a thread's commands see its own project and nothing else — no other
 * user's project, no OverLyX data, no way out of the sandbox, no project config codex would
 * trust. tests/agent.test.ts checks that the server asks codex for exactly this (with the stub);
 * this one checks that codex keeps to it. Skipped where codex is not installed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const codex = (() => { try { return execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 20000 }).trim(); } catch { return null; } })();

describe.skipIf(!codex)(`the Agent panel's sandbox, with the installed codex (${codex ?? 'none'})`, () => {
  it('keeps a thread to its own project and out of OverLyX, before and after a codex restart', () => {
    // its own process: the check points OverLyX's data and projects directories at a scratch tree before loading the server code
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/root', LANG: 'C.UTF-8', ...(process.env.OVERLYX_SCRATCH ? { OVERLYX_SCRATCH: process.env.OVERLYX_SCRATCH } : {}) };
    let out: string;
    try {
      out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/codex-sandbox-check.mts', 'codex'], { encoding: 'utf8', timeout: 150000, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`the sandbox check failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`);
    }
    expect(out).toContain('codex-sandbox-check: passed');
    expect(out).not.toContain('FAIL');
  }, 180000);
});
