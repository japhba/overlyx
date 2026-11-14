/**
 * A PowerPoint file (.pptx) of a deck or a poster, written here part by part — no library, no
 * template: the parts are the minimal ones the open standard (ECMA-376 / ISO/IEC 29500, Office Open
 * XML, PresentationML) asks for, written from the standard, nothing taken from Office's own files
 * (the theme below is ours: plain colours, fonts by name). Fonts are referenced by name, never
 * embedded. Licence verdict and what is editable: DOCS.md "Pictures, handouts and notes pages".
 *
 * Every slide is the renderer's picture of the slide (render-export.ts) at the slide's size, with
 * its speaker notes on the notes page; with `texts`, text boxes lie over the picture as editable
 * text (the picture then has those texts left out: render-export.ts paints them transparent).
 *
 * Sizes come in CSS pixels (96 a inch) and go out in EMU (914400 a inch: 9525 a pixel).
 */
import { writeZip } from './zip.ts';

export interface PptxRun {
  text: string;
  /** a line break instead of text */
  br?: boolean;
  font?: string;
  /** points */
  size?: number;
  /** RRGGBB */
  color?: string;
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  /** superscript (> 0) / subscript (< 0), percent of the size */
  baseline?: number;
}
export interface PptxPara {
  runs: PptxRun[];
  align?: 'l' | 'ctr' | 'r' | 'just';
  bullet?: 'char' | 'num' | null;
  /** the bullet's character */
  char?: string;
  /** the first number of a numbered list */
  start?: number;
  /** list nesting, from 0 */
  level?: number;
  /** the paragraph's left margin and first-line indent (negative: hanging), CSS px */
  marL?: number; indent?: number;
  /** line height as a multiple of the font size */
  lineHeight?: number;
  /** space before / after, points */
  before?: number; after?: number;
  /** points: the size of an empty paragraph */
  size?: number;
}
export interface PptxText {
  /** the box, CSS px from the slide's top left */
  x: number; y: number; w: number; h: number;
  /** inner padding, CSS px: left, top, right, bottom */
  insets?: [number, number, number, number];
  anchor?: 't' | 'ctr' | 'b';
  wrap?: boolean;
  paras: PptxPara[];
}
export interface PptxSlide {
  image: Buffer;
  imageType: 'png' | 'jpeg';
  /** the slide's title (the picture's description) */
  title?: string;
  /** speaker notes, plain text */
  notes?: string;
  texts?: PptxText[];
}
export interface PptxDeck {
  title: string;
  /** a slide's size, CSS px */
  width: number; height: number;
  slides: PptxSlide[];
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
/** EMU a CSS pixel */
const PX = 9525;
/** PowerPoint's slide sizes: 1 to 56 inches a side */
const SLIDE_MIN = 914400, SLIDE_MAX = 51206400;

// (characters XML 1.0 does not allow are dropped)
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
export const xmlEsc = (s: string): string => s.replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const rels = (list: [string, string, string][]) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${xmlEsc(target)}"/>`).join('')}</Relationships>`;
const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const CLRMAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const rect = (x: number, y: number, w: number, h: number) => `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.max(1, Math.round(w))}" cy="${Math.max(1, Math.round(h))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;

/** our theme: black on white, six plain accents, fonts by name */
function theme(name: string): string {
  const c = (tag: string, hex: string) => `<a:${tag}><a:srgbClr val="${hex}"/></a:${tag}>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  return `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>`
    + `<a:clrScheme name="${name}">${c('dk1', '000000')}${c('lt1', 'FFFFFF')}${c('dk2', '1D2433')}${c('lt2', 'EEF0F3')}${c('accent1', '2F6FDE')}${c('accent2', 'EB811B')}${c('accent3', '3A9A5B')}${c('accent4', '8E5BB5')}${c('accent5', 'C8423B')}${c('accent6', '2A9BA8')}${c('hlink', '2F6FDE')}${c('folHlink', '8E5BB5')}</a:clrScheme>`
    + `<a:fontScheme name="${name}"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${name}"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>`
    + `<a:lnStyleLst>${`<a:ln w="9525">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst>`
    + `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`
    + `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme>`
    + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

function runXml(r: PptxRun, k: number): string {
  const size = r.size ? ` sz="${Math.max(100, Math.min(400000, Math.round(r.size * k * 100)))}"` : '';
  const attrs = `lang="en-US"${size}${r.bold ? ' b="1"' : ''}${r.italic ? ' i="1"' : ''}${r.underline ? ' u="sng"' : ''}${r.strike ? ' strike="sngStrike"' : ''}${r.baseline ? ` baseline="${Math.round(r.baseline * 1000)}"` : ''} dirty="0"`;
  const color = r.color && /^[0-9A-Fa-f]{6}$/.test(r.color) ? `<a:solidFill><a:srgbClr val="${r.color.toUpperCase()}"/></a:solidFill>` : '';
  const font = r.font ? `<a:latin typeface="${xmlEsc(r.font)}"/><a:cs typeface="${xmlEsc(r.font)}"/>` : '';
  const pr = `<a:rPr ${attrs}>${color}${font}</a:rPr>`;
  return r.br ? `<a:br>${pr}</a:br>` : `<a:r>${pr}<a:t>${xmlEsc(r.text)}</a:t></a:r>`;
}

function paraXml(p: PptxPara, k: number): string {
  const attrs = [
    p.marL ? `marL="${Math.round(p.marL * PX * k)}"` : '',
    p.indent ? `indent="${Math.round(p.indent * PX * k)}"` : '',
    p.level ? `lvl="${Math.min(8, p.level)}"` : '',
    p.align && p.align !== 'l' ? `algn="${p.align}"` : '',
  ].filter(Boolean).join(' ');
  let inner = '';
  // (PowerPoint's single spacing is about 1.2 times the size)
  if (p.lineHeight && p.lineHeight > 0) inner += `<a:lnSpc><a:spcPct val="${Math.round(Math.max(0.5, Math.min(5, p.lineHeight / 1.2)) * 100000)}"/></a:lnSpc>`;
  if (p.before) inner += `<a:spcBef><a:spcPts val="${Math.round(p.before * k * 100)}"/></a:spcBef>`;
  if (p.after) inner += `<a:spcAft><a:spcPts val="${Math.round(p.after * k * 100)}"/></a:spcAft>`;
  if (p.bullet === 'char') inner += `<a:buFont typeface="Arial"/><a:buChar char="${xmlEsc(p.char || '•')}"/>`;
  else if (p.bullet === 'num') inner += `<a:buAutoNum type="arabicPeriod"${p.start && p.start > 1 ? ` startAt="${Math.round(p.start)}"` : ''}/>`;
  else inner += '<a:buNone/>';
  const size = p.size ?? p.runs.find(r => r.size)?.size;
  const end = `<a:endParaRPr lang="en-US"${size ? ` sz="${Math.max(100, Math.min(400000, Math.round(size * k * 100)))}"` : ''} dirty="0"/>`;
  return `<a:p><a:pPr${attrs ? ' ' + attrs : ''}>${inner}</a:pPr>${p.runs.map(r => runXml(r, k)).join('')}${end}</a:p>`;
}

function textXml(t: PptxText, id: number, k: number): string {
  const [l, tp, r, b] = t.insets ?? [0, 0, 0, 0];
  const e = (v: number) => Math.max(0, Math.round(v * PX * k));
  const body = `<a:bodyPr wrap="${t.wrap === false ? 'none' : 'square'}" lIns="${e(l)}" tIns="${e(tp)}" rIns="${e(r)}" bIns="${e(b)}" rtlCol="0" anchor="${t.anchor ?? 't'}"><a:noAutofit/></a:bodyPr>`;
  const paras = t.paras.length ? t.paras.map(p => paraXml(p, k)).join('') : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id - 2}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${rect(t.x * PX * k, t.y * PX * k, t.w * PX * k, t.h * PX * k)}<a:noFill/></p:spPr>`
    + `<p:txBody>${body}<a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

/** the notes as paragraphs of the notes page's text placeholder */
function notesParas(notes: string): string {
  const lines = notes.replace(/\r\n?/g, '\n').split('\n');
  return lines.map(l => l.trim() ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlEsc(l)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>').join('');
}

/** The .pptx file. */
export function writePptx(deck: PptxDeck): Buffer {
  // the slide in EMU, within PowerPoint's sizes (a larger poster is scaled down, its texts with it)
  const w0 = Math.max(1, deck.width) * PX, h0 = Math.max(1, deck.height) * PX;
  const k = Math.min(1, SLIDE_MAX / Math.max(w0, h0));
  const cx = Math.max(SLIDE_MIN, Math.round(w0 * k)), cy = Math.max(SLIDE_MIN, Math.round(h0 * k));
  // the notes page (portrait 7.5 × 10 in), the slide's picture in its upper half
  const nW = 6858000, nH = 9144000;
  const imgW = Math.min(nW - 2 * 457200, (nH * 0.42) * cx / cy), imgH = imgW * cy / cx;
  const imgX = (nW - imgW) / 2, imgY = 685800;
  const n = deck.slides.length;
  const files: { name: string; data: Buffer; store?: boolean }[] = [];
  const add = (name: string, xml: string) => files.push({ name, data: Buffer.from(xml, 'utf8') });

  const slideCts = deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${CT}.notesSlide+xml"/>`).join('');
  add('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
    + `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>`
    + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>`
    + `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>`
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + `<Override PartName="/ppt/presProps.xml" ContentType="${CT}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${CT}.viewProps+xml"/>`
    + slideCts
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  add('_rels/.rels', rels([
    ['rId1', 'officeDocument', 'ppt/presentation.xml'],
    ['rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
    ['rId3', 'extended-properties', 'docProps/app.xml'],
  ]));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  add('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${xmlEsc(deck.title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  add('docProps/app.xml', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>OverLyX</Application><Slides>${n}</Slides><Notes>${n}</Notes></Properties>`);

  add('ppt/presentation.xml', `${HEAD}<p:presentation ${NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>'
    + `<p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="${nW}" cy="${nH}"/></p:presentation>`);
  add('ppt/_rels/presentation.xml.rels', rels([
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
    ['rId3', 'theme', 'theme/theme1.xml'],
    ['rId4', 'presProps', 'presProps.xml'],
    ['rId5', 'viewProps', 'viewProps.xml'],
    ...deck.slides.map((_, i): [string, string, string] => [`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]),
  ]));
  add('ppt/presProps.xml', `${HEAD}<p:presentationPr ${NS}/>`);
  add('ppt/viewProps.xml', `${HEAD}<p:viewPr ${NS}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  add('ppt/theme/theme1.xml', theme('OverLyX'));
  add('ppt/theme/theme2.xml', theme('OverLyX notes'));

  const style = (tag: string, sz: number) => `<p:${tag}><a:lvl1pPr><a:defRPr sz="${sz}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:${tag}>`;
  add('ppt/slideMasters/slideMaster1.xml', `${HEAD}<p:sldMaster ${NS}><p:cSld><p:spTree>${GROUP}</p:spTree></p:cSld>${CLRMAP}`
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + `<p:txStyles>${style('titleStyle', 4400)}${style('bodyStyle', 2800)}${style('otherStyle', 1800)}</p:txStyles></p:sldMaster>`);
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]));
  add('ppt/slideLayouts/slideLayout1.xml', `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));

  const imgPh = (id: number, withXfrm: boolean) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr>`
    + `<p:spPr>${withXfrm ? `${rect(imgX, imgY, imgW, imgH)}<a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>` : ''}</p:spPr></p:sp>`;
  const bodyPh = (id: number, withXfrm: boolean, paras: string) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>`
    + `<p:spPr>${withXfrm ? rect(685800, imgY + imgH + 457200, nW - 2 * 685800, nH - (imgY + imgH + 457200) - 685800) : ''}</p:spPr>`
    + `<p:txBody><a:bodyPr lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
  add('ppt/notesMasters/notesMaster1.xml', `${HEAD}<p:notesMaster ${NS}><p:cSld><p:spTree>${GROUP}${imgPh(2, true)}${bodyPh(3, true, '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>')}</p:spTree></p:cSld>${CLRMAP}`
    + '<p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>');
  add('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([['rId1', 'theme', '../theme/theme2.xml']]));

  deck.slides.forEach((s, i) => {
    const no = i + 1;
    const ext = s.imageType === 'jpeg' ? 'jpeg' : 'png';
    files.push({ name: `ppt/media/slide${no}.${ext}`, data: s.image, store: true });
    const texts = (s.texts ?? []).map((t, j) => textXml(t, 3 + j, k)).join('');
    add(`ppt/slides/slide${no}.xml`, `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP}`
      + `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide ${no}" descr="${xmlEsc(s.title || `Slide ${no}`)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
      + `<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${rect(0, 0, cx, cy)}</p:spPr></p:pic>`
      + `${texts}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    add(`ppt/slides/_rels/slide${no}.xml.rels`, rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'image', `../media/slide${no}.${ext}`],
      ['rId3', 'notesSlide', `../notesSlides/notesSlide${no}.xml`],
    ]));
    add(`ppt/notesSlides/notesSlide${no}.xml`, `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}${imgPh(2, false)}${bodyPh(3, false, notesParas(s.notes ?? ''))}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
    add(`ppt/notesSlides/_rels/notesSlide${no}.xml.rels`, rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${no}.xml`]]));
  });
  return writeZip(files);
}
