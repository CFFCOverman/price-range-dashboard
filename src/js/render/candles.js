/* ================= 价格走势面板(有 OHLC 画蜡烛,没有就降级成收盘折线) =================
 *
 * 这块面板的规矩,写在最前面,因为它比画法重要得多:
 *
 * 1. **一条指标线都不画。** SPEC 附录 K 预注册了 4 个指标 × 3 个前瞻期 = 12 格,
 *    2026-08-06 那一跑 12 格全部未过闸(卡 C3 折间一致性与 C4 效应量,不是样本量)。
 *    K.8 写死了后果:过不了闸的东西落成素线、无颜色、无徽章、无判语。这里选择更省事的做法 ——
 *    干脆不画,并在图下方把这件事写成正文。把没过线的均线画成绿色,等于把
 *    「回测数字说话,过不了就明说这条信号没用」这条规矩作废,那比少一个功能严重得多。
 * 2. **蜡烛实体的红绿是描述,不是判断。** 它说的是"这一天收盘高于/低于开盘"这个已经发生的事实,
 *    不含任何对明天的暗示。图例和正文都要把这句话写出来 —— 颜色本身不会自己声明它是描述。
 * 3. **没有 O/H/L 就不画蜡烛。** 不许用收盘价近似出开盘价("昨收当今开")把图凑成 K 线:
 *    那画出来的每一根都是编的,而且看上去完全像真的(SPEC K.2 / 4.3 那一类静默事故)。
 *    降级路径(收盘折线)是**主路径**:盘上今天一份 OHLC 都没有。
 *
 * 画法沿用 render/direction.js 的 renderPEBand:createElementNS(svgEl) 手搭,零依赖,不引任何图表库。
 */

/* 窗口档位。'all' 给 0 = 不截断。默认落在 120 根:252 根挤进 1100px 宽时每根只有 4px,
 * 蜡烛实体会糊成一片;120 根是"看得清单根"与"看得见趋势"之间的折中。 */
const KL_WINS = [{ id: 'w60', n: 60 }, { id: 'w120', n: 120 }, { id: 'all', n: 0 }];
function klWinNow() {
  const id = state.klWin;
  return KL_WINS.find(w => w.id === id) || KL_WINS[1];
}
/** 一根 K 线的四个数齐不齐。缺一个就当这根没有 OHLC —— 半根蜡烛不是"部分可用"。 */
function klBarOK(d) {
  return !!d && isFinite(d.o) && d.o > 0 && isFinite(d.h) && d.h > 0 && isFinite(d.l) && d.l > 0
    && d.h >= d.l && d.h >= Math.max(d.o, d.price) && d.l <= Math.min(d.o, d.price);
}
/** 整段都齐才画蜡烛。混着画(有的根有实体、有的根只有一个点)读起来像数据缺失,
 *  而实际上它是两种口径混排 —— 宁可整段降级成折线,口径至少是一个。 */
function klHasOHLC(arr) { return !!(arr && arr.length) && arr.every(klBarOK); }
/** y 轴刻度步长:取 1/2/5 × 10^k 里刚好不小于 span/5 的那个,免得刻度写成 17.3333 */
function klStep(span) {
  const raw = (span || 0) / 5;
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw))), u = raw / mag;
  return (u <= 1 ? 1 : u <= 2 ? 2 : u <= 5 ? 5 : 10) * mag;
}

function renderCandles(co) {
  const sec = $('klSec'), box = $('klChart'), note = $('klNote'), leg = $('klLegend'), tabs = $('klWinTabs');
  const levelTabs = $('klLevelTabs'), layerTabs = $('klLayerTabs'), levels = $('klLevels'), refsBox = $('klRefs');
  box.replaceChildren(); note.replaceChildren(); leg.replaceChildren(); levels.replaceChildren(); refsBox.replaceChildren();
  const all = (co && state.priceHist.get(co.ticker)) || [];
  /* 两根以下画不出任何东西(连一段线都连不起来),整块收起而不是留一个空框 */
  if (all.length < 2) { sec.hidden = true; return; }
  sec.hidden = false;

  const win = klWinNow();
  if (tabs) {
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.klw === win.id);
    /* onclick 赋值而不是 addEventListener:renderCandles 每次重绘都会走到这里,
     * addEventListener 会一次次叠加(与 render/pressure.js 的持有期切换同一个坑)。 */
    tabs.onclick = ev => {
      const b = ev.target.closest('button');
      if (!b || !b.dataset.klw || b.dataset.klw === klWinNow().id) return;
      state.klWin = b.dataset.klw;
      renderCandles(co);
    };
  }

  const levelHold = PX_HORIZONS[state.klLevelHold] ? state.klLevelHold : 'mid';
  if (levelTabs) {
    for (const b of levelTabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.klh === levelHold);
    levelTabs.onclick = ev => {
      const b = ev.target.closest('button');
      if (!b || !PX_HORIZONS[b.dataset.klh] || b.dataset.klh === levelHold) return;
      state.klLevelHold = b.dataset.klh;
      renderCandles(co);
    };
  }
  const layers = state.klLayers || (state.klLayers = { tech: true, matrix: true, option: true });
  if (layerTabs) {
    for (const b of layerTabs.querySelectorAll('button')) b.classList.toggle('on', layers[b.dataset.kll] !== false);
    layerTabs.onclick = ev => {
      const b = ev.target.closest('button');
      if (!b || !b.dataset.kll) return;
      layers[b.dataset.kll] = layers[b.dataset.kll] === false;
      renderCandles(co);
    };
  }

  const h = win.n > 0 ? all.slice(-win.n) : all;
  const ohlc = klHasOHLC(h);
  const n = h.length;
  const lastPx = all[all.length - 1].price;
  const dens = priceDensity(co.ticker, null, PX_HORIZONS[levelHold]);
  const structure = structuralLevels(co.ticker, null, PX_HORIZONS[levelHold]);
  const range = calcRange(co, state.horizon);
  const epsKey = state.mxPick.eps === 'opt' ? 'high' : state.mxPick.eps === 'pes' ? 'low' : 'mean';
  const pickedMatrix = range && pePos(range.pe, state.mxPick.pe) && isFinite(range.eps[epsKey])
    ? range.eps[epsKey] * range.pe[state.mxPick.pe] : NaN;
  const matrixRefs = range ? [
    isFinite(pickedMatrix) && { price: pickedMatrix, label: t('klMxPicked'), role: 'picked' },
    isFinite(range.coreLow) && { price: range.coreLow, label: t('klMxLow'), role: 'core' },
    isFinite(range.coreHigh) && { price: range.coreHigh, label: t('klMxHigh'), role: 'core' },
  ].filter(Boolean).filter((x, i, a) => a.findIndex(y => Math.abs(y.price - x.price) < .005) === i) : [];
  const opt = optionWalls(co, null, PX_HORIZONS[levelHold]);
  const optWalls = opt ? opt.walls.slice().sort((a, b) => (b.oi * b.w * b.align) - (a.oi * a.w * a.align)) : [];
  const optRefs = [
    optWalls.find(w => w.strike > lastPx),
    optWalls.find(w => w.strike < lastPx),
  ].filter(Boolean).filter((x, i, a) => a.findIndex(y => y.strike === x.strike) === i);
  const bands = dens ? dens.bands : [];
  const inside = bands.filter(b => lastPx >= b.lo && lastPx <= b.h).sort((a, b) => b.share - a.share)[0] || null;
  let upper = structure && structure.upper ? { ...structure.upper, structural: true } : null;
  let lower = structure && structure.lower ? { ...structure.lower, structural: true } : null;
  const zones = [{ kind: 'down', band: lower }, { kind: 'now', band: inside }, { kind: 'up', band: upper }].filter(z => z.band);
  const W = 1100, H = 320, L = 52, R = 176, T = 14, B = 28;
  let mn = Math.min(...h.map(d => ohlc ? d.l : d.price));
  let mx = Math.max(...h.map(d => ohlc ? d.h : d.price));
  /* 最近上下带属于本图的核心读数，纳入纵轴，避免它恰好在窗口外时被悄悄裁掉。 */
  if (layers.tech) for (const z of zones) { mn = Math.min(mn, z.band.lo); mx = Math.max(mx, z.band.hi); }
  /* 只把仍在现价合理视野内的外部参考纳入纵轴，极端估值情景留在卡片中，不能压扁价格线。 */
  const plottedMx = layers.matrix ? matrixRefs.filter(v => v.price >= lastPx * .65 && v.price <= lastPx * 1.45) : [];
  const plottedOpt = layers.option ? optRefs.filter(v => v.strike >= lastPx * .65 && v.strike <= lastPx * 1.45) : [];
  for (const v of plottedMx) { mn = Math.min(mn, v.price); mx = Math.max(mx, v.price); }
  for (const v of plottedOpt) { mn = Math.min(mn, v.strike); mx = Math.max(mx, v.strike); }
  const pad = (mx - mn) * .06 || Math.max(1, mx * .02);
  mn -= pad; mx += pad;
  const step = (W - L - R) / n;
  const cx = i => L + (i + 0.5) * step;
  const y = v => T + (mx - v) / (mx - mn) * (H - T - B);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': ohlc ? '每日开高低收蜡烛图(颜色仅描述当日涨跌事实)' : '每日收盘价折线(导出无 OHLC 列)',
  });

  /* 密集带是历史价格/成交量分布，不是技术指标线，也不是“必守”的预测位。 */
  for (const z of layers.tech ? zones : []) {
    const col = z.kind === 'up' ? 'var(--series-2)' : z.kind === 'down' ? 'var(--series-1)' : 'var(--axis)';
    svg.appendChild(svgEl('rect', {
      class: 'klzone klzone-' + z.kind, x: L, y: y(z.band.hi), width: W - L - R,
      height: Math.max(2, y(z.band.lo) - y(z.band.hi)), fill: col,
      opacity: z.band.structural ? (.045 + (z.band.strength || 1) * .025) : .11,
    }));
    svg.appendChild(svgEl('line', {
      x1: L, x2: W - R, y1: y(z.band.peak), y2: y(z.band.peak), stroke: col,
      'stroke-width': 1, 'stroke-dasharray': '2 4', opacity: .75,
    }));
    const zt = svgEl('text', { x: W - R + 8, y: y(z.band.peak) + 4, 'font-size': 10.5,
      fill: 'var(--text-secondary)', 'font-weight': 650 });
    const zn = z.kind === 'up' ? t('klStructUp') : z.kind === 'down' ? t('klStructDown') : t('klZoneNow');
    zt.textContent = zn + ' ' + fmtN(z.band.lo) + '–' + fmtN(z.band.hi)
      + (z.band.structural ? ' ' + z.band.strength + '/5' : '');
    svg.appendChild(zt);
  }
  /* Matrix 是估值参考，期权墙是 OI 存量：使用不同线型，不与技术结构带混色。 */
  for (const v of plottedMx) {
    svg.appendChild(svgEl('line', { class: 'klref klref-matrix', x1: L, x2: W - R, y1: y(v.price), y2: y(v.price),
      stroke: 'var(--axis)', 'stroke-width': v.role === 'picked' ? 1.8 : 1, 'stroke-dasharray': v.role === 'picked' ? '7 4' : '3 5', opacity: .85 }));
    svg.appendChild(svgEl('text', { x: L + 8, y: y(v.price) - 4, 'font-size': 10.5, fill: 'var(--text-muted)' },
      'Matrix · ' + v.label + ' ' + fmtN(v.price)));
  }
  const maxOptOI = Math.max(1, ...plottedOpt.map(v => v.oi));
  for (const v of plottedOpt) {
    const len = (W - L - R) * (.12 + .18 * v.oi / maxOptOI);
    svg.appendChild(svgEl('line', { class: 'klref klref-opt', x1: W - R - len, x2: W - R,
      y1: y(v.strike), y2: y(v.strike), stroke: 'var(--series-2)', 'stroke-width': 3, opacity: .78 }));
    svg.appendChild(svgEl('text', { x: W - R - len - 7, y: y(v.strike) + 4, 'text-anchor': 'end',
      'font-size': 10.5, fill: 'var(--text-secondary)' }, t('klOptWall') + ' ' + fmtN(v.strike)));
  }

  /* y 网格 + 右侧价格刻度 */
  const gs = klStep(mx - mn);
  for (let v = Math.ceil(mn / gs) * gs; v <= mx; v += gs) {
    svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.appendChild(svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-muted)' }, fmtN(v)));
  }
  /* x 轴:月份变了才写一个标签,且与上一个标签至少隔 70px,不然 252 根会写成一条黑边 */
  let lastLab = -1e9;
  for (let i = 0; i < n; i++) {
    const cur = h[i].date.slice(0, 7);
    if (i > 0 && cur === h[i - 1].date.slice(0, 7)) continue;
    if (cx(i) - lastLab < 70) continue;
    lastLab = cx(i);
    svg.appendChild(svgEl('text', { x: cx(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-muted)' }, cur));
  }

  if (ohlc) {
    /* 蜡烛:影线 = 当日最高↔最低,实体 = 开↔收。红绿描述"收盘相对开盘"的方向,
     * 是已发生事实,不是信号(图例与正文各写一遍,免得只有颜色说话)。 */
    const bw = Math.max(1.2, Math.min(9, step * 0.68));
    for (let i = 0; i < n; i++) {
      const d = h[i], up = d.price >= d.o;
      const col = up ? 'var(--delta-up)' : 'var(--delta-down)';
      svg.appendChild(svgEl('line', {
        class: 'klwick', x1: cx(i), x2: cx(i), y1: y(d.h), y2: y(d.l),
        stroke: col, 'stroke-width': Math.min(1.4, Math.max(0.8, step * 0.14)),
      }));
      const top = y(Math.max(d.o, d.price)), bot = y(Math.min(d.o, d.price));
      svg.appendChild(svgEl('rect', {
        class: 'klbody', x: cx(i) - bw / 2, y: top, width: bw,
        /* 开=收 的十字星实体高度是 0,给 1px 保底,否则那一天在图上整根消失 */
        height: Math.max(1, bot - top), fill: col,
      }));
    }
  } else {
    /* 降级:只有收盘价。用中性的 series-1,不按涨跌上色 —— 折线上的颜色没有"当天开收"这个事实可描述,
     * 涂上去就只剩暗示了。 */
    let dstr = '';
    for (let i = 0; i < n; i++) dstr += (i ? 'L' : 'M') + cx(i).toFixed(1) + ',' + y(h[i].price).toFixed(1);
    svg.appendChild(svgEl('path', {
      class: 'klline', d: dstr, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 1.8,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  /* 最后一根收盘价:一条素色虚线 + 右侧数字。它只是"最新收盘在哪",不是参考位、不是目标价。 */
  const last = h[n - 1];
  svg.appendChild(svgEl('line', {
    x1: L, x2: W - R, y1: y(last.price), y2: y(last.price),
    stroke: 'var(--axis)', 'stroke-width': 1, 'stroke-dasharray': '4 4',
  }));
  svg.appendChild(svgEl('text', {
    x: W - R + 8, y: y(last.price) + 4, 'font-size': 11.5, 'font-weight': 650, fill: 'var(--text-primary)',
  }, fmtN(last.price)));

  /* 十字线 + tooltip(与 renderPEBand 同一套写法) */
  const cross = svgEl('line', { y1: T, y2: H - B, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
  const tip = $('klTip');
  hit.addEventListener('pointermove', ev => {
    const bb = $('klBox').getBoundingClientRect();
    const svgX = (ev.clientX - bb.left) / bb.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((svgX - L) / step)));
    const d = h[i];
    cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i));
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    tip.appendChild(el('div', 'v', t('klTipC') + fmtN(d.price)));
    if (ohlc) tip.appendChild(el('div', 'k', t('klTipO') + fmtN(d.o) + ' · ' + t('klTipH') + fmtN(d.h) + ' · ' + t('klTipL') + fmtN(d.l)));
    tip.appendChild(el('div', 'k', d.date));
    tip.style.display = 'block';
    tip.style.left = Math.min(ev.clientX - bb.left + 14, bb.width - 190) + 'px';
    tip.style.top = (ev.clientY - bb.top - 52) + 'px';
  });
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
  svg.appendChild(hit);
  box.appendChild(svg);

  if (zones.length) {
    for (const z of zones) {
      const b = z.band, distU = dens && dens.u > 0
        ? (z.kind === 'up' ? Math.max(0, b.lo - lastPx) : z.kind === 'down' ? Math.max(0, lastPx - b.hi) : 0) / dens.u
        : 0;
      const card = el('div', 'kllevel ' + z.kind);
      const titleKey = z.band.structural
        ? (z.kind === 'up' ? 'klStructUp' : 'klStructDown')
        : z.band.fallback
          ? (z.kind === 'up' ? 'klSwingUp' : 'klSwingDown')
        : (z.kind === 'up' ? 'klZoneUp' : z.kind === 'down' ? 'klZoneDown' : 'klZoneNow');
      card.appendChild(el('div', 'k', t(titleKey)));
      card.appendChild(el('div', 'v', fmtN(b.lo) + ' – ' + fmtN(b.hi)));
      if (b.structural) {
        const level = b.strength >= 4 ? 'strong' : b.strength >= 3 ? 'medium' : 'weak';
        card.appendChild(el('div', 'klstrength ' + level,
          t(z.kind === 'up' ? 'klPressureStrength' : 'klSupportStrength')(b.strength, t('klStrengthNames')[level])));
        card.appendChild(el('div', 'k', t('klStrengthParts')(b.strengthParts.repeat, b.strengthParts.reaction, b.strengthParts.recent)));
      }
      card.appendChild(el('div', 'k', t('klZoneMeta')(b.touch || 0, b.last || '—', fmtN(distU) + 'u')));
      levels.appendChild(card);
    }
    if (!upper) levels.appendChild(el('div', 'kllevel up', t('klNoStructUp')));
    if (!lower) levels.appendChild(el('div', 'kllevel down', t('klNoStructDown')));
  } else levels.appendChild(el('div', 'hint', t('klZoneNone')));

  let resonanceShown = false;
  for (const z of zones.filter(x => x.band.structural)) {
    const nearMx = matrixRefs.some(v => v.price >= z.band.lo - (structure ? structure.tol : 0) && v.price <= z.band.hi + (structure ? structure.tol : 0));
    const nearOpt = optRefs.some(v => v.strike >= z.band.lo - (structure ? structure.tol : 0) && v.strike <= z.band.hi + (structure ? structure.tol : 0));
    const nTrack = 1 + (nearMx ? 1 : 0) + (nearOpt ? 1 : 0);
    if (nTrack > 1) {
      const badge = el('div', 'klresonance', t('klResonance')(nTrack));
      badge.appendChild(document.createTextNode(' · ' + [t('klTechTrack'), nearMx && 'Matrix', nearOpt && t('klOptTrack')].filter(Boolean).join(' + ')));
      refsBox.appendChild(badge);
      resonanceShown = true;
    }
  }
  if (!resonanceShown) refsBox.appendChild(el('div', 'klresonance quiet', t('klNoResonance')));

  /* 图例:蜡烛模式下两块色片 + 一句"颜色只描述当日方向";折线模式下只有一条线,没有颜色可解释 */
  const swatch = (bg, txt) => {
    const s = el('span');
    const k = el('span', 'sw'); k.style.background = bg; s.appendChild(k);
    s.appendChild(document.createTextNode(txt)); leg.appendChild(s);
  };
  if (ohlc) {
    swatch('var(--delta-up)', t('klLegUp'));
    swatch('var(--delta-down)', t('klLegDown'));
    leg.appendChild(el('span', '', t('klLegDesc')));
  } else {
    const s = el('span');
    const k = el('span', 'ln'); k.style.background = 'var(--series-1)'; s.appendChild(k);
    s.appendChild(document.createTextNode(t('klLegClose'))); leg.appendChild(s);
  }

  plRich(note.appendChild(el('span', 'plnl')), t('klRange')(n, h[0].date, last.date, all.length));
  plRich(note.appendChild(el('span', 'plnl')), t(ohlc ? 'klModeCandle' : 'klModeLine'));
  if (structure) plRich(note.appendChild(el('span', 'plnl')), t('klStructBasis')(structure.n, structure.from, structure.to));
  if (matrixRefs.length || optRefs.length) plRich(note.appendChild(el('span', 'plnl')), t('klExternalNote'));
  if (dens) plRich(note.appendChild(el('span', 'plnl')), t('klZoneBasis')(dens.basis, dens.n, dens.from, dens.to));
  plRich(note.appendChild(el('span', 'plnl')), t('klNoInd'));
}
