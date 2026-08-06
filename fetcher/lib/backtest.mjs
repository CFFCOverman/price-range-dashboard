/* lib/backtest.mjs —— 把 tools/backtest.mjs 挂到抓取流程上:菜单 bt 手动跑,每月一次自动跑
 *
 * 这里只管"什么时候跑、跑完往哪记",一条统计逻辑都不放 —— 那些全在 tools/backtest.mjs 里。
 * 分开是因为两边的寿命不一样:回测口径会随着数据变长一改再改,而"每月一次"这条规矩不该跟着改。
 *
 * 有一件事这个文件**不做**,而且是故意不做:它不会根据回测结果去动任何权重。
 * 理由不是谨慎,是算术 —— 一年日线满打满算只有约 32 个不重叠的 21 日窗口,
 * 看见红灯就调参,调的是这 32 个窗口的噪声,不是模型。报告可以自动出,手必须是人的。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOG_DIR, ROOT_DIR } from './config.mjs';

export const BT_SCRIPT = path.join(ROOT_DIR, 'tools', 'backtest.mjs');
export const BT_HISTORY = path.join(LOG_DIR, 'backtest-history.csv');

/** 台账正文里最新那一轮是哪天跑的;一行合法的都没有就返回 null。
 *  取**最大**而不是最后一行:文件是追加写的,但同日重跑会重排,不能假定末行最新。
 *  拆成纯函数是为了 --selftest 测得到 —— 读盘那一层混着 fs,自检只能干看着。 */
export function pickLastRunDate(csvText) {
  let last = null;
  for (const l of String(csvText || '').split(/\r?\n/).slice(1)) {
    const d = l.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!last || d > last)) last = d;
  }
  return last;
}

/** 台账里最新那一轮是哪天跑的;没跑过 / 读不出来都返回 null(纯读,不抛)。 */
export function lastBacktestDate() {
  try { return pickLastRunDate(fs.readFileSync(BT_HISTORY, 'utf8')); } catch { return null; }
}

/** 这个月还没跑过就该跑。
 *  按**自然月**比,不是"距上次满 30 天":后者会让跑批日期每月往后漂几天,
 *  漂上半年就分不清"这轮是几月那一轮"了,而这份台账的全部用处就是回头对轮次。 */
export function backtestDue(todayISO, last = lastBacktestDate()) {
  return !last || last.slice(0, 7) !== String(todayISO).slice(0, 7);
}

/** 退出码翻成人话。3 是 tools/backtest.mjs 自己约定的"缺依赖",
 *  别的非零一律当"跑挂了" —— 具体错误它已经原样打在终端上了,这里再转述一遍是噪音。
 *  拆成纯函数只为一件事:让 --selftest 能钉住 3 这个约定。
 *  这个码要是哪天两边对不上,表现是"装依赖的提示不出现",在终端上看不出任何异常。 */
export function btExitNote(code) {
  if (code === 0) return null;
  if (code === 3) return '回测缺依赖:xlsx 没装。在 fetcher/ 里跑一次 npm i xlsx 就好(上面已列出找过的目录)。';
  return `exit ${code}`;
}

/**
 * 跑一轮回测。stdio 直接继承,报告原样打在终端上 —— 不截获、不转述。
 * @returns {{ok:boolean, skipped?:string, code?:number}}
 */
export function runBacktest({ log = true } = {}) {
  if (!fs.existsSync(BT_SCRIPT)) return { ok: false, skipped: '找不到 tools/backtest.mjs' };
  const args = [BT_SCRIPT]; if (log) args.push('--log');
  /* cwd 用仓库根只是为了让子进程打出来的相对路径读着顺眼。
   * 它**不影响** import 'xlsx' 能不能解析 —— 裸模块名是从引用文件自己的目录往上找的,
   * 跟 cwd 无关(v16.8 这里写错过一次,真机上就崩在这)。依赖怎么找见 tools/backtest.mjs 顶部。 */
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT_DIR });
  if (r.error) return { ok: false, skipped: r.error.message };
  return { ok: r.status === 0, code: r.status, skipped: btExitNote(r.status) || undefined };
}

/** 抓完一轮后调用:这个月还没跑过就顺手跑一轮,跑过就一个字都不说。
 *  注意先打这行提示再跑 —— 回测要几秒,不说一声用户会以为卡住了。 */
export function maybeMonthlyBacktest(todayISO) {
  if (!backtestDue(todayISO)) return { ran: false };
  const last = lastBacktestDate();
  console.log(`\n\x1b[1m每月回测\x1b[0m  ${last ? '上一轮是 ' + last + ',' : '还没跑过,'}这个月该跑了 —— 只出报告,不改任何权重。`);
  const r = runBacktest({ log: true });
  if (!r.ok) console.log(`  \x1b[33m回测没跑成(${r.skipped || 'exit ' + r.code}),不影响这轮抓取的数据。\x1b[0m`);
  return { ran: true, ...r };
}
