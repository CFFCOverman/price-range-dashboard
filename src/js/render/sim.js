/* ================= 买入逻辑模拟面板(渲染) =================
 * 只渲染,不绑事件(事件在 app/events.js,SPEC 3.5 第 4 条)。这一层要守住三件事:
 *
 *   ① **随机对照与胜率并排。** 对照的胜率和 z 就写在胜率那一格里,同一个视野、同一眼。
 *      这是整块面板存在的前提:这份数据是一年 × 十只票 × 单边上行行情,任何规则的胜率
 *      都会好看。把对照折进 tooltip,等于把"这可能只是行情"折进 tooltip。
 *   ② **触发时点表不分页、不折叠、不截断。** 用户原话要的就是「每一次触发的时间点」。
 *      滚不滚是 CSS 的事(sim.css 给了 max-height),行数一条不许减。
 *   ③ **触发次数 < SIM_MIN_TRIG 时不显示胜率。** 不是显示成灰色,是那一格根本不渲染:
 *      灰色的数字照样会被抄进结论里。
 *
 * 输入不自动开跑:一次回放 ≈ 250 根 × 每根一次 pressureLevels,同步几百毫秒。
 * 所以 simGo() 是唯一的计算入口,别处一律只读 simLast。 */

/** 上一次跑出来的结果。**不进 state** —— 它是纯派生物,重算比缓存一致性便宜,
 *  而且一旦进了 state,"切公司要不要清"这个问题就得回答,答错就是把 A 的回测当成 B 的。
 *  模块级 let 的作用域就是整份产物(build 把所有文件拼成一个脚本块),够用。 */
let simLast = null;

/** 当前持有期 key,非法值落回 'mid'(与 engine 同一套兜底,先兜一次好让下拉与结果一致)。 */
function simHoldNow() {
  const v = state.simPref && state.simPref.hold;
  return (v === 'short' || v === 'mid' || v === 'long') ? v : 'mid';
}
function simPresetNow() {
  const id = state.simPref && state.simPref.presetId;
  if (id === 'custom') return 'custom';
  return SIM_PRESETS.some(p => p.id === id) ? id : SIM_PRESETS[0].id;
}

/** 当前选择 → {rule, text, err}。自定义走 parseRule(永不抛),预设直接取 all。 */
function simRuleNow() {
  const id = simPresetNow();
  if (id !== 'custom') {
    const p = SIM_PRESETS.find(x => x.id === id) || SIM_PRESETS[0];
    const rule = { all: p.all };
    return { rule, text: ruleToText(rule), err: null, presetId: p.id };
  }
  const res = parseRule((state.simPref && state.simPref.custom) || '');
  if (!res.ok) return { rule: null, text: '', err: res, presetId: 'custom' };
  return { rule: res.rule, text: ruleToText(res.rule), err: null, presetId: 'custom' };
}

/** 把词条里的反引号片段渲染成 <code>。词条要与 SPEC 3.5 的表格逐字一致,
 *  所以格式化只能发生在这里,不能回头去改词条。 */
function simCodeText(node, s) {
  const parts = String(s == null ? '' : s).split('`');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    node.appendChild(i % 2 ? el('code', '', parts[i]) : document.createTextNode(parts[i]));
  }
  return node;
}

/** 下拉/输入框的文案与状态同步 + 即时语法校验。
 *  events.js 的三个 change/input 处理器都只调它,**不跑回放**。 */
function simSyncUI() {
  const selH = $('simHold'), selP = $('simPreset'), inp = $('simRule'), hint = $('simHint');
  if (!selH || !selP || !inp || !hint) return;
  const hold = simHoldNow();
  const pid = simPresetNow();
  if (state.simPref) { state.simPref.hold = hold; state.simPref.presetId = pid; }

  /* option 的文案每次重填:切语种时这一批文字没有别的出口(option 里塞不下 .lz/.le 成对 span)。 */
  const ho = t('simHoldOpt');
  for (const o of selH.options) o.textContent = ho[o.value] || o.value;
  const pn = t('simPresetName');
  for (const o of selP.options) o.textContent = o.value === 'custom' ? t('simCustom') : (pn[o.value] || o.value);
  selH.value = hold;
  selP.value = pid;

  inp.disabled = pid !== 'custom';
  if (inp.value !== ((state.simPref && state.simPref.custom) || '')) inp.value = (state.simPref && state.simPref.custom) || '';

  /* 提示行:恒定给出文法示例;自定义模式下再追加一行「读懂了 / 看不懂」。 */
  hint.replaceChildren();
  simCodeText(hint, t('simRuleHint'));
  if (pid === 'custom') {
    const raw = (state.simPref && state.simPref.custom) || '';
    const res = parseRule(raw);
    const line = el('span', 'simnl');
    line.style.display = 'block';
    if (res.ok) {
      /* 读懂了就把**规范化后的**规则回显出来:用户写 `nearSupport( .5 )`,实际跑的是
       * `nearSupport(0.5)`,回显让这件事看得见(种子也是按这串文本算的)。 */
      line.appendChild(el('span', 'simok', '✓ ' + ruleToText(res.rule)));
    } else {
      /* **一行红字,不是 alert、不是抛异常。** 这个处理器挂在 input 上,抛出去的错会连带
       * 打断后面所有绑定;而 alert 会在每一次按键上弹一次。 */
      line.appendChild(el('span', 'simerr', t('simRuleErr')(res.at === '' ? '∅' : res.at)));
    }
    hint.appendChild(line);
  }
  /* 选项改过而结果还是旧的 —— 这一句必须出现在结果区,否则用户会把旧数当成新规则的结果。 */
  simPaint(state.companies.get(state.selected) || null);
}

/** 唯一的计算入口。按钮点一次跑一次。 */
function simGo() {
  const co = state.companies.get(state.selected);
  if (!co) return;
  const r = simRuleNow();
  if (!r.rule) { simSyncUI(); return; }          /* 自定义没写对:红字已经在 hint 里,不跑 */
  const hold = simHoldNow();
  const h = PX_HORIZONS[hold];
  const btn = $('simRun');
  if (btn) btn.disabled = true;
  try {
    const result = simRun(co.ticker, r.rule, h, {});
    simLast = { ticker: co.ticker, ruleText: r.text, rule: r.rule, presetId: r.presetId, hold, result, at: Date.now() };
  } catch (e) {
    /* 回放本身不该抛(engine 内部每根都 try 过),但真抛了也只能是一行提示:
     * 这个 handler 抛出去等于整块面板从此不响应。 */
    simLast = { ticker: co.ticker, ruleText: r.text, rule: r.rule, presetId: r.presetId, hold, result: null,
      at: Date.now(), fail: String((e && e.message) || e) };
  } finally {
    if (btn) btn.disabled = false;
  }
  simPaint(co);
}

/** 结果区。不计算,只画 simLast。 */
function simPaint(co) {
  const out = $('simOut'), trg = $('simTrig'), note = $('simNote');
  if (!out || !trg || !note) return;
  out.replaceChildren(); trg.replaceChildren(); note.replaceChildren();

  /* ---- 常驻三句话(SPEC 3.5 第 7 条):成本口径 / maxDD 定义 / <8 次不显示胜率 ----
   * 三句都是正文,一句都不许降级成 tooltip;有没有结果都在。 */
  const nl = s => note.appendChild(el('span', 'simnl', s));
  nl(t('simCost')(SIM_COST_BPS));
  nl(t('simMaxDDTip'));
  nl(t('simMinTrigNote'));
  nl(t('simDisclaim'));

  const cur = simLast && co && simLast.ticker === co.ticker ? simLast : null;
  if (!cur) { out.appendChild(el('p', 'hint', t('simIdle'))); return; }
  if (cur.fail) { out.appendChild(el('p', 'hint simerr', cur.fail)); return; }
  const R = cur.result;

  /* 「屏幕上这组数到底是按什么跑出来的」—— 下拉可以在按按钮之后被改动,
   * 不写这一行,面板就会用旧结果回答新问题。 */
  const head = el('p', 'simcount');
  head.appendChild(document.createTextNode(
    t('simHoldOpt')[cur.hold] + ' · ' + (cur.presetId === 'custom' ? t('simCustom') : t('simPresetName')[cur.presetId])
    + ' · ' + cur.ruleText + ' · ' + t('simExit').hold
    + (R.from && R.to ? ' · ' + R.from + ' ~ ' + R.to : '')));
  trg.appendChild(head);
  const live = simRuleNow();
  if (cur.hold !== simHoldNow() || cur.presetId !== simPresetNow() || (live.rule && live.text !== cur.ruleText)) {
    out.appendChild(el('p', 'hint simthin', t('simStale')));
  }

  const tile = (lb, vl, dt, cls, extra) => {
    const d = el('div', 'tile');
    d.appendChild(el('div', 'lb', lb));
    d.appendChild(el('div', 'vl', vl));
    if (dt) d.appendChild(el('div', 'dt ' + (cls || ''), dt));
    if (extra) d.appendChild(extra);
    out.appendChild(d);
    return d;
  };
  const sgn = v => (isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '—');

  /* 触发次数这一格永远在:它是"没触发"和"没跑"这两种情况唯一的区分。
   * 副标题给扫过的根数 —— 没有它,"12 次"读不出是十二分之几百还是十二分之十五。
   * 写成 "n / scanned" 而不是 "n bars":这一格里不该有任何一种语言的单词,
   * 否则中文界面上会冒出一个英文词,而为它单开一条词条又不值当。 */
  tile(t('simTrig'), fmtInt(R.n), fmtInt(R.n) + ' / ' + fmtInt(R.scanned), '');

  if (!R.n) {
    trg.appendChild(el('p', 'simthin', t('simNoTrig')));
    return;
  }

  /* ---- 胜率 + 并排的随机对照。样本 < 8 时整格不渲染 ---- */
  if (R.n >= SIM_MIN_TRIG) {
    const nEff = Math.min(R.n, R.effN);
    const ci = wilson(Math.round(R.winPct / 100 * nEff), nEff, 1.96);
    const box = el('div', '');
    box.appendChild(el('span', 'simctrl', t('simCtrl')(
      isFinite(R.ctrl.winPct) ? R.ctrl.winPct.toFixed(0) : '—',
      isFinite(R.z) ? R.z.toFixed(2) : '—')));
    if (isFinite(ci.lo)) box.appendChild(el('span', 'simci',
      '95% CI ' + (ci.lo * 100).toFixed(0) + '–' + (ci.hi * 100).toFixed(0) + '%'));
    /* .simwin 只有一个用途:让样式表能把**这一格**的三个数(处理组 / 对照 / 区间)
     * 钉成同一个字号字重。不加类就只能靠 :has(.simctrl) 之类的隐式选择器去认它,
     * 那种选择器一旦哪天对照挪了位置就会静默失效,而失效的表现正好是排版重新
     * 把胜率捧成标题 —— 也就是这次要修的那个缺陷本身。理由见 sim.css。 */
    tile(t('simWin'), R.winPct.toFixed(0) + '%', '', '', box).classList.add('simwin');
    tile(t('simAvgRet'), sgn(R.avgRet), '', R.avgRet >= 0 ? 'pos' : 'neg');
    tile(t('simMedRet'), sgn(R.medRet), '', R.medRet >= 0 ? 'pos' : 'neg');
    /* maxDD 同样恒 ≤ 0,理由同 MAE 那一列 */
    const dd = tile(t('simMaxDD'), isFinite(R.maxDD) ? R.maxDD.toFixed(2) + '%' : '—', '', 'neg');
    dd.title = t('simMaxDDTip');
    tile(t('simMAE'), isFinite(R.avgMAE) ? R.avgMAE.toFixed(2) + '%' : '—', '', 'neg');
  } else {
    /* 只触发了 n 次:一句红字 + 下面完整的触发时点表。五个统计格一个都不出。 */
    trg.appendChild(el('p', 'simthin', t('simThin')(R.n)));
  }

  /* ---- 触发时点表:全部行,不分页不截断 ---- */
  const wrap = el('div', 'simtwrap');
  const tb = el('table', 'mx sim');
  const hr = el('tr');
  for (const h of t('simHead')) hr.appendChild(el('th', '', h));
  tb.appendChild(hr);
  for (const tr of R.trades) {
    const row = el('tr');
    row.appendChild(el('td', '', tr.entryDate));
    row.appendChild(el('td', '', fmtN(tr.entryPx)));
    row.appendChild(el('td', '', tr.exitDate));
    row.appendChild(el('td', '', fmtN(tr.exitPx)));
    row.appendChild(el('td', tr.retPct >= 0 ? 'pos' : 'neg', sgn(tr.retPct)));
    /* MAE 恒 ≤ 0(simTrade 把入场根算进去了),所以这一列不带 "+";
     * 一个写着 "+0.00%" 的「期间最不利」会被读成"这段时间最差也赚了 0"。 */
    row.appendChild(el('td', tr.maePct < 0 ? 'neg' : '', isFinite(tr.maePct) ? tr.maePct.toFixed(2) + '%' : '—'));
    tb.appendChild(row);
  }
  wrap.appendChild(tb);
  trg.appendChild(wrap);
}

/** detail.js 的 renderDetail() 与 partialRefresh() 各追加一行调用(SPEC 3.2)。 */
function renderSim(co) {
  const sec = $('simSec');
  if (!sec) return;
  /* 没有现价 = 详情页本身就在提示缺价,这块整个收起(与 renderPressure 同一条判据)。 */
  if (!co || !isFinite(co.price) || co.price <= 0) { sec.hidden = true; return; }
  const px = state.priceHist.get(co.ticker) || [];
  /* 没有日线序列就没有可回放的东西。收起而不是留一块空面板:空面板读起来像坏了。 */
  if (px.length < 2) { sec.hidden = true; return; }
  sec.hidden = false;
  /* 换了公司就把上一只票的结果扔掉 —— 屏幕上留着 AAPL 的回测配 MSFT 的标题是最坏的一种错。 */
  if (simLast && simLast.ticker !== co.ticker) simLast = null;
  simSyncUI();
}
