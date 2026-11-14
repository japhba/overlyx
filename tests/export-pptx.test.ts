/** The PowerPoint file of a deck (server pptx.ts): its parts, the slide size, pictures, notes, text boxes. */
import { describe, it, expect } from 'vitest';
import { writePptx, xmlEsc } from '../packages/server/src/pptx.ts';
import { readZip } from '../packages/server/src/zip.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function parts(buf: Buffer): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of readZip(buf)) m.set(e.name, e.name.endsWith(".png") ? `<${e.size} bytes>` : e.data().toString("utf8"));
  return m;
}

describe('pptx', () => {
  const deck = {
    title: 'A <talk> & more', width: 1280, height: 720,
    slides: [
      { image: PNG, imageType: 'png' as const, title: 'One', notes: 'Say "hi" & wave\n\nthen go on' },
      { image: PNG, imageType: 'png' as const, title: 'Two', texts: [{
        x: 96, y: 168, w: 500, h: 80, insets: [0, 0, 0, 0] as [number, number, number, number], anchor: 't' as const, wrap: true,
        paras: [
          { runs: [{ text: 'Fourier ', font: 'Fira Sans', size: 24, color: '1d2433' }, { text: 'mode', bold: true, italic: true, size: 24 }], align: 'ctr' as const, lineHeight: 1.2 },
          { runs: [{ text: 'a point' }], bullet: 'char' as const, level: 1, marL: 60, indent: -30 },
          { runs: [{ text: 'first' }], bullet: 'num' as const, start: 3 },
        ],
      }] },
    ],
  };
  const p = parts(writePptx(deck));

  it('has the parts PowerPoint opens, every one declared', () => {
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml',
      'ppt/notesSlides/notesSlide1.xml', 'ppt/media/slide1.png', 'docProps/core.xml', 'docProps/app.xml']) expect(p.has(name), name).toBe(true);
    const types = p.get('[Content_Types].xml')!;
    for (const name of p.keys()) if (name.endsWith('.xml') && name !== '[Content_Types].xml') expect(types, name).toContain(`PartName="/${name}"`);
    // every relationship's target is in the package
    for (const [name, xml] of p) if (name.endsWith('.rels')) {
      const dir = name.replace(/_rels\/[^/]*\.rels$/, '');
      for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
        const parts2 = (dir + m[1]).split('/'); const out: string[] = [];
        for (const s of parts2) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
        expect(p.has(out.join('/')), `${name} → ${m[1]}`).toBe(true);
      }
    }
  });

  it('the slide size is the deck’s (9525 EMU a CSS pixel), slides in order with notes', () => {
    expect(p.get('ppt/presentation.xml')).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(p.get('ppt/presentation.xml')).toContain('<p:sldId id="256" r:id="rId10"/><p:sldId id="257" r:id="rId11"/>');
    expect(p.get('ppt/notesSlides/notesSlide1.xml')).toContain('<a:t>Say &quot;hi&quot; &amp; wave</a:t>');
    expect(p.get('ppt/notesSlides/notesSlide1.xml')).toContain('<a:t>then go on</a:t>');
    expect(p.get('ppt/slides/slide1.xml')).toContain('<a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/>');
    expect(p.get('docProps/core.xml')).toContain('<dc:title>A &lt;talk&gt; &amp; more</dc:title>');
  });

  it('text boxes: font by name, size, colour, bold / italic, alignment, bullets and numbers', () => {
    const s = p.get('ppt/slides/slide2.xml')!;
    expect(s).toContain('<p:cNvSpPr txBox="1"/>');
    expect(s).toContain('<a:off x="914400" y="1600200"/>');
    expect(s).toContain('sz="2400"');
    expect(s).toContain('<a:srgbClr val="1D2433"/></a:solidFill><a:latin typeface="Fira Sans"/>');
    expect(s).toContain('b="1" i="1"');
    expect(s).toContain('algn="ctr"');
    expect(s).toContain('<a:buChar char="•"/>');
    expect(s).toContain('lvl="1"');
    expect(s).toContain('<a:buAutoNum type="arabicPeriod" startAt="3"/>');
    expect(s).not.toContain('<a:t>Fourier</a:t>');   // the space stays in the run
    expect(s).toContain('<a:t>Fourier </a:t>');
  });

  it('nothing embedded but the pictures; no font files', () => {
    expect([...p.keys()].filter(n => /\.(ttf|otf|fntdata|odttf)$/i.test(n))).toEqual([]);
    expect([...p.values()].join('')).not.toMatch(/embeddedFont/);
  });

  it('a poster larger than PowerPoint’s 56 inches is scaled into them', () => {
    const big = parts(writePptx({ title: 'p', width: 7000, height: 5000, slides: [{ image: PNG, imageType: 'png', texts: [] }] }));
    const m = /<p:sldSz cx="(\d+)" cy="(\d+)"\/>/.exec(big.get('ppt/presentation.xml')!)!;
    expect(Number(m[1])).toBeLessThanOrEqual(51206400);
    expect(Number(m[1]) / Number(m[2])).toBeCloseTo(7000 / 5000, 3);
  });

  it('XML text is escaped, characters XML forbids dropped', () => {
    expect(xmlEsc('a<b>&"c"\u0001')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
  });
});
