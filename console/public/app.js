const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const api = async (p, opt = {}) => { const r = await fetch(p, { headers: { 'Content-Type': 'application/json' }, ...opt }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error || (j.errors || []).join('\n')), { body: j }); return j; };
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
const pct = v => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 1)}%`);
let overview, universe = [];

/* ---------- 标签页 ---------- */
$$('#tabs button').forEach(b => b.onclick = () => { $$('#tabs button').forEach(x => x.classList.toggle('on', x === b)); $$('.tab').forEach(t => t.classList.toggle('on', t.id === b.dataset.tab)); load(b.dataset.tab); });
const load = t => ({ levels: loadLevels, universe: loadUniverse, status: loadStatus, handoff: loadHandoff })[t]?.();

/* ---------- 价位与估值 ---------- */
async function loadLevels() {
  const sel = $('#symSel'), want = universe.filter(u => ['company', 'etf'].includes(u.kind));
  if (sel.options.length !== want.length) {   // 清单改过就重建下拉框
    const keep = sel.value; sel.innerHTML = '';
    for (const u of want) sel.add(new Option(`${u.symbol} ${u.name || ''}`, u.symbol));
    if (keep && want.some(u => u.symbol === keep)) sel.value = keep;
  }
  sel.onchange = showSymbol;
  showSymbol();
}
let symSeq = 0;   // 只渲染最后一次点击的结果(快速切换时旧请求后到,不能覆盖新的)
async function showSymbol() {
  const s = $('#symSel').value; if (!s) return;
  const my = ++symSeq;
  $('#symMeta').textContent = `${s} 读取中…`;
  try {
    const { levels: L, valuation: V } = await api(`/api/symbol?s=${encodeURIComponent(s)}&t=${Date.now()}`);
    if (my !== symSeq) return;
    renderSymbol(s, L, V);
  } catch (e) {
    if (my !== symSeq) return;
    $('#symMeta').innerHTML = `<span class="warn">${s} 显示失败:${e.message}(数据可能正在写入或 G 盘正在同步,稍后再点一次)</span>`;
    console.error(e);
  }
}
function renderSymbol(s, L, V) {
  $('#ladder').innerHTML = ''; $('#lvTable').innerHTML = ''; $('#valChart').innerHTML = ''; $('#valTable').innerHTML = '';
  if (!L) { $('#symMeta').textContent = ''; $('#ladder').textContent = `${s} 还没有计算结果:去「运行」点「只重算」。`; return; }
  $('#symMeta').textContent = `现价 ${fmt(L.spot)} · 计算于 ${L.asof} · 期权 ${L.options ? `${L.options.asof}(OI:${{ eod: '收盘确认', mixed: '部分收盘', evening: '当晚读数' }[L.options.oi_basis]})` : '无'}`;
  drawLadder(L);
  $('#lvTable').innerHTML = '<tr><th>价位</th><th>距现价</th><th>类型</th><th>来源</th><th>强度</th><th>ΔOI</th></tr>' + L.levels.map(l =>
    `<tr><td class="num">${fmt(l.price)}</td><td class="num">${pct(l.distance_pct)}</td><td class="${l.role === 'resistance' ? 'res' : 'sup'}">${l.role === 'resistance' ? '压力' : '支撑'}</td><td>${l.source}</td><td class="num">${l.strength != null ? fmt(l.strength, 1) + '%' : ''}</td><td class="num">${l.detail?.d_oi != null ? fmt(l.detail.d_oi, 0) : ''}</td></tr>`).join('');
  drawValuation(L, V);
}
function drawLadder(L) {
  const W = 640, H = 460, padL = 60, padR = 260;
  const prices = [L.spot, ...L.levels.map(l => l.price)];
  const lo = Math.min(...prices) * 0.98, hi = Math.max(...prices) * 1.02;
  const y = p => 10 + (hi - p) / (hi - lo) * (H - 20);
  let g = '';
  for (const z of L.zones.filter(z => z.confluence)) g += `<rect x="${padL}" y="${y(z.hi) - 4}" width="${W - padL - padR}" height="${Math.max(8, y(z.lo) - y(z.hi) + 8)}" fill="var(--zone)"><title>共振区 ${fmt(z.lo)}–${fmt(z.hi)}:${z.sources.join('、')}</title></rect>`;
  /* 同一价位的多个来源合成一行标签;标签纵向至少隔 12px,避免重叠 */
  const byPrice = new Map();
  for (const l of L.levels) { const k = l.price.toFixed(2); (byPrice.get(k) || byPrice.set(k, []).get(k)).push(l); }
  let lastY = -99;
  for (const [, ls] of [...byPrice.entries()].sort((a, b) => b[0] - a[0])) {
    const l = ls[0], yy = y(l.price), c = l.role === 'resistance' ? 'var(--res)' : 'var(--sup)';
    const strength = Math.max(...ls.map(x => x.strength || 0));
    const w = strength ? Math.min(1, strength / 15) : 0.35;
    g += `<line x1="${padL}" x2="${padL + (W - padL - padR) * (0.25 + 0.75 * w)}" y1="${yy}" y2="${yy}" stroke="${c}" stroke-width="2"><title>${ls.map(x => x.source).join('、')} ${fmt(l.price)}</title></line>`;
    const ty = yy < lastY + 12 ? lastY + 12 : yy; lastY = ty;
    g += `<text x="${W - padR + 6}" y="${ty + 4}">${fmt(l.price)} ${ls.map(x => x.source).join('、')}</text><text x="${padL - 6}" y="${ty + 4}" text-anchor="end">${pct(l.distance_pct)}</text>`;
  }
  g += `<line x1="${padL}" x2="${W - padR}" y1="${y(L.spot)}" y2="${y(L.spot)}" stroke="var(--fg)" stroke-dasharray="4 3"/><text x="${padL - 6}" y="${y(L.spot) + 4}" text-anchor="end" style="fill:var(--fg)">${fmt(L.spot)}</text>`;
  $('#ladder').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>`;
}
function drawValuation(L, V) {
  if (!V) { $('#valChart').innerHTML = '<p class="muted">ETF 不做估值区间。</p>'; $('#valTable').innerHTML = ''; return; }
  if (!V.applicable) { $('#valChart').innerHTML = `<p class="muted">不适用:${V.reason}</p>`; $('#valTable').innerHTML = ''; return; }
  const rows = [
    ['A 回归 3 年估值', V.range.bear, V.range.base, V.range.bull],
    ['B 估值不变', V.hold_pe?.bear, V.hold_pe?.base, V.hold_pe?.bull],
    ['卖方 12 个月目标价', V.checks.sell_side_12m?.q1, V.checks.sell_side_12m?.median, V.checks.sell_side_12m?.q3],
    ['1 年波动区间【推算】', V.checks.vol_band_1y?.low, L.spot, V.checks.vol_band_1y?.high],
  ].filter(r => r.slice(1).every(v => isFinite(v)));
  const all = rows.flatMap(r => r.slice(1)).concat(L.spot);
  const lo = Math.min(...all) * 0.95, hi = Math.max(...all) * 1.05, W = 560, padL = 140, rowH = 34;
  const x = p => padL + (p - lo) / (hi - lo) * (W - padL - 20);
  let g = rows.map((r, i) => { const yy = 18 + i * rowH; return `<text x="0" y="${yy + 4}">${r[0]}</text><line x1="${x(r[1])}" x2="${x(r[3])}" y1="${yy}" y2="${yy}" stroke="var(--acc)" stroke-width="6" stroke-linecap="round"/><circle cx="${x(r[2])}" cy="${yy}" r="5" fill="var(--fg)"/><text x="${x(r[1])}" y="${yy + 18}" text-anchor="middle">${fmt(r[1], 0)}</text><text x="${x(r[3])}" y="${yy + 18}" text-anchor="middle">${fmt(r[3], 0)}</text>`; }).join('');
  const H = 18 + rows.length * rowH;
  g += `<line x1="${x(L.spot)}" x2="${x(L.spot)}" y1="0" y2="${H}" stroke="var(--fg)" stroke-dasharray="4 3"/><text x="${x(L.spot) + 4}" y="${H}" style="fill:var(--fg)">现价 ${fmt(L.spot)}</text>`;
  $('#valChart').innerHTML = `<svg viewBox="0 0 ${W} ${H + 6}" width="100%">${g}</svg>`;
  const f = V.forward_eps, pe = V.exit_pe_3y;
  $('#valTable').innerHTML = `<table>
    <tr><th></th><th>悲观</th><th>中性</th><th>乐观</th></tr>
    <tr><td>一年后前瞻 EPS</td><td class="num">${fmt(f.low)}</td><td class="num">${fmt(f.mean)}</td><td class="num">${fmt(f.high)}</td></tr>
    <tr><td>退出 P/E(3 年 ${Object.values(V.params.pe_pctiles).join('/')} 分位)</td><td class="num">${fmt(pe.bear, 1)}×</td><td class="num">${fmt(pe.base, 1)}×</td><td class="num">${fmt(pe.bull, 1)}×</td></tr>
    <tr><td>A 回归 / 距现价</td><td class="num">${fmt(V.range.bear, 0)} <span class="muted">${pct(V.upside_pct.bear)}</span></td><td class="num">${fmt(V.range.base, 0)} <span class="muted">${pct(V.upside_pct.base)}</span></td><td class="num">${fmt(V.range.bull, 0)} <span class="muted">${pct(V.upside_pct.bull)}</span></td></tr>
    <tr><td>B 估值不变(${fmt(V.hold_pe?.pe, 1)}×)</td><td class="num">${fmt(V.hold_pe?.bear, 0)}</td><td class="num">${fmt(V.hold_pe?.base, 0)}</td><td class="num">${fmt(V.hold_pe?.bull, 0)}</td></tr>
  </table>
  <p class="note">现价 NTM P/E ${fmt(V.now.pe_ntm, 1)}×,处于自身 3 年 ${fmt(V.now.pe_pctile_3y, 0)} 分位、10 年 ${fmt(V.now.pe_pctile_10y, 0)} 分位。${V.regime_gap ? '<span class="warn">⚠ 估值断层:现价市盈率在 3 年历史极端位置,A(回归)的假设可能不成立,两个锚一起看。</span>' : ''}
  EPS 权重 FY1–FY4 = ${f.fy_weights.join(' / ')}(FY1 ${f.fy1_label})${f.extrapolated_fy4 ? ',FY4 为外推' : ''};档位 ${f.band === 'sd' ? '均值 ∓ 1σ' : '最低/最高'}。</p>`;
}

/* ---------- 标的 ---------- */
async function loadUniverse() { universe = (await api('/api/universe')).rows; renderUniverse(); }
function renderUniverse() {
  const kinds = overview.kinds;
  $('#uTable').innerHTML = '<tr><th></th><th>代码</th><th>类型</th><th>名称</th><th>分组</th><th>换算</th><th>广度组</th><th></th></tr>' + universe.map((u, i) => `<tr>
    <td><input type="checkbox" class="uSel" data-i="${i}"></td>
    <td><input data-i="${i}" data-k="symbol" value="${u.symbol}"></td>
    <td><select data-i="${i}" data-k="kind">${kinds.map(k => `<option ${k === u.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
    <td><input data-i="${i}" data-k="name" value="${u.name || ''}"></td><td><input data-i="${i}" data-k="group" value="${u.group || ''}"></td>
    <td><input data-i="${i}" data-k="scale" value="${u.scale && u.scale !== 1 ? u.scale : ''}" size="4"></td><td><input data-i="${i}" data-k="breadth" value="${u.breadth || ''}" size="5"></td>
    <td><button data-del="${i}">删除</button></td></tr>`).join('');
  $$('#uTable [data-k]').forEach(el => el.onchange = () => { universe[el.dataset.i][el.dataset.k] = el.value; });
  $$('#uTable [data-del]').forEach(b => b.onclick = () => { universe.splice(Number(b.dataset.del), 1); renderUniverse(); });
}
$('#uAdd').onclick = () => { universe.unshift({ symbol: '', kind: 'company', name: '', group: '', scale: '', breadth: '' }); renderUniverse(); };
$('#uSave').onclick = async () => {
  try { const r = await api('/api/universe', { method: 'PUT', body: JSON.stringify({ rows: universe }) }); $('#uMsg').innerHTML = `<span class="ok">已保存 ${r.saved} 行</span>`; await loadUniverse(); $('#symSel').innerHTML = ''; }
  catch (e) { $('#uMsg').innerHTML = `<span class="bad">${e.message.replace(/\n/g, '<br>')}</span>`; }
};

/* ---------- 运行 ---------- */
const selected = () => $$('.uSel:checked').map(c => universe[c.dataset.i]?.symbol).filter(Boolean);
$$('[data-run]').forEach(b => b.onclick = async () => {
  const k = b.dataset.run;
  const body = k === 'force-sel' ? { kind: 'all', force: true, symbols: selected() } : { kind: k };
  if (k === 'force-sel' && !body.symbols.length) { $('#runMsg').textContent = '先在「标的」页勾选要重拉的标的'; return; }
  try { const r = await api('/api/run', { method: 'POST', body: JSON.stringify(body) }); $('#runMsg').textContent = `已启动:${r.cmd}`; pollRun(); }
  catch (e) { $('#runMsg').textContent = e.message; }
});
let poll;
async function pollRun() {
  clearTimeout(poll);
  const j = await api('/api/run');
  $('#runLog').textContent = (j.log || []).join('\n'); $('#runLog').scrollTop = 1e9;
  $$('[data-run]').forEach(b => b.disabled = !!j.running);
  if (j.running) poll = setTimeout(pollRun, 1500); else if (j.id) { $('#runMsg').textContent = `上一个任务结束(${j.finished_at?.slice(11, 19) || ''})`; loadStatus(true); }
}
async function loadStatus(skipPoll) {
  const { state, last_run } = await api('/api/status');
  const ds = overview.datasets.concat(['breadth']).filter((v, i, a) => a.indexOf(v) === i);
  const syms = [...new Set(Object.keys(state).map(k => k.split('|')[1]))].sort();
  const now = Date.now();
  const cell = s => { if (!s) return '<td class="cell muted">·</td>'; const age = (now - Date.parse(s.ok_at || 0)) / 36e5;
    const bad = s.err_at && (!s.ok_at || s.err_at > s.ok_at);
    return `<td class="cell ${bad ? 'bad' : age < 24 ? 'ok' : age < 24 * 8 ? '' : 'warn'}" title="${bad ? s.err : '成功 ' + s.ok_at}">${bad ? '✘' : age < 1 ? '刚刚' : age < 48 ? Math.round(age) + 'h' : Math.round(age / 24) + 'd'}</td>`; };
  $('#stateGrid').innerHTML = `<div style="overflow-x:auto"><table class="state"><tr><th></th>${ds.map(d => `<th title="${overview.cadence[d] || ''}">${d}</th>`).join('')}</tr>` +
    syms.map(s => `<tr><td>${s}</td>${ds.map(d => cell(state[`${d}|${s}`])).join('')}</tr>`).join('') + '</table></div>' +
    (last_run ? `<p class="note">上一轮 ${last_run.started_at?.slice(0, 16).replace('T', ' ')}:成功 ${last_run.ok.length},失败 ${last_run.failed.length}${last_run.failed.length ? '(' + last_run.failed.map(f => f.dataset + ' ' + f.symbol).join('、') + ')' : ''}</p>` : '');
  if (!skipPoll) pollRun();
}

/* ---------- 交接 ---------- */
async function loadHandoff() {
  const h = await api('/api/handoff');
  if (!h) { $('#hId').textContent = '还没有'; loadFeedAndRequests(null); return; }
  $('#hId').textContent = `编号 ${h.id} · ${h.asof} · 生成于 ${h.generated_at?.slice(0, 16).replace('T', ' ')}`;
  $('#hChanges').innerHTML = '<tr><th>标的</th><th>变化</th><th>从</th><th>到</th></tr>' + (h.changes.length ? h.changes.map(c => `<tr><td>${c.symbol}</td><td>${c.what}${c.source ? `(${c.source})` : ''}</td><td class="num">${c.from ?? ''}</td><td class="num">${c.to ?? ''}${c.change_pct != null ? ` <span class="muted">${pct(c.change_pct)}</span>` : ''}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">与上一交易日相比没有变化</td></tr>');
  $('#hTable').innerHTML = '<tr><th>标的</th><th>现价</th><th>最近压力</th><th>最近支撑</th><th>共振区</th><th>A 中性</th><th>B 中性</th><th>卖方中位</th><th>P/E 3 年分位</th></tr>' + Object.entries(h.symbols).map(([s, v]) => {
    const va = v.valuation || {};
    return `<tr><td>${s}</td><td class="num">${fmt(v.spot)}</td><td class="num res">${fmt(v.nearest_resistance?.price)}</td><td class="num sup">${fmt(v.nearest_support?.price)}</td><td class="num">${v.confluence_zones.length}</td>
      <td class="num">${va.range ? fmt(va.range.base, 0) : va.not_applicable ? '<span class="muted" title="' + va.not_applicable + '">不适用</span>' : '—'}</td><td class="num">${fmt(va.hold_pe?.base, 0)}</td><td class="num">${fmt(va.sell_side_median, 0)}</td><td class="num">${va.regime_gap ? '<span class="warn">' + fmt(va.pe_pctile_3y, 0) + ' ⚠</span>' : fmt(va.pe_pctile_3y, 0)}</td></tr>`; }).join('');
  loadFeedAndRequests(h);
}

async function loadFeedAndRequests(h) {
  const F = h?.feeds || {};
  $('#hFeed').innerHTML = '<tr><th>标的</th><th>新闻</th><th>FY1 30 天修订</th><th>目标价 30 天</th><th>券商变动</th><th>空头 % 流通盘</th></tr>' + (Object.keys(F).length ? Object.entries(F).map(([s, f]) =>
    `<tr><td>${s}</td><td class="num" title="${(f.news || []).map(n => n.datetime_et + ' ' + n.headline).join('\n').replace(/"/g, '&quot;')}">${f.news?.length || 0}</td><td class="num">${f.revisions ? pct(f.revisions.eps_fy1_30d_pct) : '—'}</td><td class="num">${f.revisions ? pct(f.revisions.target_30d_pct) : '—'}</td><td class="num">${f.broker_changes?.length ?? '—'}</td><td class="num">${f.short ? fmt(f.short.short_pct_float) : '—'}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">交接包还是旧格式(prd-handoff/1),下次计算后出现</td></tr>');
  $('#hBreadth').textContent = Object.entries(h?.breadth || {}).map(([g, b]) => `修订广度 ${g}(${b.asof},${b.members} 家):NTM 上调 ${b.ntm_up} / 下调 ${b.ntm_down};FY1 上调 ${b.fy1_up} / 下调 ${b.fy1_down}`).join(' · ');
  const r = await api('/api/requests');
  $('#rqMeta').textContent = r ? `${r.file} · ${r.asof || ''}` : '';
  $('#rqTable').innerHTML = '<tr><th>读数</th><th>层</th><th>为什么要</th><th>搜不到次数</th></tr>' + (r?.requests?.length ? r.requests.map(q => `<tr><td>${q.reading}</td><td>${q.layer || ''}</td><td>${q.why || ''}</td><td class="num">${q.misses ?? ''}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">还没有需求单(Research OS 周五晚报写;要不要加进采集由你决定)</td></tr>');
}

/* ---------- 启动 ---------- */
overview = await api('/api/overview');
$('#outdir').textContent = overview.out_dir;
universe = (await api('/api/universe')).rows;
loadLevels();
