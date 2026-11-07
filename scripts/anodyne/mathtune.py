"""
Anodyne's maths at TeX's proportions: Noto Sans Math (Lisnoti's MATH table) sets formulas tighter than
Computer Modern does in beamer's default and in Latin Modern / New Computer Modern — subscripts on
operators and brackets do not drop, limits sit at half TeX's gap, a root's index is jammed against
the sign, scripts crowd what follows, and brackets carry ~30/1000 em of side bearing at every size
where TeX's grow with the bracket. `tune(font)` sets the MATH constants at TeX's (Latin Modern Math's)
values — vertical ones at Anodyne's x-height (536 against 431), kerns and spaces TeX gives in em
as they are — and gives each delimiter's size variants and its assembly's parts side bearings that
grow with their height as Computer Modern's do (Latin Modern Math's, as beamer's default sets them:
units per 1000 of height, from the text-size glyph's own bearings). Outlines only move here (delimgen.py
draws them); the same deltas for the Regular and the Bold keep them compatible (`delimiter_shifts` once,
`apply_shifts` to both).
"""
from fontTools.ttLib import TTFont

# MATH constants: TeX's (Latin Modern Math), the vertical ones scaled to Anodyne's x-height and rounded,
# only where Noto Sans Math's are tighter
CONSTANTS = {
    'SubscriptShiftDown': 260,
    'SubscriptBaselineDropMin': 250,
    'SuperscriptShiftUp': 420,
    'SuperscriptShiftUpCramped': 330,
    'SuperscriptBaselineDropMax': 300,
    'SubSuperscriptGapMin': 200,
    'SpaceAfterScript': 56,
    'UpperLimitGapMin': 200,
    'LowerLimitGapMin': 167,
    'StretchStackGapAboveMin': 200,
    'StretchStackGapBelowMin': 167,
    'DelimitedSubFormulaMinHeight': 1600,
    'RadicalKernBeforeDegree': 278,
    'RadicalDegreeBottomRaisePercent': 60,
}

# how side bearings grow with the height, per 1000 units above the text-size glyph (whose own are kept):
# (outer, inner); outer = the side away from what the delimiter encloses (a left parenthesis' left).
# Computer Modern's (Latin Modern Math's size variants): a parenthesis or bracket gains room outside only,
# its inner side stays close to what it encloses; a brace gains a little on both sides
KINDS = {
    'paren': (88, 0),
    'bracket': (103, 0),
    'brace': (36, 36),
    'angle': (47, 0),
    'bar': (15, 15),
}
# the delimiters (opening one, closing one) of each kind
DELIMITERS = {
    'paren': [('(', ')')],
    'bracket': [('[', ']'), ('⌈', '⌉'), ('⌊', '⌋'), ('⟦', '⟧')],
    'brace': [('{', '}')],
    'angle': [('⟨', '⟩'), ('⟪', '⟫')],
    'bar': [('|', None), ('‖', None)],
}


def _bounds(font, name):
    from fontTools.pens.boundsPen import BoundsPen
    gs = font.getGlyphSet()
    bp = BoundsPen(gs)
    gs[name].draw(bp)
    return bp.bounds


# how far the radical sign reaches back under its degree, as a share of the sign's advance (Latin Modern's
# -556 of 833: the index sits over the sign's rising tick, whatever its width)
RADICAL_UNDER_DEGREE = 556 / 833


def tune_constants(font):
    mc = font['MATH'].table.MathConstants
    values = dict(CONSTANTS)
    root = font.getBestCmap().get(0x221A)
    if root:
        values['RadicalKernAfterDegree'] = -round(RADICAL_UNDER_DEGREE * font['hmtx'][root][0])
    for k, v in values.items():
        cur = getattr(mc, k)
        if hasattr(cur, 'Value'):
            cur.Value = v
        else:
            setattr(mc, k, v)


def delimiter_shifts(font):
    """glyph → (dx, dadv): how far to move each delimiter glyph (base, size variants, assembly parts) and how
    much wider to make it, from this font's metrics (the Regular's, for every master)"""
    cmap = font.getBestCmap()
    hmtx = font['hmtx']
    mv = font['MATH'].table.MathVariants
    cov = mv.VertGlyphCoverage.glyphs if mv.VertGlyphCoverage else []
    out = {}

    def target(name, h, kind, opening, ref):
        """(dx, dadv) giving glyph `name` (height h) the base glyph's bearings `ref` grown for its height"""
        b = _bounds(font, name)
        if not b:
            return None
        adv, _ = hmtx[name]
        lsb, rsb = b[0], adv - b[2]
        (bl, br, bh) = ref
        o, i = KINDS[kind]
        extra = max(0.0, h - bh) / 1000
        outer, inner = (bl, br) if opening else (br, bl)
        outer, inner = outer + o * extra, inner + i * extra
        new_l, new_r = (outer, inner) if opening else (inner, outer)
        return round(new_l - lsb), round((new_l - lsb) + (new_r - rsb))

    for kind, pairs in DELIMITERS.items():
        for pair in pairs:
            for opening, ch in zip((True, False), pair):
                if ch is None or ord(ch) not in cmap:
                    continue
                base = cmap[ord(ch)]
                b = _bounds(font, base)
                if not b:
                    continue
                # (the text-size glyph keeps its spacing: it is the text's too)
                ref = (b[0], hmtx[base][0] - b[2], b[3] - b[1])
                if base not in cov:
                    continue
                con = mv.VertGlyphConstruction[cov.index(base)]
                largest = None
                for v in con.MathGlyphVariantRecord:
                    if v.VariantGlyph == base:
                        continue
                    t = target(v.VariantGlyph, v.AdvanceMeasurement, kind, opening, ref)
                    if t:
                        out[v.VariantGlyph] = t
                        largest = t
                # the assembly's parts move together, as the largest variant does
                if con.GlyphAssembly and largest:
                    for p in con.GlyphAssembly.PartRecords:
                        out.setdefault(p.glyph, largest)
    return out


def apply_shifts(font, shifts):
    """move each glyph's outline by dx and widen its advance by dadv (composites by their offsets)"""
    glyf, hmtx = font['glyf'], font['hmtx']
    for name, (dx, dadv) in shifts.items():
        if name not in glyf.glyphs:
            continue
        g = glyf[name]
        if g.isComposite():
            # (a component that moves by itself carries part of the shift already)
            for c in g.components:
                c.x += dx - shifts.get(c.glyphName, (0, 0))[0]
        elif g.numberOfContours > 0:
            coords = g.coordinates
            for i in range(len(coords)):
                x, y = coords[i]
                coords[i] = (x + dx, y)
        g.recalcBounds(glyf)
        adv, lsb = hmtx[name]
        hmtx[name] = (adv + dadv, (g.xMin if g.numberOfContours != 0 else lsb))
    # italic corrections and accent attachments ride with the outline
    gi = font['MATH'].table.MathGlyphInfo
    if gi.MathTopAccentAttachment:
        ta = gi.MathTopAccentAttachment
        for name, rec in zip(ta.TopAccentCoverage.glyphs, ta.TopAccentAttachment):
            if name in shifts:
                rec.Value += shifts[name][0]


def tune(font, shifts=None):
    """the font's MATH constants and delimiter spacing at TeX's proportions; returns the shifts used"""
    tune_constants(font)
    shifts = shifts if shifts is not None else delimiter_shifts(font)
    apply_shifts(font, shifts)
    return shifts


if __name__ == '__main__':
    import sys
    src, dst = sys.argv[1], sys.argv[2]
    f = TTFont(src)
    s = tune(f)
    f.save(dst)
    print(dst, len(s), 'delimiter glyphs moved')
