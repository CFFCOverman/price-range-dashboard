export function menuCommand(raw, eof = false) {
  if (eof) return 'exit';
  const s = String(raw || '').trim();
  if (!s) return 'empty';
  if (/^(run|fetch|go|start|开始|拉取)$/i.test(s)) return 'run';
  if (/^(exit|quit|q|退出)$/i.test(s)) return 'exit';
  if (/^(open|dashboard|dash|仪表盘|打开仪表盘)$/i.test(s)) return 'dashboard';
  return 'other';
}

/* launch 可注入：自检只记录命令，不真的打开窗口。 */
export function openDashboardAction({ platform, appHtml, exists, launch }) {
  if (platform !== 'win32') return { ok: false, why: `当前系统请手动打开: ${appHtml}` };
  if (!exists(appHtml)) return { ok: false, why: `找不到仪表盘: ${appHtml}` };
  launch(`start "" "${appHtml}"`);
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
