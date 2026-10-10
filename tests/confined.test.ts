/**
 * confined.ts: reading, writing and serving files below a directory that untrusted code controls
 * (a build directory, the agent's working copy). A symlink planted there — the attack behind the
 * two critical pre-beta findings — must never be followed out: the server runs as root, so following
 * one would read or overwrite any file on the host.
 *   npx vitest run tests/confined.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFileIn, readTextIn, writeFileIn, symlinkIn, removeIn, lstatIn, readlinkIn, listIn, isRegularFileAt, readFileAt,
} from '../packages/server/src/confined.ts';

const BASE = mkdtempSync(join(tmpdir(), 'overlyx-confined-'));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

let root: string;
let secret: string;        // a host file outside the root, standing in for /etc/shadow or secrets.env
let n = 0;
beforeEach(() => {
  root = join(BASE, `root-${n++}`);
  mkdirSync(root, { recursive: true });
  secret = join(BASE, `secret-${n}`);
  writeFileSync(secret, 'TOP SECRET');
});

describe('reads never follow a planted symlink', () => {
  it('a link to a host file reads as absent', () => {
    symlinkSync(secret, join(root, 'x.pdf'));
    expect(readFileIn(root, 'x.pdf')).toBeNull();
    expect(readTextIn(root, 'x.pdf')).toBeNull();
    expect(isRegularFileAt(join(root, 'x.pdf'))).toBe(false);
    // the real contents of a regular file are still read
    writeFileSync(join(root, 'real.txt'), 'hello');
    expect(readTextIn(root, 'real.txt')).toBe('hello');
  });

  it('a link as a directory on the path is not followed (symlinked ancestor)', () => {
    symlinkSync(join(BASE), join(root, 'up'));   // root/up -> BASE
    // root/up/secret-... would be the host file if the link were followed
    expect(readFileIn(root, join('up', `secret-${n}`))).toBeNull();
    expect(lstatIn(root, join('up', 'anything'))).toBeNull();
  });

  it('readlinkIn / lstatIn report a link as the link itself', () => {
    symlinkSync(secret, join(root, 'l'));
    expect(readlinkIn(root, 'l')).toBe(secret);
    expect(lstatIn(root, 'l')!.isSymbolicLink()).toBe(true);
  });

  it('a path with .. is refused', () => {
    expect(() => readFileIn(root, '../secret')).toThrow();
    expect(() => writeFileIn(root, '../evil', 'x')).toThrow();
  });
});

describe('writes replace a planted link instead of writing through it', () => {
  it('a link where the file goes: the target is untouched, a real file takes its place', () => {
    symlinkSync(secret, join(root, 'out.tex'));
    writeFileIn(root, 'out.tex', 'NEW');
    expect(readFileSync(secret, 'utf8')).toBe('TOP SECRET');          // not overwritten
    expect(lstatSync(join(root, 'out.tex')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, 'out.tex'), 'utf8')).toBe('NEW');
  });

  it('a link as a directory on the path: the write does not escape the root', () => {
    const outside = join(BASE, `outside-${n}`);
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'sub'));       // root/sub -> outside
    writeFileIn(root, join('sub', 'f.txt'), 'DATA');
    // the link was replaced by a real directory; nothing was written into `outside`
    expect(lstatSync(join(root, 'sub')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(outside, 'f.txt'))).toBe(false);
    expect(readFileSync(join(root, 'sub', 'f.txt'), 'utf8')).toBe('DATA');
  });

  it('symlinkIn replaces whatever is there', () => {
    writeFileSync(join(root, 'a'), 'x');
    symlinkIn(root, 'a', '/target');
    expect(lstatSync(join(root, 'a')).isSymbolicLink()).toBe(true);
    expect(readlinkIn(root, 'a')).toBe('/target');
  });
});

describe('removeIn', () => {
  it('removes a link without touching its target, and a tree with a FIFO in it', () => {
    symlinkSync(secret, join(root, 'l'));
    removeIn(root, 'l');
    expect(existsSync(join(root, 'l'))).toBe(false);
    expect(readFileSync(secret, 'utf8')).toBe('TOP SECRET');
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'f'), 'x');
    spawnSync('mkfifo', [join(root, 'd', 'pipe')]);   // a non-regular file the sweep/remove must still clear
    removeIn(root, 'd');
    expect(existsSync(join(root, 'd'))).toBe(false);
  });
});

describe('listIn', () => {
  it('lists a real directory and refuses a symlinked one', () => {
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'a'), '1');
    writeFileSync(join(root, 'd', 'b'), '2');
    expect(listIn(root, 'd').sort()).toEqual(['a', 'b']);
    symlinkSync(BASE, join(root, 'link'));
    expect(listIn(root, 'link')).toEqual([]);
  });
});

describe('readFileAt by full path', () => {
  it('reads a regular file and rejects a link', () => {
    writeFileSync(join(root, 'f'), 'ok');
    expect(readFileAt(join(root, 'f'))!.toString()).toBe('ok');
    symlinkSync(secret, join(root, 'g'));
    expect(readFileAt(join(root, 'g'))).toBeNull();
  });
});
