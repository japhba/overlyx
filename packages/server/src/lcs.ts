/**
 * Longest common subsequences of two key lists — the block diffs of the Google Docs and LessWrong
 * syncs (gdocs/sync.ts, lesswrong/model.ts).
 */

/** the index pairs of a longest common subsequence of `a` and `b` */
export function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length, W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) dp[x * W + y] = a[x] === b[y] ? dp[(x + 1) * W + y + 1] + 1 : Math.max(dp[(x + 1) * W + y], dp[x * W + y + 1]);
  const out: [number, number][] = [];
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push([x, y]); x++; y++; } else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) x++; else y++;
  }
  return out;
}

/** the regions where `a` and `b` differ: a[a..b) became b[c..d) */
export function lcsRegions(a: string[], b: string[]): { a: number; b: number; c: number; d: number }[] {
  const out: { a: number; b: number; c: number; d: number }[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...lcsPairs(a, b), [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) out.push({ a: i, b: pi, c: j, d: pj });
    i = pi + 1; j = pj + 1;
  }
  return out;
}
