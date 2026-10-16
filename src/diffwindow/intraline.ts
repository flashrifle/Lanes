// Word/token-level ("intraline") diff, modelled after IntelliJ's ByWord comparison.
// Pure; no DOM. Ranges are UTF-16 offsets [start, end) into the compared strings.

export type Range = [start: number, end: number];

export interface IntralineResult {
  left: Range[];
  right: Range[];
}

/** Lines longer than this are never word-diffed (whole-line highlight only). */
export const MAX_LINE_CHARS = 2000;
/** Total chars per side above which a (multi-line) block is not word-diffed. */
export const MAX_TEXT_CHARS = 20000;
/** Token count per side above which we give up. */
const MAX_TOKENS = 6000;
/** Myers edit-distance cap. */
const MAX_D = 1500;
/** Below this fraction of shared non-whitespace chars the texts are "too dissimilar". */
const MIN_SIMILARITY = 0.15;

// Words (letters/digits/_), horizontal whitespace runs, a newline, or a single other char.
const TOKEN_RE = /[\p{L}\p{N}\p{M}_]+|[^\S\n]+|\n|[^]/gu;

export interface Token {
  text: string;
  start: number;
}

export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(s)) !== null) out.push({ text: m[0], start: m.index });
  return out;
}

const isWs = (t: string) => /^[^\S\n]+$/.test(t);

/**
 * Myers O(ND) diff over integer sequences. Returns a boolean "changed" mask per element of a and b,
 * or null if the edit distance exceeds maxD.
 */
export function myersDiff(a: ArrayLike<number>, b: ArrayLike<number>, maxD = MAX_D): { a: Uint8Array; b: Uint8Array } | null {
  const n = a.length;
  const m = b.length;
  const ca = new Uint8Array(n);
  const cb = new Uint8Array(m);
  // trim common prefix/suffix
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const N = n - pre - suf;
  const M = m - pre - suf;
  if (N === 0 && M === 0) return { a: ca, b: cb };
  if (N === 0) { cb.fill(1, pre, pre + M); return { a: ca, b: cb }; }
  if (M === 0) { ca.fill(1, pre, pre + N); return { a: ca, b: cb }; }

  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[pre + x] === b[pre + y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break outer; }
    }
  }
  if (found < 0) return null;
  // backtrack
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (x === prevX) cb[pre + prevY] = 1; // insertion from b
    else ca[pre + prevX] = 1; // deletion from a
    x = prevX;
    y = prevY;
  }
  return { a: ca, b: cb };
}

function toRanges(tokens: Token[], changed: Uint8Array): Range[] {
  const out: Range[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!changed[i]) continue;
    const t = tokens[i];
    if (t.text === '\n') continue; // never highlight line breaks
    const start = t.start;
    const end = t.start + t.text.length;
    const last = out[out.length - 1];
    if (last && last[1] === start) last[1] = end;
    else out.push([start, end]);
  }
  return out;
}

/**
 * Word-level diff of two texts (may contain '\n'). Returns changed ranges per side, or null when
 * the texts are too long or too dissimilar for a meaningful word diff (caller highlights whole lines).
 * Whitespace-only gaps between two changed words are absorbed into the highlight (IntelliJ-like).
 */
export function diffWords(left: string, right: string): IntralineResult | null {
  if (left === right) return { left: [], right: [] };
  if (left.length > MAX_TEXT_CHARS || right.length > MAX_TEXT_CHARS) return null;
  if (hasLongLine(left) || hasLongLine(right)) return null;
  const ta = tokenize(left);
  const tb = tokenize(right);
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return null;

  const ids = new Map<string, number>();
  const intern = (t: Token) => {
    let id = ids.get(t.text);
    if (id === undefined) { id = ids.size; ids.set(t.text, id); }
    return id;
  };
  const ia = Int32Array.from(ta, intern);
  const ib = Int32Array.from(tb, intern);
  const res = myersDiff(ia, ib);
  if (!res) return null;

  absorbWhitespace(ta, res.a, tb, res.b);

  // similarity on non-whitespace chars
  const shared = (toks: Token[], ch: Uint8Array) => {
    let same = 0, total = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i].text;
      if (t === '\n' || isWs(t)) continue;
      total += t.length;
      if (!ch[i]) same += t.length;
    }
    return { same, total };
  };
  const sa = shared(ta, res.a);
  const sb = shared(tb, res.b);
  const denom = Math.max(sa.total, sb.total);
  if (denom > 0 && sa.same / denom < MIN_SIMILARITY) return null;

  return { left: toRanges(ta, res.a), right: toRanges(tb, res.b) };
}

function hasLongLine(s: string): boolean {
  if (s.length <= MAX_LINE_CHARS) return false;
  let start = 0;
  for (;;) {
    const nl = s.indexOf('\n', start);
    const end = nl < 0 ? s.length : nl;
    if (end - start > MAX_LINE_CHARS) return true;
    if (nl < 0) return false;
    start = nl + 1;
  }
}

/**
 * Equal whitespace tokens sandwiched between changed tokens on BOTH sides are marked changed on both
 * sides, so "a b c" → "x y z" highlights as one run instead of three words.
 */
function absorbWhitespace(ta: Token[], ca: Uint8Array, tb: Token[], cb: Uint8Array) {
  // Walk the equal alignment: equal tokens appear in the same order on both sides.
  let i = 0;
  let j = 0;
  while (i < ta.length && j < tb.length) {
    if (ca[i]) { i++; continue; }
    if (cb[j]) { j++; continue; }
    // ta[i] matches tb[j]
    if (
      isWs(ta[i].text) &&
      i > 0 && i + 1 < ta.length && ca[i - 1] && ca[i + 1] &&
      j > 0 && j + 1 < tb.length && cb[j - 1] && cb[j + 1]
    ) {
      ca[i] = 1;
      cb[j] = 1;
    }
    i++;
    j++;
  }
}
