const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const p2 = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

/** Compact: "오늘 10:43" / "어제 14:00" / "10월 14일" / "2025년 10월 14일" — `ts` in unix seconds. */
export function formatCommitDate(ts: number, now: Date = new Date()): string {
  const d = new Date(ts * 1000);
  if (sameDay(d, now)) return `오늘 ${hm(d)}`;
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, y)) return `어제 ${hm(d)}`;
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}년 ${md}`;
}

/** Full date for tooltips / details: "2026. 10. 3. 오후 5:23". */
export function formatFullDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${timeFmt.format(d)}`;
}
