"""Which vision model reads handwritten formulas best (the math keyboard's pen, server ai.ts recognizeInk)?

Google's MathWriting test inks (human handwriting, downloaded once: the 1.6 MB excerpt) are drawn the way
the pen pad draws its ink (client editor/mathkbd/ink.ts inkLayout: median letter height 40 px, 3 px round
strokes, black on white, 20 px margin, at most 1400 x 700) and sent with the server's own INK_PROMPT;
scored by normalised exact match (top reading, any of three) and token error rate, with latency.

usage (the key never needs to be printed):
  systemd-run --pipe --wait -p EnvironmentFile=/root/lyx/overlyx/deploy/secrets.env \
    python3 -I /root/lyx/overlyx/scripts/ink-bench.py google/gemini-3.5-flash-lite anthropic/claude-haiku-5.5 …
  N=100 (default) samples; results per model in /tmp/ink-bench/<model>.json
"""
import base64, concurrent.futures as cf, json, os, random, re, subprocess, sys, time, urllib.request
import xml.etree.ElementTree as ET

NS = '{http://www.w3.org/2003/InkML}'

def load(path):
    root = ET.parse(path).getroot()
    ann = {a.get('type'): a.text for a in root.iter(NS + 'annotation')}
    strokes = []
    for tr in root.iter(NS + 'trace'):
        pts = []
        for p in tr.text.strip().split(','):
            v = p.split()
            pts.append((float(v[0]), float(v[1])))
        strokes.append(pts)
    return ann.get('normalizedLabel') or ann.get('label'), strokes

def median(xs):
    s = sorted(xs); n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

def render(strokes, png):
    xs = [x for s in strokes for x, _ in s]; ys = [y for s in strokes for _, y in s]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    hs = [max(y for _, y in s) - min(y for _, y in s) for s in strokes]
    big = [h for h in hs if h > 0.15 * max(1e-6, max(hs))] or hs
    k = 40 / max(1e-6, median(big))
    pad, sw = 20, 3
    w, h = (x1 - x0) * k + 2 * pad, (y1 - y0) * k + 2 * pad
    c = min(1, 1400 / w, 700 / h)
    k *= c; w *= c; h *= c
    paths = []
    for s in strokes:
        pts = [((x - x0) * k + pad * c, (y - y0) * k + pad * c) for x, y in s]
        if len(pts) == 1: pts = pts + [(pts[0][0] + 0.1, pts[0][1])]
        paths.append('<polyline points="%s"/>' % ' '.join('%.1f,%.1f' % p for p in pts))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d"><rect width="100%%" height="100%%" fill="#fff"/>'
           '<g fill="none" stroke="#000" stroke-width="%.1f" stroke-linecap="round" stroke-linejoin="round">%s</g></svg>'
           % (round(w), round(h), max(2, sw * c), ''.join(paths)))
    subprocess.run(['rsvg-convert', '-o', png], input=svg.encode(), check=True)

HERE = os.path.dirname(os.path.abspath(__file__))
_ai = open(os.path.join(HERE, '..', 'packages', 'server', 'src', 'ai.ts'), encoding='utf-8').read()
PROMPT = re.search(r'export const INK_PROMPT = `([\s\S]*?)`;', _ai).group(1).replace('\\\\', '\\')
DATA_URL = 'https://storage.googleapis.com/mathwriting_data/mathwriting-2024-excerpt.tgz'

def ask(model, png, retries=2):
    b64 = base64.b64encode(open(png, 'rb').read()).decode()
    body = {
        'model': model, 'temperature': 0, 'max_tokens': 400,
        'messages': [
            {'role': 'system', 'content': PROMPT},
            {'role': 'user', 'content': [
                {'type': 'text', 'text': 'The cursor is in an empty formula.'},
                {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + b64}},
            ]},
        ],
    }
    if model.startswith('google/gemini-3.8') or model.startswith('google/gemini-3.7'): body['reasoning'] = {'effort': 'low'}
    if model.startswith('openai/gpt-5'): body['reasoning'] = {'effort': 'minimal'}; body.pop('temperature')
    req = urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['OPENROUTER_API_KEY'],
                                          'X-Title': 'OverLyX ink bench'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.load(r)
    except Exception as e:
        if retries: time.sleep(2); return ask(model, png, retries - 1)
        return None, time.time() - t0, str(e)
    txt = j.get('choices', [{}])[0].get('message', {}).get('content') or ''
    return txt, time.time() - t0, j.get('usage')

FUNS = 'arccos arcsin arctan arg cos cosh cot coth csc deg det dim exp gcd hom inf ker lg lim liminf limsup ln log max min sec sin sinh sup tan tanh Pr mod bmod pmod'.split()

def norm(s):
    s = s.strip().strip('$')
    s = s.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    s = re.sub(r'\\(left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|big|Big|bigg|Bigg)(?![a-zA-Z])', '', s)
    s = re.sub(r'\\(displaystyle|textstyle|limits|nolimits)(?![a-zA-Z])', '', s)
    s = re.sub(r'\\(mathrm|operatorname|text|textrm|mathit|mathnormal)\{([^{}]*)\}', r'\2', s)
    s = re.sub(r'\\(d|t)frac', r'\\frac', s)
    for a, b in [(r'\cdots', r'\cdot\cdot\cdot'), (r'\ldots', '...'), (r'\dots', '...'), (r'\to', r'\rightarrow'), (r'\gets', r'\leftarrow'),
                 (r'\le', r'\leq'), (r'\ge', r'\geq'), (r'\ne', r'\neq'), (r'\lvert', '|'), (r'\rvert', '|'), (r'\vert', '|'), (r'\mid', '|'),
                 (r'\|', '||'), (r'\lVert', '||'), (r'\rVert', '||'), (r'\Vert', '||'), (r'\lbrace', r'\{'), (r'\rbrace', r'\}'), (r'\colon', ':'),
                 (r'\varepsilon', r'\epsilon'), (r'\vartheta', r'\theta'), (r'\varphi', r'\phi'), (r'\emptyset', r'\varnothing'), (r'\ast', '*'), (r'\prime', "'"),
                 (r'\land', r'\wedge'), (r'\lor', r'\vee'), (r'\lnot', r'\neg'), (r'\implies', r'\Rightarrow'), (r'\iff', r'\Leftrightarrow')]:
        s = re.sub(re.escape(a) + r'(?![a-zA-Z])', lambda m: b, s)
    for env, l, r in [('pmatrix', '(', ')'), ('bmatrix', '[', ']'), ('vmatrix', '|', '|'), ('Bmatrix', r'\{', r'\}')]:
        s = s.replace(r'\begin{%s}' % env, l + r'\begin{matrix}').replace(r'\end{%s}' % env, r'\end{matrix}' + r)
    s = re.sub(r'\\(' + '|'.join(FUNS) + r')(?![a-zA-Z])', r'\1', s)
    s = re.sub(r'\\[,;:! ]|~|\\quad|\\qquad', '', s)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'\s*(?<![a-zA-Z\\])\s*', '', s)  # drop spaces not separating a command from a letter
    s = re.sub(r'\s+', '', s) if not re.search(r'\\[a-zA-Z]+\s[a-zA-Z]', s) else re.sub(r'(?<!\\[a-zA-Z])\s+', '', s)
    # single-token scripts braced: x^2 -> x^{2}
    s = re.sub(r'([\^_])(\\[a-zA-Z]+|[^{\\])', r'\1{\2}', s)
    # braces around a single token dropped inside commands' args stay; remove redundant {x} groups not after ^_ or a command
    s = re.sub(r'(?<![\^_}a-zA-Z])\{([a-zA-Z0-9])\}', r'\1', s)
    return s

def tokens(s):
    return re.findall(r'\\[a-zA-Z]+|\\.|.', s)

def ed(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]

def parse_reply(txt):
    if not txt: return []
    t = txt.strip()
    m = re.search(r'\{[\s\S]*\}', t)
    if m:
        try:
            j = json.loads(m.group(0))
            c = j.get('latex') or j.get('candidates') or []
            if isinstance(c, str): c = [c]
            return [x for x in c if isinstance(x, str)]
        except Exception:
            pass
    return [t.strip('`').strip()]

def main():
    models = sys.argv[1:]
    if not models: sys.exit(__doc__)
    out = '/tmp/ink-bench'
    src = os.path.join(out, 'data', 'mathwriting-2024-excerpt', 'test')
    if not os.path.isdir(src):
        os.makedirs(os.path.join(out, 'data'), exist_ok=True)
        tgz = os.path.join(out, 'excerpt.tgz')
        urllib.request.urlretrieve(DATA_URL, tgz)
        subprocess.run(['tar', '-xzf', tgz, '-C', os.path.join(out, 'data')], check=True)
    os.makedirs(out, exist_ok=True)
    files = sorted(f for f in os.listdir(src) if f.endswith('.inkml'))
    n = int(os.environ.get('N', '100'))
    random.Random(7).shuffle(files); files = files[:n]
    items = []
    for f in files:
        label, strokes = load(os.path.join(src, f))
        png = os.path.join(out, f.replace('.inkml', '.png'))
        if not os.path.exists(png): render(strokes, png)
        items.append((f, label, png))
    for model in models:
        res = []
        def one(it):
            f, label, png = it
            txt, dt, usage = ask(model, png)
            cands = parse_reply(txt)
            gold = norm(label)
            top = norm(cands[0]) if cands else ''
            any3 = any(norm(c) == gold for c in cands[:3])
            return {'id': f, 'gold': label, 'reply': txt, 'cands': cands, 'ok': top == gold, 'ok3': any3,
                    'ter': ed(tokens(top), tokens(gold)) / max(1, len(tokens(gold))), 'dt': dt, 'usage': usage}
        with cf.ThreadPoolExecutor(8) as ex:
            res = list(ex.map(one, items))
        ok = sum(r['ok'] for r in res) / len(res); ok3 = sum(r['ok3'] for r in res) / len(res)
        ter = sum(min(1, r['ter']) for r in res) / len(res)
        dts = sorted(r['dt'] for r in res)
        print('%-36s top1 %.0f%%  top3 %.0f%%  TER %.3f  latency p50 %.2fs p90 %.2fs' % (model, ok * 100, ok3 * 100, ter, dts[len(dts) // 2], dts[int(len(dts) * .9)]), flush=True)
        json.dump(res, open(os.path.join(out, model.replace('/', '_') + '.json'), 'w'), indent=1)

if __name__ == '__main__':
    main()
