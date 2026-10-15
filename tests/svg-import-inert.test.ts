// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inlineSvgHtml } from '../packages/client/src/deliverable/sourceops.ts';

const svg = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" ${attrs}>${body}</svg>`;
afterEach(() => vi.restoreAllMocks());

describe('SVG import neutralizes handlers before browser parsing', () => {
  it('never passes active handlers to DOMParser and retains geometry, gradient and link IDs', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const result = inlineSvgHtml(svg('<script>alert(1)</script><rect id="r1" width="80" height="80" fill="#123456" onclick="alert(2)"/><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><circle fill="url(#g)"/><use xlink:href="#r1"/>'), { x: 640, y: 300, maxW: 768 }, 'safe')!;
    const staged = String(parse.mock.calls[0][0]);
    expect(staged).not.toContain(' onclick=');
    expect(staged).toContain('="alert(2)"'); // values still reach XML validation
    expect(result).not.toMatch(/<script|\son[a-z]+=|data-ol-svg-inert-/i);
    expect(result).toContain('id="safe-r1"');
    expect(result).toContain('id="safe-g"');
    expect(result).toContain('url(#safe-g)');
    expect(result).toContain('href="#safe-r1"');
    expect(result).toContain('viewBox="0 0 200 100"');
  });

  it('handles uppercase names, both quote styles, root handlers and template/foreignObject children', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const result = inlineSvgHtml(svg('<rect OnClick=\'go("&lt; > =")\' width="20"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><template><button onclick="nested()">B</button></template></div></foreignObject>', 'ONLOAD="root()"'), null, 'safe')!;
    const staged = String(parse.mock.calls[0][0]);
    expect(staged).not.toMatch(/\s(?:ONLOAD|OnClick|onclick)=/);
    expect(staged).toContain('\'go("&lt; > =")\'');
    expect(staged).toContain('="nested()"');
    expect(result).not.toContain('foreignObject');
    expect(result).not.toContain('data-ol-svg-inert-');
  });

  it('leaves CDATA, comments, namespace names and quoted non-handler text intact', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const cdata='<![CDATA[/* <rect onclick="inert-text()"/> */ .c{fill:red}]]>';
    const comment='<!-- <rect onclick="inert-comment()"/> -->';
    const result=inlineSvgHtml(svg(`<style>${cdata}</style>${comment}<rect class="c" data-note="onclick=&quot;text&quot;" onclick="live()"/>`),null,'safe')!;
    const staged=String(parse.mock.calls[0][0]);
    expect(staged).toContain(cdata);
    expect(staged).toContain(comment);
    expect(staged).toContain('data-note="onclick=&quot;text&quot;"');
    expect(staged).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(result).toContain('class="c"');
    expect(result).not.toContain('data-ol-svg-inert-');
  });

  it.each(['<rect onclick="a()" onclick="b()"/>', '<rect width="1" width="2"/>'])('rejects duplicate XML attributes without invoking browser parsing: %s', body => {
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    expect(inlineSvgHtml(svg(body),null,'safe')).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([
    '<rect onclick=unquoted />',
    '<rect onclick="unterminated />',
    '<g onclick="safe()"><rect /></mismatched>',
    '<rect onclick="safe()" missing:attr="unbound"/>',
  ])('retains native rejection of invalid XML: %s', body => {
    expect(inlineSvgHtml(svg(body), null, 'safe')).toBeNull();
  });

  it('preserves namespace declarations and native namespace validation', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const result=inlineSvgHtml(svg('<g xmlns:meta="urn:meta" meta:label="keep" onclick="neutral()"><rect id="r" width="2" height="3"/><use xlink:href="#r"/></g>'), null, 'safe')!;
    const staged=String(parse.mock.calls[0][0]);
    expect(staged).toContain('xmlns:meta="urn:meta"');
    expect(staged).toContain('meta:label="keep"');
    expect(result).toContain('id="safe-r"');
    expect(result).toContain('href="#safe-r"');
    expect(result).not.toContain('meta:label'); // existing namespace sanitization remains
  });

  it('keeps distinct XML name case and avoids temporary-name collisions', () => {
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    const result=inlineSvgHtml(svg('<rect onclick="a()" OnClick="b()" data-ol-svg-inert-0-onclick="keep" DATA-OL-SVG-INERT-1-OTHER="also keep"/>'),null,'safe')!;
    const staged=String(parse.mock.calls[0][0]);
    expect(staged).toContain('data-ol-svg-inert-2-onclick="a()"');
    expect(staged).toContain('data-ol-svg-inert-2-OnClick="b()"');
    expect(result).toContain('data-ol-svg-inert-0-onclick="keep"');
    expect(result).toContain('DATA-OL-SVG-INERT-1-OTHER="also keep"');
  });

  it('keeps the temporary prefix short when a large value contains a long prefix-like run', () => {
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    const note='data-ol-svg-inert-'+'x'.repeat(360_000);
    const input=svg(`<rect data-note="${note}" onclick="safe()"/>`);
    const result=inlineSvgHtml(input,null,'safe')!;
    const staged=String(parse.mock.calls[0][0]);
    expect(staged).toContain('data-ol-svg-inert-0-onclick="safe()"');
    expect(staged.length-input.length).toBeLessThan(32);
    expect(result).toContain(`data-note="${note}"`);
  });

  it('selects the next unused integer across many occupied, casefolded attribute prefixes', () => {
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    const attrs=Array.from({length:256},(_,n)=>`DATA-OL-SVG-INERT-${n}-kept="${n}"`).join(' ');
    const result=inlineSvgHtml(svg(`<rect ${attrs} onclick="safe()"/>`),null,'safe')!;
    const staged=String(parse.mock.calls[0][0]);
    expect(staged).toContain('data-ol-svg-inert-256-onclick="safe()"');
    expect(result).toContain('DATA-OL-SVG-INERT-255-kept="255"');
    expect(result).not.toContain('data-ol-svg-inert-256-onclick');
  });


  it.each(['style', 'textarea'])('neutralizes XML children hidden by HTML raw-text parsing: %s', tag => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const input=svg(`<foreignObject><${tag} xmlns="http://www.w3.org/1999/xhtml"><svg xmlns="http://www.w3.org/2000/svg" onload="hidden()"/></${tag}></foreignObject>`);
    const result=inlineSvgHtml(input,null,'safe')!;
    expect(String(parse.mock.calls[0][0])).not.toContain(' onload=');
    expect(String(parse.mock.calls[0][0])).toContain('data-ol-svg-inert-0-onload="hidden()"');
    expect(result).not.toContain('foreignObject');
  });

  it('neutralizes a prefixed SVG child inside XML style content', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const result=inlineSvgHtml('<s:svg xmlns:s="http://www.w3.org/2000/svg"><style><s:rect onclick="hidden()"/></style></s:svg>',null,'safe')!;
    expect(String(parse.mock.calls[0][0])).toContain('<s:rect data-ol-svg-inert-0-onclick="hidden()"/>');
    expect(new DOMParser().parseFromString(result,'image/svg+xml').querySelector('parsererror')).toBeNull();
  });

  it('serializes prefixed SVG shapes in the SVG namespace with geometry, gradient and xlink references intact', () => {
    const input='<s:svg xmlns:s="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" xml:space="preserve"><s:defs><s:linearGradient id="g"><s:stop offset="0" stop-color="#f00"/></s:linearGradient></s:defs><s:rect id="r" x="10" width="20" height="30" fill="url(#g)" onclick="hidden()"/><s:use xlink:href="#r"/></s:svg>';
    const result=inlineSvgHtml(input,null,'safe')!;
    const doc=new DOMParser().parseFromString(result,'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(doc.documentElement.prefix).toBeNull();
    expect(doc.documentElement.getAttributeNS('http://www.w3.org/XML/1998/namespace','space')).toBe('preserve');
    const rect=doc.querySelector('rect')!;
    expect(rect.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(rect.prefix).toBeNull();
    expect(rect.getAttribute('x')).toBe('10');
    expect(rect.getAttribute('width')).toBe('20');
    expect(rect.getAttribute('height')).toBe('30');
    expect(rect.getAttribute('fill')).toBe('url(#safe-g)');
    expect(doc.querySelector('linearGradient')!.getAttribute('id')).toBe('safe-g');
    expect(doc.querySelector('use')!.getAttributeNS('http://www.w3.org/1999/xlink','href')).toBe('#safe-r');
  });

  it('retains external SVG doctypes, including quoted brackets, and skips PI/comment/CDATA tag-like text', () => {
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    const prolog='<?xml version="1.0"?><!DOCTYPE svg SYSTEM "https://example.invalid/[svg].dtd">';
    const pi='<?meta fake="<rect onclick=\'inertPI()\'/> >"?>';
    const comment='<!-- <rect onclick="inertComment()"/> -->';
    const cdata='<![CDATA[/* <rect onclick="inertCDATA()"/> */]]>';
    const result=inlineSvgHtml(prolog+svg(`${pi}${comment}<style>${cdata}</style><rect onclick="real()"/>`),null,'safe')!;
    const staged=String(parse.mock.calls[0][0]);
    expect(staged).toContain(prolog);
    expect(staged).toContain(pi);
    expect(staged).toContain(comment);
    expect(staged).toContain(cdata);
    expect(staged).not.toContain('<rect onclick="real()"');
    expect(result).not.toBeNull();
  });

  it.each([
    '<!DOCTYPE svg [<!ENTITY handler "<rect onclick=\'entity()\'/>" >]>',
    '<!DOCTYPE svg [<!ATTLIST svg mode CDATA #IMPLIED>]>',
  ])('rejects internal DTD subsets before browser parsing: %s', doctype => {
    const parse=vi.spyOn(DOMParser.prototype,'parseFromString');
    expect(inlineSvgHtml(doctype+svg('&handler;'),null,'safe')).toBeNull();
    expect(parse).not.toHaveBeenCalled();
  });

  it('neutralizes near-limit many-handler input before browser parsing within a bounded cost', () => {
    const unit='<g onload=""/>';
    const input=svg(unit.repeat(Math.floor((399_900-svg('').length)/unit.length)));
    let staged='';
    vi.spyOn(DOMParser.prototype,'parseFromString').mockImplementation(text => { staged=String(text); throw new Error('Stop after the preparse boundary'); });
    const started=performance.now();
    expect(inlineSvgHtml(input,null,'safe')).toBeNull();
    expect(performance.now()-started).toBeLessThan(5000);
    expect(input.length).toBeGreaterThan(399_000);
    expect(input.length).toBeLessThan(400_000);
    expect(staged).not.toContain(' onload=');
    expect(staged.split('data-ol-svg-inert-0-onload').length-1).toBe(input.split(unit).length-1);
  });

});
