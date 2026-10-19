// "Report Issue": builds a prefilled GitHub new-issue URL from diagnostics + the last error. Pure (no telemetry:
// nothing is sent anywhere, the URL is opened in the user's browser). Owned by ui-app.
import type { AppError, Diagnostics } from '../../types';

export const ISSUES_NEW_URL = 'https://github.com/flashrifle/Lanes/issues/new';
export const MAX_URL_LENGTH = 7500;
const STDERR_TAIL_LINES = 20;
const STDERR_START_CHARS = 2000;

/**
 * Replace the user's home directory by `~` (explicit `home` first, then generic /Users/<n>, /home/<n>, and
 * Windows C:\Users\<n>).
 */
export function redactHome(text: string, home?: string | null): string {
  let out = text;
  if (home && home.length > 1) out = out.split(home.replace(/[\\/]+$/, '')).join('~');
  return out
    .replace(/\/Users\/[^/\s'"`:]+/g, '~')
    .replace(/\/home\/[^/\s'"`:]+/g, '~')
    .replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`:]+/gi, '~');
}

/** `scheme://user:token@host` → `scheme://***@host` (credentials in remote URLs). */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@'"`]+@/gi, '$1***@');
}

/** Everything that may identify the user or leak a secret. */
export function redact(text: string, home?: string | null): string {
  return redactUserinfo(redactHome(text, home));
}

/** Replace lone surrogates by U+FFFD (encodeURIComponent throws on them). */
export function wellFormed(s: string): string {
  const native = (s as { toWellFormed?: () => string }).toWellFormed;
  if (typeof native === 'function') return native.call(s);
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** Code-point length / slices: never cut a surrogate pair in half. */
const cps = (s: string): string[] => Array.from(s);
export const cpLength = (s: string): number => cps(s).length;
export const cpHead = (s: string, n: number): string => cps(s).slice(0, Math.max(0, n)).join('');
export const cpTail = (s: string, n: number): string => (n <= 0 ? '' : cps(s).slice(-n).join(''));

/** Last `maxLines` non-empty lines, additionally capped to the last `maxChars` characters. */
export function stderrTail(stderr: string | null | undefined, maxLines = STDERR_TAIL_LINES, maxChars = STDERR_START_CHARS): string {
  if (!stderr) return '';
  const lines = stderr.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  let tail = lines.slice(-maxLines).join('\n');
  if (cpLength(tail) > maxChars) tail = '…' + cpTail(tail, maxChars);
  return tail;
}

export interface ReportInput {
  diagnostics: Diagnostics | null;
  error: AppError | null;
  home?: string | null;
}

export interface ReportIssue {
  url: string;
  title: string;
  body: string;
}

const clip = (s: string, n: number): string => (cpLength(s) <= n ? s : cpHead(s, n - 1) + '…');

function fence(text: string): string {
  // a ``` inside stderr would break the block
  return '```\n' + text.replace(/```/g, "'''") + '\n```';
}

function compose(input: ReportInput, stderrChars: number, messageChars: number): { title: string; body: string } {
  const { diagnostics: d, error: e, home } = input;
  const r = (s: string) => redact(wellFormed(s), home);
  const title = e ? `[Bug] ${e.code}: ${clip(r(e.message).replace(/\s+/g, ' '), 80)}` : '[Bug] ';
  const lines: string[] = ['**What happened?**', '', '<!-- Describe what you did and what you expected. -->', '', '**Environment**', ''];
  if (d) {
    lines.push(`- Lanes: ${d.appVersion}`, `- OS: ${d.os} (${d.arch})`, `- git: ${d.gitVersion ?? 'not found'}${d.gitPath ? ` (${r(d.gitPath)})` : ''}`);
    if (d.locale) lines.push(`- Locale: ${d.locale}`);
  } else {
    lines.push('- (diagnostics unavailable)');
  }
  if (e) {
    lines.push('', '**Last error**', '', `- code: \`${e.code}\``, `- message: ${clip(r(e.message).replace(/\s+/g, ' '), messageChars)}`);
    const tail = stderrChars > 0 ? stderrTail(r(e.stderr ?? ''), STDERR_TAIL_LINES, stderrChars) : '';
    if (tail) lines.push('', 'stderr (tail):', '', fence(tail));
  }
  return { title, body: lines.join('\n') };
}

const urlFor = (title: string, body: string): string =>
  `${ISSUES_NEW_URL}?title=${encodeURIComponent(wellFormed(title))}&body=${encodeURIComponent(wellFormed(body))}`;

/** Build the issue; shrinks stderr, then the message, then the body until the URL is <= MAX_URL_LENGTH. */
export function buildReportIssue(input: ReportInput): ReportIssue {
  let stderrChars = STDERR_START_CHARS;
  let messageChars = 600;
  for (;;) {
    const { title, body } = compose(input, stderrChars, messageChars);
    const url = urlFor(title, body);
    if (url.length <= MAX_URL_LENGTH) return { url, title, body };
    if (stderrChars > 0) stderrChars = stderrChars > 200 ? Math.floor(stderrChars / 2) : 0;
    else if (messageChars > 120) messageChars = Math.floor(messageChars / 2);
    else {
      // last resort: truncate the body itself (percent-encoding can inflate by 3x for non-ASCII)
      let b = body;
      let u = url;
      while (u.length > MAX_URL_LENGTH && b.length > 0) {
        b = cpHead(b, Math.floor(cpLength(b) * 0.8));
        u = urlFor(title, b);
      }
      return { url: u, title, body: b };
    }
  }
}
