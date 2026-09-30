// Mint a SharedCut session for one account without its password, by writing the same row
// POST /api/auth/login writes (sha256(token) -> userId). Run it ON THE SERVER only; the cookie never leaves it.
//
//   node scripts/agent/agent-session.mjs <email> [days]     -> ~/sharedcut-agent/cookie.txt (mode 600)
//
// import-folder.mjs, build-timeline.mjs and create-project.mjs read that file when FRAME_LINE_COOKIE is unset.
// FRAME_LINE_DATA picks the data directory (default ./data). Revoke with POST /api/auth/logout, or let it expire.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const [email, daysArg = '7'] = process.argv.slice(2);
if (!email) throw new Error('Pass the account email.');
const days = Number(daysArg);
if (!(days > 0 && days <= 30)) throw new Error('Days must be between 1 and 30.');
const db = new DatabaseSync(join(resolve(process.env.FRAME_LINE_DATA ?? 'data'), 'frameline.sqlite'));
db.exec('PRAGMA busy_timeout=10000');
const account = db.prepare('SELECT id,email FROM accounts WHERE email=?').get(email.trim().toLowerCase());
if (!account) throw new Error(`No account ${email}.`);
const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + days * 86400_000;
db.prepare('INSERT INTO sessions(token,userId,expiresAt) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), account.id, expiresAt);
const dir = join(homedir(), 'sharedcut-agent');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, 'cookie.txt'), `frameline_session=${token}`, { mode: 0o600 });
console.log(`Session for ${account.email} written to ${join(dir, 'cookie.txt')}, expires ${new Date(expiresAt).toISOString()}`);
