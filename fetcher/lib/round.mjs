/* lib/round.mjs — 一轮拉取的编排(公司 × 8 步 + 市场序列)
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { ensureBrowser } from './browser.mjs';
import { COMPANIES_CSV, CSV_HEADER, FRESH_HOURS, isFresh, priceMap } from './companies.mjs';
import { APP_HTML, OPEN_DASHBOARD } from './config.mjs';
import { SOURCES_FILE, ledger, noteArtifact, stampUTC, step, writeSources } from './ledger.mjs';
import { bar, barEnd, log } from './log.mjs';
import { MARKETS, marketFile } from './markets.mjs';
import { metaCharting, metaCompanies } from './registry.mjs';
import { writeRoster } from './roster.mjs';
import { TICKERS } from './tickers.mjs';
import { openDashboardAction } from './menu-actions.mjs';
import { fetchCharting } from '../steps/charting.mjs';
import { fetchTicker } from '../steps/ticker.mjs';

export let appOpened = false;
export async function runRound() {
  /* 菜单允许在进程启动后增删 ticker / market。启动时写过的 roster 此时已经过期，
   * 必须在每轮真正拉取前用当前活绑定重写；否则新数据会下载成功，却被仪表盘当作清单外数据隐藏。 */
  if (!writeRoster(TICKERS, MARKETS)) log('  ⚠ roster.csv 刷新失败；仪表盘可能暂时隐藏新加入的标的。');
  await ensureBrowser();
  const results = {}, mktResults = {};
  const STEPS = 8;   /* 每家 8 步:两财年 / 价格 / 目标价 / 空头 / 新闻 / 期权链 / 日线;市场序列各 1 步 */
  const TOTAL = TICKERS.length * STEPS + MARKETS.length;
  log(`⏳ 开始拉取 ${TICKERS.length} 家公司(每家最多 ${STEPS} 项)` + (MARKETS.length ? ` + ${MARKETS.length} 个市场序列` : '') + `,请稍等……各类数据会按自己的新鲜周期自动跳过。`);
  let done = 0;
  const adv = (n, label) => { done = Math.min(done + n, TOTAL); bar(done, TOTAL, label); };
  for (const ticker of TICKERS) {
    const R = results[ticker] = { FY1: false, FY2: false, 价格: false, 目标价: false, 空头: false, 新闻: false, 期权: false, 日线: false };
    const base = done;
    try { await fetchTicker(ticker, R, adv); }
    catch (e) { log(`  ✖ ${ticker} 失败:`, e.message.split('\n')[0]); }
    if (done < base + STEPS) adv(base + STEPS - done, `${ticker} · 完成`);
  }
  /* 市场级序列:只拉日线(走向概率的宏观/行业/流动性自动信号) */
  for (const [sym, role] of MARKETS) {
    const fn = marketFile(sym, role);
    const mm = { ...metaCharting(sym, fn, 'market'), step: `${sym} · 市场日线(${role})` };
    noteArtifact(mm);
    if (isFresh(mm)) { mktResults[sym] = { ok: true, fresh: true, role }; adv(1, `${sym} · 已最新`); continue; }
    adv(0, `${sym} · 市场序列(${role})…`);
    mktResults[sym] = { ok: await step(mm, () => fetchCharting(sym, fn)), role };
    adv(1, `${sym} · 完成`);
  }
  barEnd();
  const cm = metaCompanies();
  noteArtifact(cm);
  const cRec = ledger.get(cm.file);
  try {
    fs.writeFileSync(COMPANIES_CSV, CSV_HEADER + '\n' + [...priceMap.values()].join('\n') + '\n');
    log(`✔ companies.csv 已更新(${priceMap.size} 家)`);
    cRec.status = priceMap.size ? 'OK' : 'FAIL';
    if (priceMap.size) { cRec.okAt = stampUTC(); cRec.failPhase = '-'; cRec.desc = `各公司现价汇总,当前 ${priceMap.size} 家`; }
    else { cRec.failAt = stampUTC(); cRec.failPhase = '解析行 :: 没有任何公司抓到价格'; }
  } catch (e) {
    cRec.status = 'FAIL'; cRec.failAt = stampUTC(); cRec.failPhase = '写文件 :: ' + e.message.slice(0, 60);
    log('  ✖ companies.csv 写入失败:', e.message);
  }
  writeSources();
  log(`✔ 源出台账已更新: ${SOURCES_FILE}`);
  const broken = [...ledger.values()].filter(r => r.status === 'FAIL');
  if (broken.length) {
    console.log(`\n⚠ 有 ${broken.length} 项失败,断点如下(菜单输 chk 看完整体检):`);
    for (const r of broken) console.log(`   ${r.step} → 断在【${r.failPhase}】`);
  }
  console.log('\n================ 拉取结果 ================');
  for (const [tk, R] of Object.entries(results)) {
    console.log('  ' + tk.padEnd(10)
      + Object.entries(R).filter(([k]) => k !== 'fresh').map(([k, v]) => (v ? ' ✔' : ' ✖') + k).join('  ')
      + (R.fresh ? '  (本地最新,未重拉)' : ''));
  }
  for (const [sym, m] of Object.entries(mktResults)) {
    console.log('  ' + sym.padEnd(10) + (m.ok ? ' ✔' : ' ✖') + '日线(' + m.role + ')' + (m.fresh ? '  (本地最新,未重拉)' : ''));
  }
  const misses = Object.values(results).reduce((a, R) => a + ['FY1', 'FY2', '价格', '目标价', '空头', '新闻', '日线'].filter(k => !R[k]).length, 0)
    + Object.values(mktResults).filter(m => !m.ok).length;
  console.log(misses === 0 ? '全部完成 ✔' : `有 ${misses} 项未完成(✖),可重跑或按提示手动补。`);
  console.log('==========================================');
  if (OPEN_DASHBOARD && !appOpened && fs.existsSync(APP_HTML)) {
    appOpened = true;
    log('正在打开 Price Range Dashboard……点「重连上次文件夹」→「允许」载入数据(之后再拉取只需在页面里点「重新扫描」)。');
    openDashboardAction({ platform: process.platform, appHtml: APP_HTML, exists: fs.existsSync,
      launch: spec => spec.file ? execFile(spec.file, spec.args || []) : exec(spec.command) });
  }
}
