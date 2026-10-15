/** A disposable, accepted-view DOCX for the first Google Docs import only. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paramMap, unquote, type LyxDocument, type Paragraph } from '@overlyx/core';
import { writeMarkdown } from '@overlyx/core/md/index.ts';
import { config } from '../config.ts';
import { resolveProjectPath } from '../projectfiles.ts';
import { sandboxed } from '../sandbox.ts';
import { toPng } from '../graphics.ts';
import { project, toParagraphs } from './model.ts';

const exec = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;

export async function buildDocx(doc: LyxDocument, projectId: string, relPath: string): Promise<Buffer> {
  const projection = project(doc, true);
  const copy = { ...doc, body: toParagraphs(projection.blocks, projection.headings, true) };
  const dir = await fs.mkdtemp(path.join(config.dataDir, 'cache', 'gdocs-docx-'));
  try {
    let image = 0, total = 0;
    const copyImages = async (paragraphs: Paragraph[]) => {
      for (const p of paragraphs) for (const item of p.items) {
        if (item.kind !== 'inset') continue;
        const ins = item.inset;
        if (ins.type === 'Leaf' && ins.name === 'Graphics') {
          const filename = unquote(paramMap(ins.params).get('filename'));
          if (/^[a-z]+:/i.test(filename) || path.isAbsolute(filename)) throw new Error('Google Docs export needs images stored inside the project: ' + filename);
          const src = resolveProjectPath(projectId, path.posix.join(path.posix.dirname(relPath), filename));
          const stat = await fs.stat(src);
          total += stat.size;
          if (!stat.isFile() || stat.size > MAX_BYTES || total > 2 * MAX_BYTES) throw new Error('The images are too large for Google Docs export.');
          const direct = /\.(png|jpe?g|gif)$/i.test(src);
          const local = direct ? src : await toPng(src, 1800);
          const name = 'image-' + image++ + (direct ? path.extname(src).toLowerCase() : '.png');
          await fs.copyFile(local, path.join(dir, name));
          ins.params = ins.params.map(p => /^\s*filename\s/.test(p) ? '\tfilename ' + name : p);
        } else if (ins.type === 'Text') await copyImages(ins.paragraphs);
        else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) await copyImages(c.paragraphs);
      }
    };
    await copyImages(copy.body);
    const markdown = writeMarkdown(copy);
    await fs.writeFile(path.join(dir, 'document.md'), markdown.text);
    const binary = config.pandocBin;
    const cmd = sandboxed(binary, ['document.md', '--from=commonmark+tex_math_dollars+footnotes+pipe_tables+strikeout', '--to=docx', '--fail-if-warnings', '--resource-path=.', '--output=document.docx'], {
      rw: [dir], ro: path.isAbsolute(binary) ? [path.dirname(binary)] : [], cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, home: false,
    });
    try {
      await exec(cmd.cmd, cmd.args, { cwd: dir, env: cmd.env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    } catch (e) {
      const error = e as Error & { stderr?: string; code?: string };
      const detail = (error.stderr || error.message).slice(0, 1500);
      const missing = error.code === 'ENOENT' || /pandoc.*(?:No such file|not found)/i.test(detail);
      throw new Error('Could not create the Google Docs export. ' + (missing ? 'Install Pandoc on the server (or set OVERLYX_PANDOC_BIN). ' : '') + detail);
    }
    const stat = await fs.stat(path.join(dir, 'document.docx'));
    if (stat.size > MAX_BYTES) throw new Error('The DOCX export is too large for Google Docs (50 MB maximum).');
    return await fs.readFile(path.join(dir, 'document.docx'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
