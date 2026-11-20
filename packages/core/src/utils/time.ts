/**
 * Return an ISO 8601 timestamp string with local timezone offset.
 *
 * Example: "2026-04-09T19:49:44.718+08:00" (instead of UTC "...Z")
 */
export function nowISO(): string {
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, '0');
  const mm = String(absOff % 60).padStart(2, '0');

  const pad = (n: number, len = 2) => String(n).padStart(len, '0');

  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}${sign}${hh}:${mm}`
  );
}
