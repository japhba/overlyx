/**
 * OverLyX never uses Apple's San Francisco fonts (SF Pro, SF Compact, SF Mono, SF Camera, New York),
 * nor the CSS keywords that resolve to them on Apple devices: Apple licenses them only for mock-ups of
 * Apple-platform software, so a document, deck, PDF or the editor set in one would break that licence
 * (the owner, 2 Nov 2026; CLAUDE.md "No San Francisco fonts"). This scans every source the app ships.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const FORBIDDEN = /-apple-system|BlinkMacSystemFont|\bsystem-ui\b|\bui-(?:sans-serif|serif|monospace|rounded)\b|\.?\bSF[ -](?:Pro|Compact|Mono|Camera|Arabic|Hebrew|Armenian|Georgian)\b|SFMono|SFNS|--sf-font|"New York"|'New York'/i;
/** lines that name the keywords only to recognise them, never to use them */
const ALLOWED = [/^const GENERIC = /];

describe('no San Francisco fonts', () => {
  it('no font stack names San Francisco or a keyword that resolves to it', () => {
    const files = execFileSync('git', ['ls-files', 'packages', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(f => /\.(ts|tsx|js|mjs|css|html|json)$/.test(f) && !/\/(node_modules|dist)\//.test(f));
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((raw, i) => {
        // embedded font data (base64) can spell a forbidden name by chance (e.g. "SFNS" inside DejaVu Sans' WOFF2)
        const line = raw.replace(/base64,[A-Za-z0-9+/=]+/g, 'base64,');
        if (FORBIDDEN.test(line) && !ALLOWED.some(a => a.test(line.trim()))) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
