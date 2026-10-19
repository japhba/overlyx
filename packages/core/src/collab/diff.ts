/**
 * Sequence diff (Myers' O(ND) algorithm) for the writer: which tokens of the old sequence stay,
 * which go, which are new. Common prefix and suffix are matched first; beyond `maxD` differences
 * the middle is replaced as a whole (a document rewritten from scratch need not be diffed char by
 * char).
 */

/** a run of the edit script: `len` tokens kept (a[a0…], b[b0…]), deleted (a[a0…]) or inserted (b[b0…]) */
export interface Run { op: 'eq' | 'del' | 'ins'; a0: number; b0: number; len: number }

export function diffKeys(a: readonly string[], b: readonly string[], maxD = 1200): Run[] {
  let pre = 0;
  const min = Math.min(a.length, b.length);
  while (pre < min && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < min - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const runs: Run[] = [];
  const push = (op: Run['op'], a0: number, b0: number, len: number) => {
    if (len <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last.op === op && last.a0 + (op === 'ins' ? 0 : last.len) === a0 && last.b0 + (op === 'del' ? 0 : last.len) === b0) last.len += len;
    else runs.push({ op, a0, b0, len });
  };
  push('eq', 0, 0, pre);
  const n = a.length - pre - suf, m = b.length - pre - suf;
  if (n === 0) push('ins', pre, pre, m);
  else if (m === 0) push('del', pre, pre, n);
  else {
    const script = myers(a, b, pre, n, m, maxD);
    if (!script) { push('del', pre, pre, n); push('ins', pre + n, pre, m); }
    else for (const r of script) push(r.op, r.a0, r.b0, r.len);
  }
  push('eq', a.length - suf, b.length - suf, suf);
  return runs;
}

/** Myers on a[off, off+n) and b[off, off+m); null when more than maxD edits are needed */
function myers(a: readonly string[], b: readonly string[], off: number, n: number, m: number, maxD: number): Run[] | null {
  const max = Math.min(n + m, maxD);
  const v = new Int32Array(2 * max + 3);
  const at = (k: number) => k + max + 1;
  // trace[d]: V before round d, for k in [-d-1, d+1] (index k + d + 1)
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(at(-d - 1), at(d + 1) + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[at(k - 1)] < v[at(k + 1)])) x = v[at(k + 1)];
      else x = v[at(k - 1)] + 1;
      let y = x - k;
      while (x < n && y < m && a[off + x] === b[off + y]) { x++; y++; }
      v[at(k)] = x;
      if (x >= n && y >= m) { found = d; break outer; }
    }
  }
  if (found < 0) return null;
  // backtrack
  const out: Run[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const pvk = (k: number) => pv[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && pvk(k - 1) < pvk(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = pvk(pk);
    const py = px - pk;
    // the diagonal after the edit
    const sx = down ? px : px + 1, sy = down ? py + 1 : py;
    if (x > sx) out.push({ op: 'eq', a0: off + sx, b0: off + sy, len: x - sx });
    if (down) out.push({ op: 'ins', a0: off + px, b0: off + py, len: 1 });
    else out.push({ op: 'del', a0: off + px, b0: off + py, len: 1 });
    x = px; y = py;
  }
  if (x > 0) out.push({ op: 'eq', a0: off, b0: off, len: x });
  return out.reverse();
}
