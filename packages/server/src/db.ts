import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.ts';

export const db = new Database(path.join(config.dataDir, 'overlyx.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  color TEXT NOT NULL,
  email TEXT,
  google_sub TEXT UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ydocs (
  id TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  file_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lyx TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_doc ON versions(doc_id, created_at);
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  title TEXT,
  owner_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'project',
  link_token TEXT UNIQUE,
  link_role TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  user_id INTEGER,
  email TEXT,
  role TEXT NOT NULL,
  via TEXT NOT NULL,
  added_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS project_members_user ON project_members(project, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_members_email ON project_members(project, email) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS git_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS builds (
  doc_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  log TEXT NOT NULL,
  pdf_path TEXT,
  tex_path TEXT,
  updated_at INTEGER NOT NULL
);
`);

// documents get an "epoch" (random id of their Yjs history); clients holding a different epoch are stale
try { db.exec('ALTER TABLE ydocs ADD COLUMN epoch TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE builds ADD COLUMN warnings TEXT'); } catch { /* column exists */ }

/** A project = a directory under the projects root; rows hold ownership and sharing (see access.ts). */
export interface ProjectRow {
  name: string; title: string | null; owner_id: number | null;
  /** 'project' | 'example' (the personal welcome project) | 'example-gone' (deleted by its owner: not re-created) */
  kind: string;
  link_token: string | null; link_role: string | null; created_at: number;
}
export interface MemberRow {
  id: number; project: string; user_id: number | null; email: string | null; role: string;
  /** 'user' (added by name) | 'email' (invited by e-mail) | 'link' (joined through the share link) */
  via: string; added_by: number | null; created_at: number;
}

export interface UserRow {
  id: number; username: string; display_name: string; password_hash: string | null; color: string;
  email: string | null; google_sub: string | null; is_admin: number; created_at: number; avatar_url?: string | null;
}

export const USER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324', '#800000', '#aaffc3', '#808000', '#000075'];

export function pickColor(): string {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  return USER_COLORS[n % USER_COLORS.length];
}
