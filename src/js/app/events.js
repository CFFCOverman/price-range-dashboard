/* ================= events ================= */
const drop = $('drop');
['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', ev => handleFiles([...ev.dataTransfer.files]));
$('fileInput').addEventListener('change', ev => { handleFiles([...ev.target.files]); ev.target.value = ''; });
$('demoBtn').addEventListener('click', loadDemo);
$('coSel').addEventListener('change', ev => { state.selected = ev.target.value; renderAll(); });
$('hzTabs').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  state.horizon = b.dataset.h; renderAll();
});
function bindEps(id, key) {
  $(id).addEventListener('input', ev => {
    const t = state.selected; if (!t) return;
    const k = t + '|' + state.horizon;
    const cur = state.overrides.get(k) || { ...epsFor(t, state.horizon) };
    cur[key] = parseFloat(ev.target.value);
    state.overrides.set(k, cur);
    partialRefresh();   /* 不重建输入框,避免打断输入 */
  });
}
bindEps('epsLow', 'low'); bindEps('epsMean', 'mean'); bindEps('epsHigh', 'high');
$('epsReset').addEventListener('click', () => {
  if (state.selected) { state.overrides.delete(state.selected + '|' + state.horizon); renderAll(); }
});
function bindPe(id, key) {
  $(id).addEventListener('input', ev => {
    const t = state.selected; if (!t) return;
    const m = state.peManual.get(t) || {};
    m[key] = parseFloat(ev.target.value);
    state.peManual.set(t, m);
    partialRefresh();
  });
}
bindPe('peP25', 'p25'); bindPe('peP50', 'p50'); bindPe('peP75', 'p75');
for (const [id, key] of [['dirSent', 's'], ['dirMacro', 'm'], ['dirInd', 'i'], ['dirLiq', 'l']]) {
  $(id).addEventListener('change', ev => {
    const tk = state.selected; if (!tk) return;
    const man = state.dirManual.get(tk) || { s: 'a', m: 'a', i: 'a', l: 'a' };
    man[key] = ev.target.value === 'a' ? 'a' : (parseFloat(ev.target.value) || 0);
    state.dirManual.set(tk, man);
    const co = state.companies.get(tk);
    renderDirection(co, calcRange(co, state.horizon));
  });
}
$('dirPeers').addEventListener('change', ev => {
  const tk = state.selected; if (!tk) return;
  state.peerSel.set(tk, ev.target.value);
  const co = state.companies.get(tk);
  renderDirection(co, calcRange(co, state.horizon));
});
$('pxInput').addEventListener('input', ev => {
  const co = state.companies.get(state.selected); if (!co) return;
  co.price = parseFloat(ev.target.value);
  co.priceSrc = 'user'; co.priceDate = '@manual';
  partialRefresh();
});

/* ---- 买入模拟面板(SPEC 3.5)----
 * 四个绑定,只有最后一个会真的跑回放。前三个都只改 state.simPref / 做即时校验:
 * 一次 simRun 是 ~250 根 × 每根一次 pressureLevels,同步阻塞几百毫秒,
 * 挂在 change/input 上会把整个面板变成"打一个字卡一下"。 */
$('simHold').addEventListener('change', ev => {
  state.simPref.hold = ev.target.value;
  simSyncUI();                     /* 只重画输入区的状态,不跑回放 */
});
$('simPreset').addEventListener('change', ev => {
  state.simPref.presetId = ev.target.value;
  simSyncUI();                     /* 里面切 #simRule 的 disabled */
});
$('simRule').addEventListener('input', ev => {
  state.simPref.custom = ev.target.value;
  /* 只做 parseRule 的即时校验。parseRule 约定**不抛异常**(失败返回 {ok:false}),
   * 因为在 input 处理器里抛错会连带打断后面所有绑定 —— 主题、语言按钮会一起哑掉。 */
  simSyncUI();
});
$('simRun').addEventListener('click', () => simGo());

/* theme toggle */
const THEME_KEYS = ['auto', 'light', 'dark'];
let themeIdx = 0;
function applyThemeBtn() { $('themeBtn').textContent = t('themeNames')[THEME_KEYS[themeIdx]]; }
$('themeBtn').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % 3;
  const k = THEME_KEYS[themeIdx];
  if (k === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = k;
  applyThemeBtn();
});
applyThemeBtn();

/* language toggle */
$('langBtn').addEventListener('click', () => {
  LANG = LANG === 'zh' ? 'en' : 'zh';
  const app = $('app');
  if (LANG === 'en') app.dataset.lang = 'en'; else delete app.dataset.lang;
  $('langBtn').textContent = LANG === 'zh' ? 'EN' : '中文';
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  applyThemeBtn();
  renderAll();   /* 重绘所有动态文本与图表标签 */
});

/* template downloads */
const T_CO = 'ticker,name,currency,price,price_date,eps_fy1_low,eps_fy1_mean,eps_fy1_high,eps_fy2_low,eps_fy2_mean,eps_fy2_high\nAAPL-US,Apple Inc.,USD,231.50,2026-07-23,7.10,7.45,7.80,7.60,8.15,8.70\n';
const T_HI = 'ticker,date,pe_ntm\nAAPL-US,2021-01-31,33.2\nAAPL-US,2021-02-28,31.8\n';
$('dlCompanies').href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(T_CO);
$('dlHistory').href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(T_HI);

