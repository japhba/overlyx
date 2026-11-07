/**
 * A project's settings (Settings ▸ Project; core projectsettings.ts): `.overlyx/settings.json` in the
 * project, read and written here — checked both ways, so a file pushed by git or written by hand
 * gives only valid settings. Open editors are told when they change (the project's events, kind
 * `settings`); the git auto-commit takes the file like any other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_SETTINGS_FILE, projectSettingsOf, projectSettingsJson, type ProjectSettings } from '@overlyx/core/projectsettings.ts';
import { resolveProjectPath } from './projects.ts';

/** the file's size limit (a few text styles take a few kB) */
const MAX_BYTES = 64 * 1024;

/** told when a project's settings were written here (the events route) */
export const projectSettingsListeners = new Set<(project: string) => void>();

export function readProjectSettings(project: string): ProjectSettings {
  try {
    const abs = resolveProjectPath(project, PROJECT_SETTINGS_FILE);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return {};
    return projectSettingsOf(JSON.parse(fs.readFileSync(abs, 'utf8')));
  } catch { return {}; }
}

/** write what is valid of `settings` (nothing set: the file and an empty .overlyx folder go); returns what was kept */
export function writeProjectSettings(project: string, settings: unknown): ProjectSettings {
  const kept = projectSettingsOf(settings);
  const text = projectSettingsJson(kept);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('These project settings are too large');
  const abs = resolveProjectPath(project, PROJECT_SETTINGS_FILE);
  if (!text) {
    fs.rmSync(abs, { force: true });
    try { fs.rmdirSync(path.dirname(abs)); } catch { /* not empty, or not there */ }
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.overlyx-tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, abs);
  }
  for (const l of projectSettingsListeners) { try { l(project); } catch (e) { console.error('project settings listener failed', e); } }
  return kept;
}
