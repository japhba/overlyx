/**
 * Create users with strong random passwords.
 *   npm run seed -- admin "Jan Bauer" kirsten "Kirsten Fischer" ...
 * With no arguments, creates an "admin" user (if missing). Passwords are printed once and
 * appended to <dataDir>/credentials.txt (mode 600).
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { config } from './config.ts';
import { createUser, generatePassword, hashPassword } from './auth.ts';

const args = process.argv.slice(2);
const pairs: [string, string][] = [];
if (!args.length) pairs.push(['admin', 'Admin']);
for (let i = 0; i < args.length; i += 2) pairs.push([args[i].toLowerCase(), args[i + 1] ?? args[i]]);

const credFile = path.join(config.dataDir, 'credentials.txt');
const lines: string[] = [];
for (const [username, name] of pairs) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  const password = generatePassword(22);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, display_name = ? WHERE id = ?').run(hashPassword(password), name, existing.id);
    lines.push(`${username}\t${password}\t(password reset)`);
  } else {
    const isAdmin = username === 'admin' || !(db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    createUser(username, name, password, { isAdmin });
    lines.push(`${username}\t${password}${isAdmin ? '\t(admin)' : ''}`);
  }
}
const stamp = new Date().toISOString();
fs.appendFileSync(credFile, `# ${stamp}\n${lines.join('\n')}\n`, { mode: 0o600 });
fs.chmodSync(credFile, 0o600);
console.log('Users created/updated (also saved to ' + credFile + '):\n');
console.log('username\tpassword');
for (const l of lines) console.log(l);
