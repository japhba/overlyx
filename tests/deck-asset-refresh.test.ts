// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { mapAssets, mappedAttribute, restoreMappedAssets, setMappedAttribute } from '../packages/client/src/deliverable/offlineassets';

// Exercise the actual runtime implementation, not a copied refresh algorithm.
const sourceFile = new FileURL('../packages/client/src/deliverable/runtime/index.ts', import.meta.url);
const source = readFileSync(sourceFile, 'utf8');
const ast = ts.createSourceFile(sourceFile.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'refreshAsset');
if (declarations.length !== 1) throw new Error('Expected one actual refreshAsset declaration');
const runtimeCode = ts.transpileModule(source.slice(declarations[0].getStart(ast), declarations[0].end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const BASE = 'https://editor.invalid/ol-d/FAKE/slides/nested/';
const IMAGE = 'data:image/png;base64,RkFLRQ==';
const NEW_IMAGE = 'data:image/png;base64,TkVX';
const CSS = 'data:text/css;charset=utf-8,body%7Bcolor%3Ablue%7D';
const SCRIPT = 'data:text/javascript;charset=utf-8,void%200';
const absolute = (path: string) => new URL(path, BASE).href;

function setup(html: string, resources: string[] = []) {
  const doc = document.implementation.createHTMLDocument('Illustrative deck');
  const base = doc.createElement('base'); base.href = BASE; doc.head.append(base);
  doc.body.innerHTML = html;
  const reload = vi.fn(), resourceEntries = vi.fn(() => resources.map(name => ({ name })));
  const context = createContext({
    document: doc, URL, mappedAttribute, setMappedAttribute,
    // Offline frames have a different location; relative source belongs to the
    // deliverable's folder base, not /_ol/offline-frame.html.
    location: { href: 'https://editor.invalid/_ol/offline-frame.html?ol=edit', reload },
    performance: { getEntriesByType: resourceEntries },
  });
  runInContext(runtimeCode, context);
  const refresh = runInContext('refreshAsset', context) as (path: string, version: number) => void;
  const map = (assets: Record<string, string>) => mapAssets(doc.documentElement, assets, doc.baseURI);
  const canonical = () => {
    const clone = doc.documentElement.cloneNode(true) as Element;
    restoreMappedAssets(clone, doc.documentElement);
    return clone.querySelector('body')!.innerHTML;
  };
  return { doc, reload, resourceEntries, refresh, map, canonical };
}

describe('deliverable asset refresh preserves in-place editing', () => {
  it('refreshes a normal image on the same DOM node without adding cache keys to canonical source', () => {
    const state = setup('<img src="images/dot.png" alt="Illustrative image">');
    const image = state.doc.querySelector('img')!, original = state.canonical();
    state.refresh('images/dot.png', 7);
    expect(state.doc.querySelector('img')).toBe(image);
    expect(image.getAttribute('src')).toBe(absolute('images/dot.png?olv=7'));
    expect(state.canonical()).toBe(original);
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('recognizes a cached image before the historical resource fallback and survives the next assets update', () => {
    const state = setup('<img src="images/dot.png">', [absolute('images/dot.png')]);
    const image = state.doc.querySelector('img')!, selected = [image], original = state.canonical();
    state.map({ [absolute('images/dot.png')]: IMAGE });
    expect(image.getAttribute('src')).toBe(IMAGE);
    state.refresh('images/dot.png', 7);
    expect(state.doc.querySelector('img')).toBe(selected[0]);
    expect(state.doc.documentElement.contains(selected[0])).toBe(true);
    expect(image.getAttribute('src')).toBe(absolute('images/dot.png?olv=7'));
    expect(state.reload).not.toHaveBeenCalled();
    expect(state.resourceEntries).not.toHaveBeenCalled();
    expect(state.canonical()).toBe(original);
    state.map({ [absolute('images/dot.png')]: NEW_IMAGE });
    expect(image.getAttribute('src')).toBe(NEW_IMAGE);
    expect(state.canonical()).toBe(original);
    expect(state.doc.querySelector('img')).toBe(image);
  });

  it('distinguishes two canonical images with identical cached bytes rather than reverse-matching data URLs', () => {
    const state = setup('<img src="images/one.png"><img src="images/two.png">');
    const images = [...state.doc.querySelectorAll('img')], original = state.canonical();
    state.map({ [absolute('images/one.png')]: IMAGE, [absolute('images/two.png')]: IMAGE });
    state.refresh('images/two.png', 8);
    expect(images[0].getAttribute('src')).toBe(IMAGE);
    expect(images[1].getAttribute('src')).toBe(absolute('images/two.png?olv=8'));
    expect(state.canonical()).toBe(original);
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('uses the first canonical source across repeated refreshes, preserving query parameters and fragments', () => {
    const state = setup('<img src="images/dot.png?theme=dark#detail">');
    const image = state.doc.querySelector('img')!, original = state.canonical();
    state.map({ [absolute('images/dot.png?theme=dark#detail')]: IMAGE });
    state.refresh('images/dot.png', 7); state.refresh('images/dot.png', 8);
    expect(image.getAttribute('src')).toBe(absolute('images/dot.png?theme=dark&olv=8#detail'));
    expect(state.canonical()).toBe(original);
    expect(mappedAttribute(image, 'src')).toBe('images/dot.png?theme=dark#detail');
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('respects a later author or script edit instead of refreshing stale mapped provenance', () => {
    const state = setup('<img src="images/dot.png">');
    const image = state.doc.querySelector('img')!;
    state.map({ [absolute('images/dot.png')]: IMAGE });
    image.setAttribute('src', 'images/user-choice.png');
    expect(mappedAttribute(image, 'src')).toBe('images/user-choice.png');
    state.refresh('images/dot.png', 7);
    expect(image.getAttribute('src')).toBe('images/user-choice.png');
    state.refresh('images/user-choice.png', 8);
    expect(image.getAttribute('src')).toBe(absolute('images/user-choice.png?olv=8'));
    expect(state.canonical()).toBe('<img src="images/user-choice.png">');
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('does not restore an attribute removed after mapping', () => {
    const state = setup('<img src="images/dot.png">');
    const image = state.doc.querySelector('img')!;
    state.map({ [absolute('images/dot.png')]: IMAGE }); image.removeAttribute('src');
    expect(mappedAttribute(image, 'src')).toBeNull();
    state.refresh('images/dot.png', 7);
    expect(image.hasAttribute('src')).toBe(false);
    expect(state.canonical()).toBe('<img>');
    expect(state.reload).not.toHaveBeenCalled();
  });

  it.each([false, true])('refreshes a stylesheet in place and preserves canonical href (cached=%s)', cached => {
    const state = setup('<link rel="stylesheet" href="theme.css">', [absolute('theme.css')]);
    const link = state.doc.querySelector('link[rel="stylesheet"]')!, original = state.canonical();
    if (cached) state.map({ [absolute('theme.css')]: CSS });
    state.refresh('theme.css', 11);
    expect(state.doc.querySelector('link[rel="stylesheet"]')).toBe(link);
    expect(link.getAttribute('href')).toBe(absolute('theme.css?olv=11'));
    expect(state.canonical()).toBe(original);
    expect(state.reload).not.toHaveBeenCalled();
    state.map({ [absolute('theme.css')]: CSS });
    expect(link.getAttribute('href')).toBe(CSS);
    expect(state.canonical()).toBe(original);
  });

  it.each([false, true])('still reloads for a changed script without resource timing entries (cached=%s)', cached => {
    const state = setup('<script src="logic.js"></script>');
    if (cached) state.map({ [absolute('logic.js')]: SCRIPT });
    state.refresh('logic.js', 12);
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(state.canonical()).toBe('<script src="logic.js"></script>');
  });

  it.each(['fonts/text.woff2', 'data/plot.json', 'styles/import.css'])('keeps the used-resource reload fallback for %s', path => {
    const state = setup('<p>Illustrative content</p>', [absolute(path)]);
    state.refresh(path, 13);
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(state.resourceEntries).toHaveBeenCalledExactlyOnceWith('resource');
  });

  it.each([
    ['<svg xmlns="http://www.w3.org/2000/svg"><image href="images/dot.png"></image></svg>', 'image', 'href'],
    ['<picture><source src="images/dot.png"><img src="fallback.png"></picture>', 'source', 'src'],
  ])('refreshes mapped media attributes in place (%s)', (html, selector, attribute) => {
    const state = setup(html, [absolute('images/dot.png')]), original = state.canonical();
    const element = state.doc.querySelector(selector)!;
    state.map({ [absolute('images/dot.png')]: IMAGE }); state.refresh('images/dot.png', 14);
    expect(state.doc.querySelector(selector)).toBe(element);
    expect(element.getAttribute(attribute)).toBe(absolute('images/dot.png?olv=14'));
    expect(state.canonical()).toBe(original);
    expect(state.reload).not.toHaveBeenCalled();
  });

  it.each([
    'data:image/png;base64,RkFLRQ==',
    'blob:https://editor.invalid/FAKE',
    'https://public.invalid/ol-d/FAKE/slides/nested/images/dot.png',
    '//public.invalid/ol-d/FAKE/slides/nested/images/dot.png',
  ])('does not rewrite literal data, blob, or foreign assets (%s)', value => {
    const state = setup('<img>'), image = state.doc.querySelector('img')!;
    image.setAttribute('src', value);
    state.refresh('images/dot.png', 15);
    expect(image.getAttribute('src')).toBe(value);
    expect(mappedAttribute(image, 'src')).toBe(value);
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('does not reload for a foreign resource even when its path resembles a local capability URL', () => {
    const state = setup('<p>Illustrative content</p>', ['https://public.invalid/ol-d/FAKE/slides/nested/logic.js']);
    state.refresh('logic.js', 16);
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('handles encoded file names against the deliverable base instead of the offline frame location', () => {
    const state = setup('<img src="images/plot%20one.png">');
    state.map({ [absolute('images/plot%20one.png')]: IMAGE });
    state.refresh('images/plot one.png', 17);
    expect(state.doc.querySelector('img')!.getAttribute('src')).toBe(absolute('images/plot%20one.png?olv=17'));
    expect(state.canonical()).toBe('<img src="images/plot%20one.png">');
    expect(state.reload).not.toHaveBeenCalled();
  });

  it('ignores malformed URL encodings and unrelated resources without leaving a partial refresh', () => {
    const state = setup('<img src="images/%XX.png"><img src="images/other.png">', [absolute('logic.js')]);
    const original = state.canonical();
    expect(() => state.refresh('images/dot.png', 18)).not.toThrow();
    expect(state.canonical()).toBe(original);
    expect(state.reload).not.toHaveBeenCalled();
  });
});
