/**
 * A document group's manifest (core/docgroup.ts) following its files when they are deleted or
 * renamed in the explorer: a renamed member keeps its place, title and level; one deleted, or moved
 * out of the group's folder, leaves the group. (Before, a deleted member stayed listed for good.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { GROUP_MANIFEST, parseDocGroup, writeDocGroup } from '@overlyx/core';
import { resolveProjectPath } from './projectfiles.ts';

export function groupFileMoved(projectKey: string, from: string, to: string | null): void {
  const dir = path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from);
  let manifestAbs: string;
  try { manifestAbs = resolveProjectPath(projectKey, path.posix.join(dir, GROUP_MANIFEST)); } catch { return; }
  if (!fs.existsSync(manifestAbs)) return;
  const text = fs.readFileSync(manifestAbs, 'utf8');
  const group = parseDocGroup(text);
  const name = path.posix.basename(from);
  if (!group || !group.members.some(m => m.file === name)) return;
  const toDir = to === null ? null : path.posix.dirname(to) === '.' ? '' : path.posix.dirname(to);
  const members = toDir === dir
    ? group.members.map(m => (m.file === name ? { ...m, file: path.posix.basename(to!) } : m))
    : group.members.filter(m => m.file !== name);
  const next = writeDocGroup({ ...group, members });
  if (next !== text) fs.writeFileSync(manifestAbs, next, 'utf8');
}
