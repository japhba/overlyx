// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { clearMappedAssets, cssAssetValues, mapAssets, mappedCss, mappedSrcset, rememberMappedSource, restoreMappedAssets, setMappedAttribute, srcsetAssetValues } from '../packages/client/src/deliverable/offlineassets';

const base = 'https://example.invalid/d/FAKE_TOKEN/slides/';
const url = (value: string) => new URL(value, base).href;
const image = 'data:image/png;base64,RkFLRQ==';
const second = 'data:image/png;base64,TkVX';
const css = 'data:text/css;charset=utf-8,body%7Bcolor%3Ablue%7D';

it('collects and maps quoted CSS imports and url resources without rewriting comments or media conditions', () => {
  const source = `/* @import "ignored.css"; url(ignored.png) */\n@import "theme.css" layer(theme) screen;\n@import 'fonts.css' supports(display:grid);\n@import url("layout.css") print;\n.hero {background: url( photo.png )}`;
  expect(cssAssetValues(source)).toEqual(['theme.css', 'fonts.css', 'layout.css', 'photo.png']);
  const assets = { [url('theme.css')]: css, [url('photo.png')]: image };
  const mapped = mappedCss(source, assets, base);
  expect(mapped).toContain(`@import "${css}" layer(theme) screen;`);
  expect(mapped).toContain(`background: url("${image}")`);
  expect(mapped).toContain(`@import 'fonts.css' supports(display:grid);`);
  expect(mapped).toContain('/* @import "ignored.css"; url(ignored.png) */');
});

it('maps srcset URLs while preserving data URL commas, candidate descriptors, and spacing', () => {
  const source = `data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x,  small.png 2x,\nlarge.png 800w`;
  expect(srcsetAssetValues(source)).toEqual(['data:image/svg+xml,%3Csvg%3E,%3C/svg%3E', 'small.png', 'large.png']);
  expect(mappedSrcset(source, { [url('small.png')]: image, [url('large.png')]: second }, base)).toBe(`data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 1x,  ${image} 2x,\n${second} 800w`);
  expect(srcsetAssetValues('small.png, large.png,')).toEqual(['small.png', 'large.png']);
});

it('restores the exact canonical DOM on serialization after display-only image, srcset, CSS, and stylesheet mapping', () => {
  const live = document.createElement('section');
  live.innerHTML = `<style>@import "theme.css" screen;.hero{background:url(photo.png)}</style><link href="theme.css" rel="stylesheet"><picture><source srcset="photo.png 1x, large.png 2x"><img src="photo.png"></picture><video poster="photo.png"></video><p style="background:url(photo.png);color:blue">Text</p>`;
  const canonical = live.outerHTML;
  mapAssets(live, { [url('photo.png')]: image, [url('large.png')]: second, [url('theme.css')]: css }, base);
  expect(live.querySelector('img')!.getAttribute('src')).toBe(image);
  expect(live.querySelector('source')!.getAttribute('srcset')).toBe(`${image} 1x, ${second} 2x`);
  const clone = live.cloneNode(true) as Element;
  restoreMappedAssets(clone, live);
  expect(clone.outerHTML).toBe(canonical);
  expect(live.querySelector('img')!.getAttribute('src')).toBe(image);
});

it('maps a picture read under a renewed link token to the frame still opened with the old one', () => {
  // after a reconnection the editor reads the assets under a new /ol-d/<token>/; the open frame resolves against its first
  const frameBase = 'https://example.invalid/ol-d/OLD.sig/talk/', newBase = 'https://example.invalid/ol-d/NEW.sig/talk/';
  const live = document.createElement('section'); live.innerHTML = '<img src="images/photo.png"><p style="background:url(images/photo.png)">x</p>';
  mapAssets(live, { [new URL('images/photo.png', newBase).href]: image }, frameBase);
  expect(live.querySelector('img')!.getAttribute('src')).toBe(image);
  expect(live.querySelector('p')!.getAttribute('style')).toContain(image);
  // another folder of the project stays another file
  expect(mappedSrcset('images/photo.png', { [new URL('../other/images/photo.png', newBase).href]: image }, frameBase)).toBe('images/photo.png');
});

it('retains the first raw source while refreshing mapped assets to a new version', () => {
  const live = document.createElement('section'); live.innerHTML = '<img src="photo.png"><style>.hero{background:url(photo.png)}</style>';
  const canonical = live.outerHTML;
  mapAssets(live, { [url('photo.png')]: image }, base);
  mapAssets(live, { [url('photo.png')]: second }, base);
  expect(live.querySelector('img')!.getAttribute('src')).toBe(second);
  expect(live.querySelector('style')!.textContent).toContain(second);
  const clone = live.cloneNode(true) as Element; restoreMappedAssets(clone, live);
  expect(clone.outerHTML).toBe(canonical);
});

it('does not revert edited attributes or style text and tracks newly reconciled raw attributes', () => {
  const live = document.createElement('section'); live.innerHTML = '<img src="photo.png"><style>.hero{background:url(photo.png)}</style>';
  mapAssets(live, { [url('photo.png')]: image }, base);
  live.querySelector('img')!.setAttribute('src', 'user-chosen.png');
  live.querySelector('style')!.textContent = '.hero{color:red}';
  const edited = live.cloneNode(true) as Element; restoreMappedAssets(edited, live);
  expect(edited.querySelector('img')!.getAttribute('src')).toBe('user-chosen.png');
  expect(edited.querySelector('style')!.textContent).toBe('.hero{color:red}');
  setMappedAttribute(live.querySelector('img')!, 'src', 'other.png', { [url('other.png')]: second }, base);
  const reconciled = live.cloneNode(true) as Element; restoreMappedAssets(reconciled, live);
  expect(reconciled.querySelector('img')!.getAttribute('src')).toBe('other.png');
});

it('does not map or track runtime, MathJax, or chip subtrees', () => {
  const live = document.createElement('section');
  live.innerHTML = '<div data-ol-runtime><img src="photo.png"></div><mjx-container style="background:url(photo.png)"><img src="photo.png"></mjx-container><span class="ol-mathchip"><img src="photo.png"></span><span class="ol-refchip"><img src="photo.png"></span><img src="photo.png">';
  mapAssets(live, { [url('photo.png')]: image }, base);
  expect([...live.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual(['photo.png', 'photo.png', 'photo.png', 'photo.png', image]);
  expect(live.querySelector('mjx-container')!.getAttribute('style')).toBe('background:url(photo.png)');
  setMappedAttribute(live, 'class', 'photo.png', { [url('photo.png')]: image }, base);
  expect(live.className).toBe('photo.png');
});

it('drops stale metadata when a source subtree is reset and skips mismatched clone structures', () => {
  const live = document.createElement('section'); live.innerHTML = '<img src="photo.png"><img src="photo.png">';
  mapAssets(live, { [url('photo.png')]: image }, base);
  const changed = live.cloneNode(true) as Element; changed.firstElementChild!.remove();
  restoreMappedAssets(changed, live);
  expect(changed.querySelector('img')!.getAttribute('src')).toBe(image);
  clearMappedAssets(live); live.innerHTML = '<img src="other.png">';
  mapAssets(live, { [url('other.png')]: second }, base);
  const clone = live.cloneNode(true) as Element; restoreMappedAssets(clone, live);
  expect(clone.querySelector('img')!.getAttribute('src')).toBe('other.png');
});

it('seeds a reparsed child frame from canonical source and distinguishes duplicate cached image bodies', () => {
  const source = document.createElement('section'); source.innerHTML = '<img src="photo.png"><img src="other.png"><style>.hero{background:url(photo.png)}</style>';
  const parent = source.cloneNode(true) as Element;
  const assets = { [url('photo.png')]: image, [url('other.png')]: image };
  mapAssets(parent, assets, base);
  const child = document.createElement('section'); child.innerHTML = parent.innerHTML;
  // Parent WeakMap identity did not survive srcdoc serialization.
  for (let i = 0; i < child.children.length; i++) rememberMappedSource(child.children[i], source.children[i], assets, base);
  const canonical = child.cloneNode(true) as Element; restoreMappedAssets(canonical, child);
  expect(canonical.innerHTML).toBe(source.innerHTML);
  expect([...child.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([image, image]);
});

it('does not replace or track script-edited/stale attributes when seeding child metadata', () => {
  const source = document.createElement('img'); source.setAttribute('src', 'photo.png');
  const live = document.createElement('img'); live.setAttribute('src', 'script-selected.png');
  rememberMappedSource(live, source, { [url('photo.png')]: image }, base);
  const clone = live.cloneNode(true) as Element; restoreMappedAssets(clone, live);
  expect(clone.getAttribute('src')).toBe('script-selected.png');
  expect(live.getAttribute('src')).toBe('script-selected.png');
  const group = document.createElement('section'); group.innerHTML = '<img src="photo.png">';
  const display = group.cloneNode(true) as Element; mapAssets(display, { [url('photo.png')]: image }, base);
  const child = document.createElement('section'); child.innerHTML = display.innerHTML;
  rememberMappedSource(child, group, { [url('photo.png')]: image }, base);
  const unseededChild = child.cloneNode(true) as Element; restoreMappedAssets(unseededChild, child);
  expect(unseededChild.querySelector('img')!.getAttribute('src')).toBe(image);
});
