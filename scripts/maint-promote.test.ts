import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseVerdict, trustedKeys } from './maint-promote.ts';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'maint-promote.ts');
const ident = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@localhost', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ident } }).trim();

test('verdicts: only an explicit pass without concerns passes', () => {
  assert.deepEqual(parseVerdict('{"verdict":"pass","concerns":[]}'), { pass: true, concerns: [] });
  assert.equal(parseVerdict('Sure! {"verdict": "pass", "concerns": ["sends the token out"]}').pass, false);
  assert.equal(parseVerdict('{"verdict":"hold","concerns":["x"]}').pass, false);
  assert.equal(parseVerdict('looks fine to me').pass, false);
  assert.deepEqual([...trustedKeys('{"signals":[{"key":"issue:1","trusted":true},{"key":"report:2","trusted":false},{"key":"x","trusted":"yes"}]}')], ['issue:1']);
});

test('trusted, rule-abiding, reviewed fixes reach master; everything else waits in the queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-promote-'));
  try {
    const origin = path.join(dir, 'origin.git'), dev = path.join(dir, 'dev'), outbox = path.join(dir, 'outbox'), inbox = path.join(dir, 'inbox'), work = path.join(dir, 'work');
    git(dir, 'init', '--quiet', '--bare', '-b', 'master', origin);
    git(dir, 'clone', '--quiet', origin, dev);
    for (const [f, text] of [['packages/core/src/a.ts', 'export const a = 1;\n'], ['packages/core/src/b.ts', 'export const b = 1;\n'], ['package.json', '{}\n']] as const) {
      fs.mkdirSync(path.dirname(path.join(dev, f)), { recursive: true }); fs.writeFileSync(path.join(dev, f), text);
    }
    git(dev, 'add', '-A'); git(dev, 'commit', '--quiet', '-m', 'start'); git(dev, 'push', '--quiet', 'origin', 'HEAD:master');
    const base = git(dev, 'rev-parse', 'HEAD');
    fs.mkdirSync(outbox); fs.mkdirSync(inbox);
    const entry = (id: string, key: string, trusted: boolean, file: string, text: string) => {
      fs.writeFileSync(path.join(dev, file), text);
      git(dev, 'commit', '--quiet', '-am', `Fix ${id}\n\nMaintenance-signal: ${key}\nDeploy: no-checks`);
      const patch = git(dev, 'format-patch', '-1', '--stdout', 'HEAD');
      git(dev, 'reset', '--quiet', '--hard', base);
      fs.writeFileSync(path.join(outbox, `${id}.json`), JSON.stringify({ id, created: 1, base, signal: { key, kind: key.split(':')[0], trusted }, summary: `fix ${id}`, checks: [], patch }));
    };
    entry('1-good', 'issue:1', true, 'packages/core/src/a.ts', 'export const a = 2;\n');
    entry('2-outsider', 'report:2', false, 'packages/core/src/b.ts', 'export const b = 2;\n');
    entry('3-claims-trust', 'report:3', true, 'packages/core/src/b.ts', 'export const b = 3;\n');
    entry('4-dependency', 'issue:4', true, 'package.json', '{"dependencies":{"x":"1"}}\n');
    entry('5-held', 'issue:5', true, 'packages/core/src/b.ts', 'export const b = 5; // HOLDME\n');
    fs.writeFileSync(path.join(inbox, 'signals.json'), JSON.stringify({ at: 1, signals: ['issue:1', 'issue:4', 'issue:5'].map(key => ({ key, trusted: true })).concat([{ key: 'report:3', trusted: false } as any]) }));
    fs.writeFileSync(path.join(outbox, 'junk.json'), '{"id":"other"}');

    const reviewed: string[] = [];
    const reviewer = http.createServer((req, res) => {
      let body = ''; req.on('data', d => body += d); req.on('end', () => {
        const diff = JSON.parse(body).messages[1].content as string;
        reviewed.push(diff);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: diff.includes('HOLDME') ? '{"verdict":"hold","concerns":["odd marker"]}' : '{"verdict":"pass","concerns":[]}' } }] }));
      });
    });
    await new Promise<void>(r => reviewer.listen(0, '127.0.0.1', r));
    const port = (reviewer.address() as any).port;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, ...ident, OVERLYX_MAINT_WORKER: '', OVERLYX_MAINT_OUTBOX: outbox,
        OVERLYX_MAINTENANCE_INBOX: inbox, OVERLYX_MAINT_PROMOTE_DIR: work, OVERLYX_MAINT_PROMOTE_ORIGIN: origin, OVERLYX_MAINT_QUEUE_REPO: '',
        OPENROUTER_API_KEY: 'test', OPENROUTER_API_URL: `http://127.0.0.1:${port}` } });
      let text = ''; child.stdout.on('data', d => text += d); child.stderr.on('data', d => text += d);
      child.once('exit', code => code === 0 ? resolve(text) : reject(new Error(text)));
    });
    reviewer.close();

    const log = git(origin, 'log', '--format=%s', 'master');
    assert.deepEqual(log.split('\n'), ['Fix 1-good', 'start'], out);
    assert.equal(git(origin, 'show', 'master:packages/core/src/a.ts'), 'export const a = 2;');
    const queued = fs.readdirSync(path.join(work, 'queue')).sort();
    assert.deepEqual(queued, ['2-outsider.json', '3-claims-trust.json', '4-dependency.json', '5-held.json']);
    const why = (id: string) => JSON.parse(fs.readFileSync(path.join(work, 'queue', `${id}.json`), 'utf8')).why.join('\n');
    assert.match(why('2-outsider'), /from outside/);
    assert.match(why('3-claims-trust'), /not trusted evidence in root's record/);
    assert.match(why('4-dependency'), /package\.json/);
    assert.match(why('5-held'), /reviewer: odd marker/);
    // only what passed the rules reached the reviewer: 1 and 5
    assert.equal(reviewed.length, 2);
    // handled entries leave the outbox, the malformed one too
    assert.deepEqual(fs.readdirSync(outbox), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
