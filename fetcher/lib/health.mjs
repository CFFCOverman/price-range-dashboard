/* lib/health.mjs — chk 数据体检:台账 × 文件真实时间交叉核对
 * 由 factset-fetch.mjs 单文件版按功能拆出;改一个抓取步骤只需要动 steps/ 下对应的一个文件。
 */

import fs from 'node:fs';
import { assetPath } from './config.mjs';
import { ledger } from './ledger.mjs';
import { expectedArtifacts } from './registry.mjs';
import { spanNote, spanOK, xlsxDateSpan, xlsxHasOHLC, xlsxHasVolume } from '../steps/charting.mjs';

export const STALE_HOURS = 96;
export function healthReport() {
  const fail = [], stale = [], never = [], ok = [];
  for (const m of expectedArtifacts()) {
    const r = ledger.get(m.file);
    const p = assetPath(m.file);
    let ageH = Infinity;
    try { ageH = (Date.now() - fs.statSync(p).mtimeMs) / 3600e3; } catch {}
    if (r && r.status === 'FAIL') fail.push([m, r, ageH]);
    else if (!isFinite(ageH)) never.push([m, r, ageH]);
    else if (ageH > STALE_HOURS) stale.push([m, r, ageH]);
    else ok.push([m, r, ageH]);
  }
  const age = h => isFinite(h) ? (h < 48 ? Math.round(h) + ' 小时前' : Math.round(h / 24) + ' 天前') : '文件不存在';
  console.log('\n========== 数据体检(sources.txt 台账 + 本地文件时间)==========');
  console.log(`  正常 ${ok.length} · 失败 ${fail.length} · 陈旧 ${stale.length} · 从未拉取 ${never.length}   (陈旧阈值 ${STALE_HOURS}h)`);
  if (fail.length) {
    console.log('\n  ✖ 最近一次拉取失败 —— 括号内就是断掉的环节:');
    for (const [m, r, h] of fail) {
      console.log(`     ${m.step}`);
      console.log(`        断在: 【${r.failPhase}】  失败于 ${r.failAt}  上次成功 ${r.okAt}`);
      console.log(`        去查: ${m.tab}`);
      console.log(`              ${m.url}`);
      console.log(`        本地文件: ${m.file}(${age(h)})`);
    }
    console.log('\n  判读:断在「导航/等待页面」= FactSet 换了 URL 或没登录;断在「切换 Report Type」= 下拉菜单文案变了;');
    console.log('        断在「定位表格」= 表格容器/类名改版(需改 scrape 函数);断在「解析行」= 列顺序或日期格式变了。');
  }
  if (never.length) {
    console.log('\n  ○ 从未成功产出(可能是新加入清单,或从第一次就失效):');
    for (const [m] of never) console.log(`     ${m.step}  →  ${m.file}`);
  }
  if (stale.length) {
    console.log('\n  ⚠ 台账没报错,但文件已陈旧(说明那一步"静默地"没更新——最值得警惕):');
    for (const [m, r, h] of stale) console.log(`     ${m.step}  文件 ${age(h)}  台账最近成功 ${r ? r.okAt : '-'}`);
  }
  if (!fail.length && !stale.length && !never.length) console.log('\n  全部正常 ✔');
  /* 成交量 / 跨度 / OHLC:直接读磁盘上的 Charting 文件,不依赖本轮是否跑过。
   * 三件事都是"账号里那张保存好的图表布局"的属性,不是脚本能一次点定的,所以体检要一直盯着。 */
  const chart = expectedArtifacts().filter(m => /Daily Charting\.xlsx$/i.test(m.file));
  const withVol = [], noVol = [], shortSpan = [], noSpan = [], noOhlc = [];
  for (const m of chart) {
    const p = assetPath(m.file);
    if (!fs.existsSync(p)) continue;
    (xlsxHasVolume(p) ? withVol : noVol).push(m.file);
    const sp = xlsxDateSpan(p);
    if (!sp) noSpan.push(m.file);                       // 读不出 ≠ 跨度不够,单独一栏
    else if (!spanOK(sp)) shortSpan.push(`${m.file}(${spanNote(sp)})`);
    if (!xlsxHasOHLC(p)) noOhlc.push(m.file);
  }
  const few = (list, head) => {
    for (const f of list.slice(0, 6)) console.log(`     ${head}${f}`);
    if (list.length > 6) console.log(`     …… 另有 ${list.length - 6} 个`);
  };
  if (chart.length) {
    console.log(`\n  成交量列(决定压力位用真实筹码分布还是停留时间):含量 ${withVol.length} · 无量 ${noVol.length}`);
    if (noVol.length) {
      few(noVol, '无量: ');
      console.log('     → 在 FactSet Charting 里给图表加一条 Volume 序列并保存布局,下轮导出就会带上;');
      console.log('       没有量不影响其它功能,压力位会自动退回"停留时间"口径。');
    }
    console.log(`  时间跨度(决定回测 h=63 有几个独立样本):跨度不足 ${shortSpan.length} · 读不出 ${noSpan.length}`);
    if (shortSpan.length) {
      few(shortSpan, '');
      console.log('     → 在 FactSet Charting 里把时间跨度改成 5Y 并保存布局(Layout → Save),下轮导出就会带上。');
    }
    if (noSpan.length) {
      few(noSpan, '读不出日期列: ');
      console.log('     → 这几份**没有被验证过**跨度,不是跨度不够。多半是导出格式变了,打开看一眼第一列。');
    }
    console.log(`  OHLC 三列(决定能不能画 K 线、能不能算真实波幅):仅收盘价 ${noOhlc.length} / 共 ${chart.length}`);
    if (noOhlc.length) {
      few(noOhlc, '仅收盘价: ');
      console.log('     → 在 FactSet Charting 里把图表类型改成 Candlestick / OHLC 并保存布局,下轮导出就会带上。');
    }
  }
  console.log('==============================================================\n');
}
