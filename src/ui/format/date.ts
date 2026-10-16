import { locale, t } from '../../i18n';

let timeFmt: Intl.DateTimeFormat | null = null;
let timeFmtLocale = '';
function fmtTime(d: Date): string {
  if (!timeFmt || timeFmtLocale !== locale) {
    timeFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    timeFmtLocale = locale;
  }
  return timeFmt.format(d);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const p2 = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

/**
 * Compact (ko): "오늘 10:43" / "어제 14:00" / "10월 14일" / "2025년 10월 14일".
 * Compact (en): "Today 10:43" / "Yesterday 14:00" / "Oct 14" / "Oct 14, 2025". `ts` in unix seconds.
 */
export function formatCommitDate(ts: number, now: Date = new Date()): string {
  const d = new Date(ts * 1000);
  if (sameDay(d, now)) return t('date.today', { time: hm(d) });
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, y)) return t('date.yesterday', { time: hm(d) });
  const md = t('date.monthDay', { month: d.getMonth() + 1, day: d.getDate() });
  return d.getFullYear() === now.getFullYear() ? md : t('date.yearMonthDay', { year: d.getFullYear(), md });
}

/** Full date for tooltips / details: ko "2026. 10. 3. 오후 5:23", en "Oct 3, 2026, 5:23 PM". */
export function formatFullDate(ts: number): string {
  const d = new Date(ts * 1000);
  return t('date.full', { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), time: fmtTime(d) });
}
