/**
 * What an OpenType / TrueType file offers, read from its tables (no library): the OpenType features
 * of its GSUB / GPOS tables (`onum`, `smcp`, `ss01`, …), a variable font's axes (`fvar`: tag, range,
 * default, name) and named instances ("Light", "Condensed Bold" and their coordinates — the rungs of
 * the toolbar's sliders), and the weight class of a static face (OS/2). For the font list's
 * "Weight & features" panel (googlefonts.ts `/api/fonts/info`).
 */

export interface FontAxis { tag: string; name: string; min: number; def: number; max: number }
export interface FontInstance { name: string; coords: Record<string, number> }
export interface FontFileInfo { features: string[]; axes: FontAxis[]; instances: FontInstance[]; weightClass: number | null; italic: boolean }

export function fontFileInfo(buf: Buffer): FontFileInfo {
  const info: FontFileInfo = { features: [], axes: [], instances: [], weightClass: null, italic: false };
  if (buf.length < 12) return info;
  const tables = new Map<string, { off: number; len: number }>();
  const n = buf.readUInt16BE(4);
  for (let i = 0; i < n && 12 + 16 * i + 16 <= buf.length; i++) {
    const at = 12 + 16 * i;
    const off = buf.readUInt32BE(at + 8), len = buf.readUInt32BE(at + 12);
    if (off + len <= buf.length) tables.set(buf.toString('latin1', at, at + 4), { off, len });
  }
  const u16 = (o: number) => buf.readUInt16BE(o);
  const fixed = (o: number) => buf.readInt32BE(o) / 65536;
  const names = nameTable(buf, tables.get('name'));

  const features = new Set<string>();
  for (const tag of ['GSUB', 'GPOS']) {
    const t = tables.get(tag);
    if (!t || t.len < 10) continue;
    const list = t.off + u16(t.off + 6);
    if (list + 2 > buf.length) continue;
    const count = u16(list);
    for (let j = 0; j < count && list + 2 + 6 * j + 4 <= buf.length; j++) {
      const f = buf.toString('latin1', list + 2 + 6 * j, list + 6 + 6 * j);
      if (/^[a-z0-9]{4}$/.test(f)) features.add(f);
    }
  }
  info.features = [...features].sort();

  const fvar = tables.get('fvar');
  if (fvar && fvar.len >= 16) {
    const o = fvar.off;
    const axesAt = o + u16(o + 4), axisCount = u16(o + 8), axisSize = u16(o + 10), instCount = u16(o + 12), instSize = u16(o + 14);
    for (let a = 0; a < axisCount; a++) {
      const p = axesAt + a * axisSize;
      if (p + 20 > buf.length) break;
      const tag = buf.toString('latin1', p, p + 4);
      info.axes.push({ tag, min: fixed(p + 4), def: fixed(p + 8), max: fixed(p + 12), name: names.get(u16(p + 18)) ?? tag });
    }
    const instAt = axesAt + axisCount * axisSize;
    for (let k = 0; k < instCount; k++) {
      const p = instAt + k * instSize;
      if (p + 4 + 4 * axisCount > buf.length) break;
      const coords: Record<string, number> = {};
      info.axes.forEach((ax, a) => { coords[ax.tag] = fixed(p + 4 + 4 * a); });
      info.instances.push({ name: names.get(u16(p)) ?? '', coords });
    }
  }

  const os2 = tables.get('OS/2');
  if (os2 && os2.len >= 64) { info.weightClass = u16(os2.off + 4); info.italic = (u16(os2.off + 62) & 1) === 1; }
  return info;
}

/** the `name` table's strings by id (Windows Unicode, English preferred; Mac Roman else) */
function nameTable(buf: Buffer, t: { off: number; len: number } | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!t || t.len < 6) return out;
  const count = buf.readUInt16BE(t.off + 2), strings = t.off + buf.readUInt16BE(t.off + 4);
  const rank = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const r = t.off + 6 + 12 * i;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r), enc = buf.readUInt16BE(r + 2), lang = buf.readUInt16BE(r + 4), id = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8), off = strings + buf.readUInt16BE(r + 10);
    if (off + len > buf.length) continue;
    let s: string | null = null, score = 0;
    if (platform === 3 && (enc === 1 || enc === 10)) {
      const b = Buffer.from(buf.subarray(off, off + len));
      s = b.swap16().toString('utf16le');
      score = lang === 0x409 ? 3 : 2;
    } else if (platform === 1 && enc === 0) { s = buf.toString('latin1', off, off + len); score = 1; }
    if (s !== null && score > (rank.get(id) ?? 0)) { out.set(id, s); rank.set(id, score); }
  }
  return out;
}
