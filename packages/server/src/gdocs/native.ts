/** Bind opaque Docs equations and inline images to their source using moving named ranges. */
import crypto from 'node:crypto';
import { blockRuns, type DocsDocument, type DocsParagraphElement, type DocsStructural, type GBlock, type NativeSource } from './model.ts';
import type { Request } from './edits.ts';

export type ObjectBindings = Record<string, NativeSource>;

export function nativeElements(doc: DocsDocument): DocsParagraphElement[] {
  const out: DocsParagraphElement[] = [];
  const walk = (content: DocsStructural[]) => {
    for (const s of content) {
      if (s.paragraph) out.push(...s.paragraph.elements.filter(e => e.equation || e.inlineObjectElement));
      if (s.table) for (const r of s.table.tableRows) for (const c of r.tableCells) walk(c.content);
    }
  };
  walk(doc.body.content);
  return out;
}

/** Refuse to guess when conversion changed the object count or sequence of object types. */
export function bindImportedObjects(raw: DocsDocument, blocks: GBlock[]): { bindings: ObjectBindings; requests: Request[] } {
  const sources = blocks.flatMap(blockRuns).flatMap(r => r.native && r.native.kind !== 'unknown' ? [r.native] : []);
  const elements = nativeElements(raw);
  if (sources.length !== elements.length || sources.some((s, i) => s.kind !== (elements[i].equation ? 'equation' : 'image'))) {
    throw new Error('Google Docs conversion changed the images or equations. The imported Google Doc was left unlinked; check the export before trying again.');
  }
  const bindings: ObjectBindings = {}, requests: Request[] = [];
  sources.forEach((source, i) => {
    const name = 'overlyx-object-' + crypto.randomUUID();
    bindings[name] = source;
    requests.push({ createNamedRange: { name, range: { startIndex: elements[i].startIndex, endIndex: elements[i].endIndex } } });
  });
  return { bindings, requests };
}

export function attachObjectSources(raw: DocsDocument, bindings: ObjectBindings): DocsDocument {
  const elements = nativeElements(raw), objectSources: Record<number, NativeSource> = {};
  for (const [name, source] of Object.entries(bindings)) {
    const ranges = raw.namedRanges?.[name]?.namedRanges.flatMap(n => n.ranges) ?? [];
    // Boundary insertions can expand a named range. Accept it only while it contains exactly one
    // object of the expected kind, and never assign two sources to the same object.
    const matches = elements.filter(e => ranges.some(r => r.startIndex <= e.startIndex && r.endIndex >= e.endIndex));
    if (matches.length !== 1) continue;
    const el = matches[0];
    if (source.kind !== (el.equation ? 'equation' : 'image')) continue;
    if (objectSources[el.startIndex]) throw new Error('Google Docs object ranges overlap; sync stopped to preserve the objects.');
    objectSources[el.startIndex] = source;
  }
  return { ...raw, objectSources };
}
