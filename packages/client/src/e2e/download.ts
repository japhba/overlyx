/**
 * An end-to-end encrypted project downloaded as a .zip, made in this browser (the project card's
 * Download): its documents as their .tex / .md text, its other files as they are.
 */
import { openE2eProject } from './project';
import { makeZip } from './zip';
import { projectShortName } from '@overlyx/core';

export async function downloadProjectZip(project: string): Promise<void> {
  const p = await openE2eProject(project);
  const files: { path: string; data: Uint8Array; mtime?: number }[] = [];
  for (const path of p.paths()) {
    const e = p.entry(path);
    if (!e) continue;
    if (e.kind === 'dir') files.push({ path: path + '/', data: new Uint8Array(0), mtime: e.mtime });
    else files.push({ path, data: await p.readFile(path), mtime: e.mtime });
  }
  const blob = await makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = projectShortName(project) + '.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
