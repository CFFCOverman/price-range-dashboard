/* US listed-options regular session clock (America/New_York).
 * The calendar covers the standard full-day exchange holidays plus common 13:00 early closes.
 * A no-volume backoff in the collector is the safety net for exceptional exchange closures. */
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const DAY = 86400000;
function parts(date) {
  const out = {};
  for (const x of fmt.formatToParts(date)) if (x.type !== 'literal') out[x.type] = x.value;
  return { y: +out.year, m: +out.month, d: +out.day, wd: out.weekday,
    minute: +out.hour * 60 + +out.minute, ymd: `${out.year}-${out.month}-${out.day}` };
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
function nthWeekday(y, m, weekday, nth) {
  const first = new Date(Date.UTC(y, m - 1, 1));
  return 1 + (weekday - first.getUTCDay() + 7) % 7 + (nth - 1) * 7;
}
function lastWeekday(y, m, weekday) {
  const last = new Date(Date.UTC(y, m, 0));
  return last.getUTCDate() - (last.getUTCDay() - weekday + 7) % 7;
}
function observed(y, m, d) {
  const x = new Date(Date.UTC(y, m - 1, d)), wd = x.getUTCDay();
  if (wd === 6) x.setUTCDate(x.getUTCDate() - 1);
  if (wd === 0) x.setUTCDate(x.getUTCDate() + 1);
  return ymd(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}
function easter(y) {
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
  const l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31);
  return new Date(Date.UTC(y, month-1, (h+l-7*m+114)%31+1));
}
export function optionHolidays(y) {
  const e = easter(y), goodFriday = new Date(+e - 2 * DAY);
  return new Set([
    observed(y,1,1), ymd(y,1,nthWeekday(y,1,1,3)), ymd(y,2,nthWeekday(y,2,1,3)),
    ymd(y,goodFriday.getUTCMonth()+1,goodFriday.getUTCDate()), ymd(y,5,lastWeekday(y,5,1)),
    observed(y,6,19), observed(y,7,4), ymd(y,9,nthWeekday(y,9,1,1)),
    ymd(y,11,nthWeekday(y,11,4,4)), observed(y,12,25),
  ]);
}
export function earlyCloseDates(y) {
  const thanksgiving = nthWeekday(y,11,4,4);
  const out = new Set([ymd(y,11,thanksgiving+1)]);
  const july3 = new Date(Date.UTC(y,6,3));
  if (july3.getUTCDay() >= 1 && july3.getUTCDay() <= 5 && observed(y,7,4) !== ymd(y,7,3)) out.add(ymd(y,7,3));
  const dec24 = new Date(Date.UTC(y,11,24));
  if (dec24.getUTCDay() >= 1 && dec24.getUTCDay() <= 5 && observed(y,12,25) !== ymd(y,12,24)) out.add(ymd(y,12,24));
  return out;
}
export function optionSession(now = new Date()) {
  const p = parts(now), weekday = !['Sat','Sun'].includes(p.wd), holiday = optionHolidays(p.y).has(p.ymd);
  const closeMinute = earlyCloseDates(p.y).has(p.ymd) ? 13*60 : 16*60;
  const open = weekday && !holiday && p.minute >= 9*60+30 && p.minute < closeMinute;
  return { ...p, open, holiday, earlyClose: closeMinute === 13*60, closeMinute };
}
export function nextOptionOpen(now = new Date()) {
  let t = new Date(Math.ceil((+now + 60000) / 300000) * 300000);
  for (let i=0;i<12*24*7;i++,t=new Date(+t+300000)) {
    const s=optionSession(t);
    if (s.open && s.minute >= 9*60+35) return t;
  }
  return new Date(+now + DAY);
}
export function optionPollPlan(now = new Date(), idleRounds = 0) {
  const session = optionSession(now);
  if (!session.open) {
    const next = nextOptionOpen(now);
    return { delayMs: Math.max(60000, +next - +now), reason: session.holiday ? 'market holiday' : 'market closed', next, session };
  }
  const minutes = idleRounds >= 2 ? Math.min(60, 15 * (2 ** (idleRounds - 1))) : 15;
  return { delayMs: minutes*60000, reason: idleRounds >= 2 ? `no new volume; backoff ${minutes}m` : 'regular session', next: new Date(+now+minutes*60000), session };
}
