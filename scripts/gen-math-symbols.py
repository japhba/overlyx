#!/usr/bin/env python3
"""Convert LyX's lib/symbols into packages/core/src/math/symbols.json (the math parser's command table).

Entry formats (see MathFactory.cpp initSymbols):
  name  fontname  charcode  fallback  class  [xmlname] [requires]   -> a symbol (\\alpha, \\sum, ...)
  name  insettype extra [requires]                                  -> an inset (decoration, font, space, ...)
  \\def\\name{definition} [extra xmlname] [requires]                 -> a predefined macro (drawn via its definition)
"""
import json, re, sys, os
src = sys.argv[1] if len(sys.argv) > 1 else '/root/lyx/lib/symbols'
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'packages/core/src/math/symbols.json')
FONTS = {'cmr','cmsy','cmm','cmex','msa','msb','wasy','stmry','esint','lyxblacktext','mathscr','mathds','mathcal','mathbb','mathfrak','hepnames','hepparticles'}
def uni(s):
    if not s.startswith('&#x'): return None
    try: return ''.join(chr(int(h, 16)) for h in re.findall(r'&#x([0-9A-Fa-f]+);?', s))
    except ValueError: return None
out = {}
skip = 0
for line in open(src, encoding='utf-8'):
    line = line.rstrip('\n')
    if not line.strip() or line.startswith('#'): continue
    if line.startswith('iffont'): skip = 1; continue     # first branch = font available (LyX ships its fonts)
    if line.startswith('else'): skip = -1; continue      # skip the fallback branch
    if line.startswith('endif'): skip = 0; continue
    if skip < 0: continue
    if line.startswith('\\def\\'):
        m = re.match(r'\\def\\([^{]+)(\{.*\})\s*(.*)$', line)
        if not m: continue
        name, definition, rest = m.group(1), m.group(2), m.group(3).split()
        e = {'i': 'macro', 'd': definition[1:-1]}
        if len(rest) >= 2:
            e['c'] = rest[0]
            u = uni(rest[1])
            if u: e['u'] = u
        out.setdefault(name, e)
        continue
    f = line.split()
    name, kind = f[0], f[1]
    if kind in FONTS:
        cls = f[4] if len(f) > 4 else 'mathord'
        e = {'i': 'sym', 'c': cls}
        if len(f) > 5:
            u = uni(f[5])
            if u: e['u'] = u
            elif len(f[5]) == 1 and f[5] != 'x': e['u'] = f[5]
        out.setdefault(name, e)
    else:
        e = {'i': kind}
        if len(f) > 2 and f[2] != 'none': e['x'] = f[2]
        out.setdefault(name, e)
# Not in lib/symbols, but supported end-to-end (parse -> KaTeX -> writer): amsmath operators
for extra in ('operatorname', 'operatorname*'):
    out.setdefault(extra, {'i': 'font', 'x': 'mathmode'})
# The shipped table wins for entries it already has: it carries manual fixes and entries from
# other lib/symbols versions (\uline, the text sizes, \bmod ...) — a regen must never drop them.
try:
    shipped = json.load(open(dst))
    for k, v in shipped.items(): out[k] = v
except FileNotFoundError:
    pass
json.dump(out, open(dst, 'w'), ensure_ascii=False, separators=(',', ':'))
from collections import Counter
print(len(out), 'entries', Counter(e['i'] for e in out.values()))
