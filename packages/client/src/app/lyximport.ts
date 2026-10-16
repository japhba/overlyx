import { api, type LyxImportResult } from '../api';
import { uiAlert } from './Dialogs';

/** File ▸ Import and the file tree use the same picker and collision-safe project import. */
export function chooseLyxImport(project: string, dir: string, imported: (r: LyxImportResult) => void): void {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.lyx,.zip,application/zip';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const r = await api.uploadLyx(project, file, dir);
      imported(r);
      if (r.warnings.length) await uiAlert('Imported with Warnings', r.warnings.slice(0, 10).join('\n'));
    } catch (e) { await uiAlert('LyX Import Failed', (e as Error).message); }
  };
  input.click();
}
