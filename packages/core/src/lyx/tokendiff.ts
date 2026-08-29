/**
 * Word-level LCS diff, used to turn a plain-text edit (old paragraph text → new paragraph text)
 * into the minimal set of inserted/deleted runs — the shape change-tracking needs (see
 * server/src/mcp.ts's propose_edit tool, which turns each run into a change-tagged TextItem).
 */
export interface DiffToken { type: 'same' | 'add' | 'del'; text: string }

/** Splits into alternating word / whitespace runs, e.g. "foo  bar" -> ["foo", "  ", "bar"]. */
export function tokenize(text: string): string[] {
  return text.match(/\S+|\s+/g) ?? [];
}

/** LCS diff over token arrays (used with word/whitespace tokens from `tokenize`). */
export function diffTokens(a: string[], b: string[]): DiffToken[] {
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffToken[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/** Coalesces consecutive same-type tokens (fewer, longer runs — one TextItem each downstream). */
export function coalesce(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && last.type === t.type) last.text += t.text;
    else out.push({ ...t });
  }
  return out;
}

/** `oldText` -> `newText` as coalesced same/del/add runs, ready to become change-tagged TextItems. */
export function diffText(oldText: string, newText: string): DiffToken[] {
  return coalesce(diffTokens(tokenize(oldText), tokenize(newText)));
}
