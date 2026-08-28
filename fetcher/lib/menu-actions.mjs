export function menuCommand(raw, eof = false) {
  if (eof) return 'exit';
  const s = String(raw || '').trim();
  if (!s) return 'empty';
  if (/^(1|run|fetch|go|start|开始|拉取)$/i.test(s)) return 'run';
  if (/^(0|exit|quit|q|退出)$/i.test(s)) return 'exit';
  if (/^(2|open|dashboard|dash|仪表盘|打开仪表盘)$/i.test(s)) return 'dashboard';
  if (/^(3|chk|check|health|体检)$/i.test(s)) return 'health';
  if (/^(4|edit)$/i.test(s)) return 'edit';
  if (/^(5|mkt|markets?)$/i.test(s)) return 'markets';
  if (/^(6|sync|align|对齐)$/i.test(s)) return 'sync';
  if (/^(7|sources|src)$/i.test(s)) return 'sources';
  if (/^(8|bt|backtest|回测)$/i.test(s)) return 'backtest';
  return 'other';
}

export function menuScreen(tickers = [], markets = []) {
  const companies = tickers.length ? tickers.join('  ') : '(清单为空)';
  const marketText = markets.length
    ? markets.map(([s, r]) => `${s}(${r})`).join('  ')
    : '(未配置)';
  return [
    '',
    '┌─ FactSet 数据控制台 ─────────────────────────────────────',
    `│ 公司 ${String(tickers.length).padStart(2)} 家  ${companies}`,
    `│ 市场 ${String(markets.length).padStart(2)} 个  ${marketText}`,
    '├─ 常用 ───────────────────────────────────────────────────',
    '│ [1] 开始拉取      [2] 打开仪表盘      [3] 数据体检',
    '├─ 清单与工具 ─────────────────────────────────────────────',
    '│ 输入 META-US 添加；输入 -META-US 删除',
    '│ [4] 编辑公司清单  [5] 编辑市场清单    [6] 数据对齐',
    '│ [7] 来源台账      [8] 回测            [0] 退出',
    '└───────────────────────────────────────────────────────────',
  ].join('\n');
}

export function openPathSpec(platform, target, editor = false) {
  if (platform === 'darwin') return { file: 'open', args: editor ? ['-e', target] : [target] };
  if (platform === 'linux') return { file: 'xdg-open', args: [target] };
  if (platform === 'win32') {
    const safe = String(target).replaceAll('"', '""');
    return { command: editor ? `start "" notepad "${safe}"` : `start "" "${safe}"` };
  }
  return null;
}

/* launch 可注入：自检只记录命令，不真的打开窗口。 */
export function openDashboardAction({ platform, appHtml, exists, launch }) {
  if (!exists(appHtml)) return { ok: false, why: `找不到仪表盘: ${appHtml}` };
  const spec = openPathSpec(platform, appHtml);
  if (!spec) return { ok: false, why: `当前系统请手动打开: ${appHtml}` };
  launch(spec);
  return { ok: true, why: `已打开 Price Range Dashboard: ${appHtml}` };
}

export async function runFetcherLoop({ interactive, menu, runRound, afterRound, pauseInput = () => {}, resumeInput = () => {} }) {
  if (!interactive) { await runRound(); await afterRound(); return; }
  while (true) {
    resumeInput();
    if (await menu() === 'exit') return;
    pauseInput();
    try {
      await runRound();
      await afterRound();
    } finally {
      resumeInput();
    }
  }
}
