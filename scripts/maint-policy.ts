/**
 * What an unattended maintenance fix may change before it goes live without the owner looking at it
 * (scripts/maint-promote.ts, run as root after each worker run). Fixed rules, not a model: a diff
 * cannot talk its way past them. A reason here sends the fix to the owner's queue instead; nothing is
 * thrown away. The rules are deliberately narrow — application code and its unit tests — and the
 * reviewer model (maint-promote.ts) looks at what passes them.
 */

// application code and its tests: where an ordinary bug fix lands
// (and DOCS.md, which most fixes update — AGENTS.md / CLAUDE.md, the agents' instructions, are not)
const AUTO_PATHS = [/^packages\/(client|core|server)\/src\//, /^tests\/[\w.-]+\.test\.tsx?$/, /^DOCS\.md$/];
// ...but not the code that guards accounts, access, secrets and sandboxes, nor the reports, logs and
// telemetry the worker itself is fed (a fix there could widen what reaches it)
const GUARDED = new RegExp('^packages/server/src/(' + [
  'access', 'accounts', 'agentkeys', 'agentnet', 'agentusers', 'agentwork', 'agent', 'auth', 'cliLogin', 'config',
  'confined', 'credentialScope', 'db', 'feedback', 'fetchbox', 'git', 'index', 'mailer', 'mailin', 'mcp',
  'mcpAgents', 'mcpOauth', 'mcpTokens', 'mirror', 'netguard', 'privacy', 'sandbox', 'sealed', 'security',
  'selfcheck', 'terms', 'tokenAuth', 'usage', 'usageReport', 'ws',
].join('|') + ')\\.ts$|^packages/server/src/e2e/|^packages/client/src/(e2e/|sw\\.js$|error-reporting\\.ts$|usage\\.ts$)|^packages/core/src/usagePayload\\.ts$');

// added lines that do what a bug fix rarely needs and an injected change usually does
const RISKY: [RegExp, string][] = [
  [/\bchild_process\b|(?<![.\w])(execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/, 'runs programs'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'evaluates code from text'],
  [/\bimport\s*\(\s*[^'"\s)]/, 'imports a computed module'],
  [/\bprocess\.env\b/, 'reads the environment'],
  // (but this site, reserved names nobody can host, XML namespaces and the Google Fonts OverLyX uses)
  [/https?:\/\/(?!(?:[\w-]+\.)*(?:overlyx\.app|localhost|127\.0\.0\.1|example\.(?:com|org|net)|[\w-]+\.(?:test|invalid|example|localhost)|www\.w3\.org|fonts\.(?:googleapis|gstatic)\.com)(?![\w.-]))/i, 'names an outside address'],
  [/\bsendBeacon\b|\bXMLHttpRequest\b|\bnew\s+WebSocket\s*\(|\bnet\.(connect|createConnection)\b|\b(dgram|tls)\./, 'opens a connection'],
  [/\batob\s*\(|\bfromCharCode\b|Buffer\.from\([^)]*['"](base64|hex)['"]/, 'decodes hidden text'],
  [/[A-Za-z0-9+/=_-]{160,}/, 'carries an encoded blob'],
  [/(\\x[0-9a-f]{2}){6,}|(\\u[0-9a-f]{4}){6,}/i, 'carries escaped text'],
  [/\b(authorized_keys|id_ed25519|id_rsa|known_hosts|auth\.json|secrets\.env|sealing\.key)\b|\/etc\/(passwd|shadow|sudoers)|\/root\b|\.ssh\//, 'names credentials or system files'],
  [/\b(chmod|chown|setuid|setgid|setpriv|sudo)\b/, 'changes permissions'],
  [/\b(ignore|disregard)\b.{0,40}\b(instruction|rule|reviewer|previous)/i, 'addresses a reviewer'],
];

// what a key or token looks like; the worker checks before handing a fix over, root again after
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bssh-(ed25519|rsa) AAAA/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_\w{20,}/,
  /\bsk-(?:or-v1-|ant-|proj-)?[\w-]{20,}/, /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, /"(refresh|access|id)_token"\s*:/,
];

const MAX_FILES = 25;
const MAX_LINES = 800;

export function addedLines(patch: string): string[] {
  return patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++ ')).map(l => l.slice(1));
}

export function secretReasons(patch: string): string[] {
  return addedLines(patch).some(l => SECRETS.some(re => re.test(l))) ? ['adds something that looks like a key or token'] : [];
}

/**
 * Why a change must wait for the owner — empty when it may go on to the reviewer. Takes git's own
 * views of one commit: `diff --name-status -M`, `--numstat -M`, `--summary` and the patch.
 */
export function policyReasons(nameStatus: string, numstat: string, summary: string, patch: string): string[] {
  const reasons = new Set<string>();
  const paths = nameStatus.split('\n').filter(Boolean).flatMap(l => l.split('\t').slice(1));
  if (!paths.length) reasons.add('changes nothing');
  for (const p of paths) {
    if (!AUTO_PATHS.some(re => re.test(p))) reasons.add(`touches ${p} (outside application code and tests)`);
    else if (GUARDED.test(p)) reasons.add(`touches ${p} (guards access, secrets or the worker's own inputs)`);
  }
  let lines = 0;
  const rows = numstat.split('\n').filter(Boolean);
  for (const row of rows) {
    const [a, d] = row.split('\t');
    if (a === '-' || d === '-') reasons.add('changes a binary file');
    else lines += Number(a) + Number(d);
  }
  if (rows.length > MAX_FILES) reasons.add(`changes ${rows.length} files (more than ${MAX_FILES})`);
  if (lines > MAX_LINES) reasons.add(`changes ${lines} lines (more than ${MAX_LINES})`);
  if (/\bmode 120000\b/.test(summary)) reasons.add('adds a symbolic link');
  if (/\bmode (change \d+ => )?100755\b/.test(summary)) reasons.add('makes a file executable');
  for (const r of secretReasons(patch)) reasons.add(r);
  const added = addedLines(patch);
  for (const [re, why] of RISKY) {
    const line = added.find(l => re.test(l));
    if (line !== undefined) reasons.add(`${why}: ${line.trim().slice(0, 120)}`);
  }
  return [...reasons];
}
