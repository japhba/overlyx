/** The extension's self-update logic (pure part — no VS Code): version compare and release parsing. */
import { describe, it, expect } from 'vitest';
import { parseVersion, isNewer, releaseFromGithub, latestReleaseUrl } from '../packages/vscode/src/host/updateCheck.ts';

describe('vscode self-update logic', () => {
  it('parses versions, with and without the v prefix', () => {
    expect(parseVersion('0.2.0')).toEqual([0, 2, 0]);
    expect(parseVersion('v1.10.3')).toEqual([1, 10, 3]);
    expect(parseVersion('main')).toBeNull();
  });

  it('compares versions numerically, not lexically', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);   // 10 > 9 even though '1' < '9'
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0', '0.2.1')).toBe(false);
    expect(isNewer('nonsense', '0.1.0')).toBe(false);
  });

  it('reads a GitHub latest-release payload and picks the vsix asset', () => {
    const rel = releaseFromGithub({
      tag_name: 'v0.3.0', html_url: 'https://github.com/x/y/releases/v0.3.0', body: 'notes',
      assets: [
        { name: 'checksums.txt', browser_download_url: 'https://dl/x.txt' },
        { name: 'overlyx-vscode-0.3.0.vsix', browser_download_url: 'https://dl/x.vsix' },
      ],
    });
    expect(rel).toEqual({ version: '0.3.0', url: 'https://github.com/x/y/releases/v0.3.0', vsixUrl: 'https://dl/x.vsix', notes: 'notes' });
  });

  it('rejects releases without a vsix or with unparsable tags', () => {
    expect(releaseFromGithub({ tag_name: 'v0.3.0', assets: [] })).toBeNull();
    expect(releaseFromGithub({ tag_name: 'nightly', assets: [{ name: 'a.vsix', browser_download_url: 'u' }] })).toBeNull();
    expect(releaseFromGithub(null)).toBeNull();
  });

  it('builds the endpoint from the repo, unless overridden', () => {
    expect(latestReleaseUrl('japhba/overlyx-vscode')).toBe('https://api.github.com/repos/japhba/overlyx-vscode/releases/latest');
    expect(latestReleaseUrl('japhba/overlyx-vscode', 'http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9/x');
  });
});
