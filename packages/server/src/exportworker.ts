/**
 * Worker thread running the LaTeX exporter (CPU-bound, up to a second for a long paper) so that
 * the main thread keeps serving WebSocket syncs and HTTP requests while a PDF is being built.
 * Child documents are resolved from the live copies the main thread hands over (open documents)
 * or parsed from disk.
 */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { parseLyx, type LyxDocument } from '@overlyx/core';

export interface ExportRequest {
  id: number;
  lyx: LyxDocument;
  docDir: string;
  projectDir: string;
  basename: string;
  layoutDir: string;
  /** live content of the project's open documents, by path relative to the project */
  openDocs: Record<string, LyxDocument>;
}
export interface ExportResponse {
  id: number;
  ok: boolean;
  error?: string;
  tex?: string;
  files?: Record<string, string>;
  graphics?: { src: string; dest: string }[];
  warnings?: string[];
}

type ExporterModule = {
  exportLatex: (doc: LyxDocument, opts: Record<string, unknown>) => { tex: string; files: Record<string, string>; graphics: { src: string; dest: string }[]; warnings: string[] };
};
let exporterPromise: Promise<ExporterModule> | null = null;
const exporter = () => (exporterPromise ??= import('@overlyx/core/latex/index.ts') as unknown as Promise<ExporterModule>);

parentPort!.on('message', async (req: ExportRequest) => {
  const reply = (r: Omit<ExportResponse, 'id'>) => parentPort!.postMessage({ id: req.id, ...r });
  try {
    const mod = await exporter();
    const resolveInclude = (fn: string): LyxDocument | undefined => {
      try {
        const abs = path.resolve(req.docDir, fn);
        if (!abs.startsWith(req.projectDir)) return undefined;
        const rel = path.relative(req.projectDir, abs);
        return req.openDocs[rel] ?? parseLyx(fs.readFileSync(abs, 'utf8'));
      } catch { return undefined; }
    };
    const res = mod.exportLatex(req.lyx, { resolveInclude, basename: req.basename, layoutDir: req.layoutDir, docDir: req.docDir });
    reply({ ok: true, tex: res.tex, files: res.files, graphics: res.graphics, warnings: res.warnings });
  } catch (e) {
    reply({ ok: false, error: String((e as Error)?.stack ?? e) });
  }
});
