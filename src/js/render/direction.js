function renderDirection(co, r) {
  const sec = $('dirSec'), chips = $('dirChips'), out = $('dirOut');
  const ph = state.priceHist.get(co.ticker);
  if (!isFinite(co.price) || !ph || ph.length < 30) { sec.hidden = true; return; }
  sec.hidden = false;
  /* 打分器:有市场数据时默认"自动",可手动覆盖 */
  const auto = marketScores();
  /* 行业面 = 行业ETF相对强弱(价格面)与同行修正动量(盈利面)各占一半 */
  const pr = peerRevs(co);
  const sectorRS = auto.i;   /* 保留纯相对强弱分,芯片单独展示 */
  if (pr) auto.i = sectorRS != null ? clamp1(0.5 * sectorRS + 0.5 * pr.avg) : pr.avg;
  const peersInp = $('dirPeers');
  peersInp.value = state.peerSel.get(co.ticker) || '';
  peersInp.placeholder = t('dirPeersPh');
  /* 情绪面自动信号 */
  const sen = sentScores(co);
  auto.s = sen.s;
  const man = state.dirManual.get(co.ticker) || { s: 'a', m: 'a', i: 'a', l: 'a' };
  if (man.s === undefined) man.s = 'a';   /* 兼容旧的 {m,i,l} 存量 */
  const eff = {};
  for (const [id, key] of [['dirSent', 's'], ['dirMacro', 'm'], ['dirInd', 'i'], ['dirLiq', 'l']]) {
    const sel = $(id); sel.replaceChildren();
    if (auto[key] != null) {
      const o = el('option', '', t('dirAutoOpt')((auto[key] > 0 ? '+' : '') + auto[key].toFixed(1)));
      o.value = 'a'; if (man[key] === 'a') o.selected = true;
      sel.appendChild(o);
    }
    for (const [v, lb] of t('dirOptions')) {
      const o = el('option', '', lb + ' (' + v + ')'); o.value = v;
      if (man[key] !== 'a' && parseFloat(v) === man[key]) o.selected = true;
      else if (man[key] === 'a' && auto[key] == null && parseFloat(v) === 0) o.selected = true;
      sel.appendChild(o);
    }
    eff[key] = man[key] === 'a' ? (auto[key] != null ? auto[key] : 0) : man[key];
  }
  /* 自动信号 chips */
  const s = dirScores(co, r);
  chips.replaceChildren();
  const chip = (txt, sc) => {
    const d = el('div', 'tile'); d.style.minWidth = '0'; d.style.padding = '6px 12px';
    d.appendChild(el('div', 'lb', txt));
    d.appendChild(el('div', 'dt ' + (sc > 0 ? 'pos' : sc < 0 ? 'neg' : ''), sc == null ? t('dirChipNA') : (sc > 0 ? '+' : '') + sc.toFixed(1)));
    chips.appendChild(d);
  };
  chip(s.rev != null && co.rev ? t('dirChipRev')(co.rev.up, co.rev.down) : t('dirChipRev')('—', '—'), s.rev);
  chip(s.val != null ? t('dirChipVal')(s.valPct) : t('dirChipVal')('—'), s.val);
  chip(s.tech != null ? t('dirChipTech')(s.aboveS, s.aboveL) : t('dirChipTech')(false, false), s.tech);
  if (sen.s != null) chip(sen.why.join(' · '), sen.s);
  if (auto.m != null) chip(auto.why.m, auto.m);
  if (auto.why.i) chip(auto.why.i, sectorRS);
  if (pr) chip(t('dirChipPeers')(pr.items), pr.avg);
  if (auto.l != null) chip(auto.why.l, auto.l);
  /* 综合倾斜度:基本面0.30 技术0.15 情绪0.15 宏观0.15 行业0.15 流动性0.10 */
  const fund = (s.rev != null && s.val != null) ? (s.rev + s.val) / 2 : (s.rev != null ? s.rev : (s.val != null ? s.val : 0));
  const tilt = 0.30 * fund + 0.15 * (s.tech || 0) + 0.15 * eff.s + 0.15 * eff.m + 0.15 * eff.i + 0.10 * eff.l;
  let wBull = 0.30 + 0.25 * tilt, wBear = 0.30 - 0.25 * tilt;
  wBull = Math.max(0.05, Math.min(0.55, wBull)); wBear = Math.max(0.05, Math.min(0.55, wBear));
  const wMid = 1 - wBull - wBear;
  /* 情景锚 */
  const pe = peStats(co.ticker), eps1 = epsFor(co.ticker, 'fy1') || {}, eps2 = epsFor(co.ticker, 'fy2') || {};
  const vol = volStats(co.ticker); const sig = vol ? vol.sigma : 0.40;
  const bull = (pe && isFinite(pe.p50) && isFinite(eps2.mean) && eps2.mean > 0) ? pe.p50 * eps2.mean : co.price * Math.exp(0.9 * sig * Math.sqrt(0.5));
  const bear = (pe && isFinite(pe.p10) && isFinite(eps1.low) && eps1.low > 0) ? pe.p10 * eps1.low : co.price * Math.exp(-0.9 * sig * Math.sqrt(0.5));
  const mid = co.price;
  /* MC:6000路径×126日,历史收益去均值 bootstrap + 情景漂移 */
  const c = ph.map(x => x.price);
  const rets = [];
  for (let i = 1; i < c.length; i++) if (c[i - 1] > 0 && c[i] > 0) rets.push(Math.log(c[i] / c[i - 1]));
  const use = rets.slice(-504);
  const mur = use.reduce((a, b) => a + b, 0) / use.length;
  /* 频率→每日:若数据非日线,把收益缩放到日尺度 */
  const gaps = []; for (let i = 1; i < ph.length; i++) { const g = (new Date(ph[i].date) - new Date(ph[i - 1].date)) / 86400000; if (g > 0) gaps.push(g); }
  gaps.sort((a, b) => a - b); const med = gaps[Math.floor(gaps.length / 2)] || 1;
  const perStep = med <= 2 ? 1 : med <= 10 ? 5 : 21;   /* 交易日/样本 */
  const H = Math.max(6, Math.round(126 / perStep));
  const rz = use.map(x => x - mur);
  const NP = 6000, anchors = [[bear, wBear], [mid, wMid], [bull, wBull]];
  let up = 0, up10 = 0, dn10 = 0; const ends = new Array(NP);
  for (let k = 0; k < NP; k++) {
    const rnd = Math.random(); let acc = 0, tgt = mid;
    for (const [a, w] of anchors) { acc += w; if (rnd <= acc) { tgt = a; break; } }
    const drift = Math.log(tgt / co.price) / H;
    let p = co.price;
    for (let d = 0; d < H; d++) p *= Math.exp(rz[(Math.random() * rz.length) | 0] + drift);
    ends[k] = p;
    if (p > co.price) up++;
    if (p > co.price * 1.10) up10++;
    if (p < co.price * 0.90) dn10++;
  }
  ends.sort((a, b) => a - b);
  out.replaceChildren();
  const tile = (lb, vl, cls) => {
    const d = el('div', 'tile'); d.appendChild(el('div', 'lb', lb));
    const v = el('div', 'vl', vl); if (cls) v.classList.add(cls);
    d.appendChild(v); out.appendChild(d);
  };
  const pu = up / NP * 100;
  tile(t('dirPUp'), pu.toFixed(0) + '%', pu >= 55 ? 'pos' : pu <= 45 ? 'neg' : '');
  tile(t('dirPUp10'), (up10 / NP * 100).toFixed(0) + '%', '');
  tile(t('dirPDn10'), (dn10 / NP * 100).toFixed(0) + '%', '');
  tile(t('dirMedian'), fmtN(ends[(NP / 2) | 0]), '');
  const d2 = el('div', 'tile'); d2.appendChild(el('div', 'lb', t('dirWeights')((wBear * 100).toFixed(0), (wMid * 100).toFixed(0), (wBull * 100).toFixed(0))));
  d2.appendChild(el('div', 'dt', 'tilt ' + (tilt > 0 ? '+' : '') + tilt.toFixed(2)));
  out.appendChild(d2);
  $('dirNote').textContent = t('dirNote')(fmtN(bear), fmtN(mid), fmtN(bull));
}
function renderPEBand(co, pe) {
  const sec = $('peBandSec'), box = $('peBandChart'); box.replaceChildren();
  if (!pe || pe.src !== 'history') { sec.hidden = true; return; }
  sec.hidden = false;
  const h = pe.series, W = 1100, H = 300, L = 46, R = 84, T = 16, B = 30;
  let mn = Math.min(...h.map(d => d.pe), pe.p10), mx = Math.max(...h.map(d => d.pe), pe.p90);
  const pad = (mx - mn) * .08 || 1; mn -= pad; mx += pad;
  const x = i => L + i / (h.length - 1) * (W - L - R);
  const y = v => T + (mx - v) / (mx - mn) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'NTM 市盈率历史序列与分位参考线' });
  /* y ticks */
  const step = Math.max(1, Math.round((mx - mn) / 5));
  for (let v = Math.ceil(mn / step) * step; v <= mx; v += step) {
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.appendChild(svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-muted)' }, String(v)));
  }
  /* x year ticks */
  h.forEach((d, i) => {
    if (d.date.slice(5, 7) === '01' || i === 0) {
      svg.appendChild(svgEl('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' }, d.date.slice(0, 4)));
    }
  });
  /* percentile hairlines + right labels(标签垂直防碰撞:最小间距 12px) */
  const plabs = [['p10', 'P10'], ['p25', 'P25'], ['p50', 'P50'], ['p75', 'P75'], ['p90', 'P90']].map(([k, lb]) => ({ k, lb, ly: y(pe[k]) }));
  for (const pl of plabs) {
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(pe[pl.k]), y2: y(pe[pl.k]), stroke: 'var(--axis)', 'stroke-width': 1 }));
  }
  plabs.sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < plabs.length; i++) {
    if (plabs[i].ly < plabs[i - 1].ly + 12) plabs[i].ly = plabs[i - 1].ly + 12;
  }
  for (const pl of plabs) {
    svg.appendChild(svgEl('text', { x: W - R + 8, y: pl.ly + 4, 'font-size': 11, fill: 'var(--text-secondary)' }, pl.lb + ' ' + fmtX(pe[pl.k])));
  }
  /* line */
  let dstr = '';
  h.forEach((d, i) => { dstr += (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(d.pe).toFixed(1); });
  svg.appendChild(svgEl('path', { d: dstr, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  /* current dot + label */
  const li = h.length - 1;
  svg.appendChild(svgEl('circle', { cx: x(li), cy: y(h[li].pe), r: 4.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
  svg.appendChild(svgEl('text', { x: x(li) - 8, y: y(h[li].pe) - 12, 'text-anchor': 'end', 'font-size': 11.5, 'font-weight': 650, fill: 'var(--text-primary)' }, t('peCur') + fmtX(h[li].pe)));
  /* crosshair + tooltip */
  const cross = svgEl('line', { y1: T, y2: H - B, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
  const tip = $('peTip');
  hit.addEventListener('pointermove', ev => {
    const bb = $('peBandBox').getBoundingClientRect();
    const svgX = (ev.clientX - bb.left) / bb.width * W;
    const i = Math.max(0, Math.min(h.length - 1, Math.round((svgX - L) / (W - L - R) * (h.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    tip.appendChild(el('div', 'v', fmtX(h[i].pe)));
    const k = el('div', 'k');
    const key = el('span', 'key'); key.style.background = 'var(--series-1)';
    k.appendChild(key);
    k.appendChild(document.createTextNode(h[i].date.slice(0, 7) + ' · ' + t('histPct')(rankPct(pe.sorted, h[i].pe))));
    tip.appendChild(k);
    tip.style.display = 'block';
    tip.style.left = Math.min(ev.clientX - bb.left + 14, bb.width - 190) + 'px';
    tip.style.top = (ev.clientY - bb.top - 48) + 'px';
  });
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  svg.appendChild(hit);
  box.appendChild(svg);
  const s = $('peStatsLine');
  s.textContent = t('peStats')(h.length, h[0].date.slice(0, 7), h[li].date.slice(0, 7)) + '· P10 ' + fmtX(pe.p10)
    + ' · P25 ' + fmtX(pe.p25) + ' · ' + t('peMedianShort') + ' ' + fmtX(pe.p50) + ' · P75 ' + fmtX(pe.p75) + ' · P90 ' + fmtX(pe.p90)
    + ' · ' + t('peCur') + fmtX(pe.current) + t('pctOf')(rankPct(pe.sorted, pe.current))
    + (h.length < 36 ? t('peShortWin') : '');
}

