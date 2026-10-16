const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "오늘 오후 5:23" / "어제 오후 5:23" / "2026. 10. 3." — `ts` in unix seconds. */
export function formatCommitDate(ts: number, now: Date = new Date()): string {
  const d = new Date(ts * 1000);
  if (sameDay(d, now)) return `오늘 ${timeFmt.format(d)}`;
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, y)) return `어제 ${timeFmt.format(d)}`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

/** Full date for tooltips / details: "2026. 10. 3. 오후 5:23". */
export function formatFullDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${timeFmt.format(d)}`;
}
