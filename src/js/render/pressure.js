/* ================= 压力位 / 支撑位面板 =================
 * 这一版对上一版删掉的东西比加上的多,每一处删除都有一条回测结论顶着:
 *   · **没有强度列、没有进度条。** 旧的 0–100 分与后续走势的相关系数是 +0.01,
 *     而进度条这个视觉隐喻本身就在宣称"越长越可信"。表里只留带单位的原始量:σ 距离、触及概率。
 *   · **估值参考线永远不进表**,只在图上画一条虚线(D 组 valAnchorBias 已判 biased)。
 *   · **未验证的腿不走百分比。** 不是"渲染时跳过",是这条腿根本走不到格式化百分比的那个分支 ——
 *     两个分支写在下面 `mkRow` 里,verified 走 `plReachPct`,pending 走 `t('plOptPending')`。
 *     "先算出来再决定显不显示"迟早会有人把它显示出来;不存在的代码路径没法被打开。
 *   · **"守不守得住"这件事测不出来** —— 这句话是表格下方的常驻正文(`.plsay`),不是 tooltip。
 *     少掉一个功能而把理由藏进悬浮提示,用户只会读成"你们做少了"。
 *
 * 持有期(short/mid/long → h = 5/21/63)存在 `state.plHold`。
 * **绝不能用 `state.horizon`**:那是财年 fy1/fy2,`PX_HORIZONS['fy1']` = undefined
 * → √undefined = NaN → u = NaN → 两张表全空 → 面板静默消失,控制台干干净净。
 * engine.js 里对非法值有兜底并会往 why 里写一句,但那是最后一道网,不是这里偷懒的理由。 */

/** 触及概率 → 百分比。**只有 evidence === 'verified' 的腿允许调到这里。**
 *  它是本文件里唯一一处产出 `%` 的代码;未验证腿的那个分支里没有它。 */
function plReachPct(p) { return isFinite(p) ? (p * 100).toFixed(0) + '%' : '—'; }

/** i18n 里照 SPEC 逐字抄的文案带着 `**强调**` 标记(比如 plBounceNote 的第一句)。
 *  这里把它渲染成 <strong>,而不是回头去改词条 —— 词条要与规格逐字一致,格式化是渲染层的事。 */
function plRich(node, s) {
  const parts = String(s == null ? '' : s).split('**');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    node.appendChild(i % 2 ? el('strong', '', parts[i]) : document.createTextNode(parts[i]));
  }
  return node;
}
/** 同一条文案进 title 属性时的纯文本版(title 里渲染不了 <strong>)。 */
function plPlain(s) { return String(s == null ? '' : s).replace(/\*\*/g, ''); }

/** 当前持有期。非法值一律落回 'mid' —— 与 engine.js 同一套兜底,但这里先兜一次,
 *  好让高亮的那个按钮和真正算出来的 h 永远是同一个。 */
function plHoldNow() {
  const v = state.plHold;
  return (v === 'short' || v === 'mid' || v === 'long') ? v : 'mid';
}

function renderPressure(co, r) {
  const sec = $('plSec'), box = $('plChart'), tbl = $('plTable'), note = $('plNote'), tabs = $('plHoldTabs');
  box.replaceChildren(); tbl.replaceChildren(); note.replaceChildren();
  /* 连现价都没有 = 这一屏没有任何可说的东西,整块收起(详情页别处已经在提示缺现价了)。
   * 与"有价但历史不够"是两种情况:后者要出一句话,见下面 P === null 的分支。 */
  if (!co || !isFinite(co.price) || co.price <= 0) { sec.hidden = true; return; }
  sec.hidden = false;

  const hold = plHoldNow();
  state.plHold = hold;
  /* 切换器:onclick 属性赋值而不是 addEventListener —— renderPressure 每次重绘都会走到这里,
   * 用 addEventListener 会一次次叠加,点一下触发 N 次重绘。 */
  if (tabs) {
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.plh === hold);
    tabs.onclick = ev => {
      const b = ev.target.closest('button');
      if (!b || !b.dataset.plh || b.dataset.plh === plHoldNow()) return;
      state.plHold = b.dataset.plh;
      /* 整块重算重绘:带宽 u = σd·√h·P 里的 h 变了,分箱宽度、带宽下限、合并容差、
       * 视野闸门、触及概率全都跟着变 —— 只改个显示会得到一张与标签不符的表。 */
      renderPressure(co, r);
    };
  }

  const P = pressureLevels(co, r, null, hold);
  if (!P) {
    /* 引擎在既没有密度带、又没有 OI 墙时返回 null(估值轨单独撑不起这张表)。
     * 这里出一句话而不是留白:空面板读起来像"坏了",一句话读起来像"这只票没这个信息"。 */
    tbl.appendChild(el('p', 'hint', t('plNone')));
    note.appendChild(el('span', 'plnl', t('plHorizonNote')));
    return;
  }
  const shown = [...(P.inBand ? [P.inBand] : []), ...P.up, ...P.down];

  /* ---- 侧向密度图:纵轴是价格,横条是密集度 ---- */
  const dens = P.dens;
  if (dens) {
    const W = 560, H = 360, ML = 62, MR = 16, MT = 10, MB = 24;
    const lo = Math.min(dens.min, P.price, ...shown.map(L => L.lo));
    const hi = Math.max(dens.max, P.price, ...shown.map(L => L.hi));
    const pad = (hi - lo) * 0.04 || 1;
    const y = v => MT + (hi + pad - v) / ((hi + pad) - (lo - pad)) * (H - MT - MB);
    const maxShare = Math.max(...dens.bins.map(b => b.share)) || 1;
    const barW = W - ML - MR;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'price congestion profile' });
    /* 价位带底纹。**带宽随持有期变**:h 从 5 → 21 → 63,半宽下限 PX_HALF_U·u 按 √h 放大
     * 约 1 : 2.05 : 3.55 —— 切换持有期时肉眼看到的就是这几条底纹变粗。 */
    for (const L of shown) {
      if (!L.src.tech) continue;
      const yt = y(L.hi), yb = y(L.lo);
      svg.appendChild(svgEl('rect', {
        x: ML, y: Math.min(yt, yb), width: barW, height: Math.max(2, Math.abs(yb - yt)),
        fill: L.tracks.length >= 2 ? 'var(--wash-strong)' : 'var(--ghost)',
      }));
    }
    /* 密度横条 */
    for (const b of dens.bins) {
      if (!(b.share > 0)) continue;
      const yt = y(b.hi), yb = y(b.lo), bh = Math.max(1, Math.abs(yb - yt) - 1);
      svg.appendChild(svgEl('rect', {
        x: ML, y: Math.min(yt, yb), width: Math.max(1, b.share / maxShare * barW), height: bh,
        fill: 'var(--series-1)', opacity: 0.5, rx: 1,
      }));
    }
    /* 估值参考线:虚线 + 分位标签,并挂 plValRefTip。它从 P.valRefs 来,不挂在任何 Level 上 ——
     * 挂在 Level 上就意味着它"进过表",而它永远不该进表。 */
    for (const v of P.valRefs) {
      const yy = y(v.price);
      const ln = svgEl('line', { x1: ML - 6, x2: ML + barW, y1: yy, y2: yy, stroke: 'var(--axis)', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
      ln.appendChild(svgEl('title', {}, t('plValRef') + ' — ' + t('plValRefTip')));
      svg.appendChild(ln);
      const tx = svgEl('text', { x: ML - 9, y: yy + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-muted)' });
      tx.textContent = v.label;
      svg.appendChild(tx);
    }
    /* 期权 OI 墙:右侧竖条,长度按 OI 相对最大值;近月实心、远月半透明。长度只表示 OI 大小,
     * 不是强度 —— 这一轨 evidence 恒为 pending,不产出任何百分比。 */
    const allW = P.opt ? P.opt.walls : [];
    if (allW.length) {
      const mxOI = Math.max(...allW.map(w => w.oi));
      for (const w of allW) {
        const yy = y(w.strike), len = Math.max(4, (w.oi / mxOI) * barW * 0.28);
        const rc = svgEl('rect', {
          x: ML + barW - len, y: yy - 2.5, width: len, height: 5, rx: 2,
          fill: 'var(--delta-down)', opacity: w.w >= 1 ? 0.75 : 0.4,
        });
        rc.appendChild(svgEl('title', {}, plPlain(t('plOptPendingTip'))));
        svg.appendChild(rc);
      }
    }
    /* 现价 */
    const yp = y(P.price);
    svg.appendChild(svgEl('line', { x1: ML - 10, x2: ML + barW, y1: yp, y2: yp, stroke: 'var(--series-2)', 'stroke-width': 2 }));
    const pl = svgEl('text', { x: ML - 13, y: yp + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--series-2)', 'font-weight': 650 });
    pl.textContent = fmtN(P.price);
    svg.appendChild(pl);
    /* 上下边界价格标注 */
    for (const v of [hi, lo]) {
      const tx = svgEl('text', { x: ML - 13, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--text-muted)' });
      tx.textContent = fmtN(v);
      svg.appendChild(tx);
    }
    const ax = svgEl('text', { x: ML, y: H - 8, 'font-size': 10, fill: 'var(--text-muted)' });
    ax.textContent = '← ' + t('plAxisWt');
    svg.appendChild(ax);
    svg.appendChild(svgEl('line', { x1: ML, x2: ML, y1: MT, y2: H - MB, stroke: 'var(--axis)', 'stroke-width': 1 }));
    box.appendChild(svg);
    if (P.valRefs.length) {
      const lg = el('p', 'plleg');
      lg.appendChild(el('i'));
      lg.appendChild(el('span', '', t('plValRef')));
      lg.title = t('plValRefTip');
      box.appendChild(lg);
    }
  }

  /* ---- 表格:位置 / 距离(σ) / 本期触及概率 / 来源轨 / 证据等级 ---- */
  const mkTable = (title, list, dir, emptyKey) => {
    const h3 = el('h3', 'plh ' + dir, title);
    tbl.appendChild(h3);
    if (!list.length) { tbl.appendChild(el('p', 'hint', t(emptyKey))); return; }
    const tb = el('table', 'mx pl');
    const hr = el('tr');
    for (const [label, tip] of [
      [t('plZone'), ''], [t('plDistU'), ''], [t('plReach'), plPlain(t('plReachTip'))],
      [t('plTracks'), ''], [t('plEvidenceCol'), ''],
    ]) {
      const th = el('th', '', label);
      if (tip) { th.title = tip; th.style.cursor = 'help'; }
      hr.appendChild(th);
    }
    tb.appendChild(hr);
    for (const L of list) {
      const tr = el('tr');
      tr.appendChild(el('td', '', L.lo === L.hi ? fmtN(L.mid) : fmtN(L.lo) + ' ~ ' + fmtN(L.hi)));
      /* 距离用 σ(= 本期一个标准差 u),不用百分比:同一个 3% 在 NVDA 和 KO 上不是同一件事,
       * 而 σ 已经把波动率除掉了,三个持有期之间也能直接比。 */
      tr.appendChild(el('td', 'pldist ' + (L.distU >= 0 ? 'pos' : 'neg'),
        isFinite(L.distU) ? (L.distU >= 0 ? '+' : '') + L.distU.toFixed(2) + 'σ' : '—'));
      /* ---- 触及概率:两个互斥分支,pending 那条上没有百分比格式化函数 ---- */
      const rc = el('td', '');
      if (L.evidence === 'verified') {
        const sp = el('span', 'plreach', plReachPct(L.pReach));
        sp.title = plPlain(t('plReachTip'));
        rc.appendChild(sp);
      } else {
        /* 未验证分支里再分两种口径:有期权腿的说 OI 墙,没有的说校准没过。
         * 合成一句会印出「OI 墙 0 面 · 未验证」—— 那句话在纯技术轨的行上既不对也读不懂。
         * 两条文案都不含百分号,分支本身仍然是"到不了 plReachPct"的那一条。 */
        const nOpt = L.src.opts.length;
        const sp = el('span', 'plpend', nOpt ? t('plOptPending')(nOpt) : t('plReachPending'));
        sp.title = plPlain(t(nOpt ? 'plOptPendingTip' : 'plReachPendingTip'));
        rc.appendChild(sp);
      }
      tr.appendChild(rc);
      /* 来源轨:参与的轨各一个徽章(tech / opt),下面挂原始量 —— 摆动触及次数、OI 墙明细。 */
      const bs = el('td', '');
      for (const k of L.tracks) {
        const tag = el('span', 'pltag ' + k, t('plKind')[k]);
        tag.title = t('plKindTip')[k];
        bs.appendChild(tag);
      }
      const bits = [];
      if (L.src.tech && L.src.tech.touch) bits.push(t('plSwing')(L.src.tech.touch));
      for (const w of L.src.opts) bits.push(t('plWall')(fmtInt(w.oi), w.dte, w.callOI >= w.putOI ? 'C' : 'P'));
      if (bits.length) {
        /* 一个价位上叠八面墙是常事(NVDA 实测),全铺出来这一列会把另外四列挤扁。
         * 截到 4 条 + "+N",完整清单挂 title —— 截断的是排版,不是数据。 */
        const sub = el('span', 'sub', bits.slice(0, 4).join(' · ') + (bits.length > 4 ? ' · +' + (bits.length - 4) : ''));
        if (bits.length > 4) sub.title = bits.join(' · ');
        bs.appendChild(sub);
      }
      tr.appendChild(bs);
      /* 证据等级:徽章文案与 tooltip 都来自 PX_EVIDENCE 的分级表,不是渲染层自己起的名字。 */
      const ev = el('td', '');
      const badge = el('span', 'plev ' + L.evidence, t('plEvidence')[L.evidence] || L.evidence);
      badge.title = t('plEvidenceTip')[L.evidence] || '';
      ev.appendChild(badge);
      tr.appendChild(ev);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
  };
  mkTable(t('plUp'), P.up, 'up', 'plNoneUp');
  mkTable(t('plDown'), P.down, 'down', 'plNoneDown');
  if (P.inBand) tbl.appendChild(el('p', 'hint warn', t('plInBand')(fmtN(P.inBand.lo) + ' ~ ' + fmtN(P.inBand.hi))));

  /* ---- 表格下方的常驻正文。三段都必须可见,一段都不许降级成 tooltip ----
   * plBounceNote:这张表不回答"挡不挡得住"(B 组测过,max z ≈ 1.2,门槛 2);
   * plNoStrength:强度列为什么整列没了;
   * plHorizonNote:为什么切持有期带子会变宽。 */
  const say = el('div', 'plsay');
  const saidKeys = ['plBounceNote', 'plNoStrength', 'plHorizonNote'];
  for (const k of saidKeys) plRich(say.appendChild(el('p')), t(k));
  tbl.appendChild(say);
  /* 引擎的 why 与这三段是**同一批句子的两个出处**(SPEC 3.2 让 engine 发,3.5 让 i18n 拥有)。
   * 两边都要渲染,但同一句话在一屏里印两遍会被读成 bug。只按**规范化后完全相等**去重:
   * 归一化只去空白与 ** 标记,不做模糊匹配 —— 引擎将来换了措辞,应该照原样冒出来,而不是被悄悄吞掉。 */
  const plKey = s => plPlain(s).replace(/\s+/g, '');
  const said = new Set(saidKeys.map(k => plKey(t(k))));

  /* ---- 图表下方的技术说明:口径 / 样本区间 / 引擎给的 why / 期权轨元信息 ---- */
  const lines = [];
  if (dens) lines.push(t('plNote')(t(dens.basis === 'volume' ? 'plBasisVol' : 'plBasisTime'), dens.n, dens.from, dens.to, PX_HALFLIFE_D));
  else lines.push(t('plNone'));
  /* why 是引擎给的人话(含持有期兜底提示、u 无效提示、估值线降级说明),直接吐出来。 */
  for (const s of P.why) if (!said.has(plKey(s))) lines.push(s);
  /* 期权轨元信息:到期日、剩余天数、max pain、Put/Call 比 —— max pain 只作磁吸位参考,不当压力位。 */
  if (P.opt && P.opt.expiries.length) {
    lines.push(t('plOptNote')(P.opt.expiries.map(e =>
      e.expiry + '(' + e.dte + t('plDte') + (isFinite(e.maxPain) ? ' · max pain ' + fmtN(e.maxPain) : '')
      + ' · P/C ' + (e.callOI ? (e.putOI / e.callOI).toFixed(2) : '—') + ')').join(' · '),
      Math.round(PX_OPT_WINDOW * 100)));
  }
  for (const s of lines) plRich(note.appendChild(el('span', 'plnl')), s);
}
function renderCompare(co, r) {
  const sec = $('cmpSec'), box = $('cmpChart'); box.replaceChildren();
  const rows = [];
  if (r) {
    rows.push({ lb: t('cmpCoreM'), lo: r.coreLow, hi: r.coreHigh, mid: r.mid });
    if (isFinite(r.extLow)) rows.push({ lb: t('cmpExtM'), lo: r.extLow, hi: r.extHigh });
  }
  const vol = volStats(co.ticker);
  if (vol && isFinite(co.price)) {
    rows.push({ lb: t('cmpVol')(vol.n), lo: co.price * Math.exp(-vol.sigma), hi: co.price * Math.exp(vol.sigma) });
  }
  const ex = co.extra || {};
  if (isFinite(ex.w52lo) && isFinite(ex.w52hi)) rows.push({ lb: t('cmpW52'), lo: ex.w52lo, hi: ex.w52hi });
  if (isFinite(ex.target)) rows.push({ lb: t('cmpTgt') + (ex.rating ? '(' + ex.rating + ')' : ''), point: ex.target });
  if (rows.length < 2) { sec.hidden = true; return; }
  sec.hidden = false;
  const W = 1100, GL = 250, GR = 70, rowH = 38, top = 8;
  const H = top + rows.length * rowH + 26;
  const cand = [co.price];
  for (const rw of rows) { if (rw.point != null) cand.push(rw.point); else cand.push(rw.lo, rw.hi); }
  const fin = cand.filter(isFinite);
  let mn = Math.min(...fin), mx = Math.max(...fin);
  const pad = (mx - mn) * 0.07 || 1; mn -= pad; mx += pad;
  const x = v => GL + (v - mn) / (mx - mn) * (W - GL - GR);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'method comparison' });
  rows.forEach((rw, i) => {
    const yc = top + i * rowH + rowH / 2;
    const nm = svgEl('text', { x: GL - 12, y: yc + 4, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--text-secondary)' });
    nm.textContent = rw.lb;
    svg.appendChild(nm);
    if (rw.point != null) {
      svg.appendChild(svgEl('circle', { cx: x(rw.point), cy: yc, r: 5.5, fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      svg.appendChild(svgEl('text', { x: x(rw.point) + 10, y: yc + 4, 'font-size': 11.5, 'font-weight': 650, fill: 'var(--text-primary)' }, fmtN(rw.point)));
    } else {
      const bx = x(rw.lo), bw = Math.max(2, x(rw.hi) - bx);
      svg.appendChild(svgEl('rect', { x: bx, y: yc - 7, width: bw, height: 14, rx: 4, fill: 'var(--wash-strong)' }));
      svg.appendChild(svgEl('text', { x: bx - 6, y: yc + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-secondary)' }, fmtN(rw.lo)));
      svg.appendChild(svgEl('text', { x: bx + bw + 6, y: yc + 4, 'font-size': 11, fill: 'var(--text-secondary)' }, fmtN(rw.hi)));
      if (isFinite(rw.mid)) svg.appendChild(svgEl('line', { x1: x(rw.mid), x2: x(rw.mid), y1: yc - 9, y2: yc + 9, stroke: 'var(--series-1)', 'stroke-width': 2.5 }));
    }
  });
  if (isFinite(co.price)) {
    svg.appendChild(svgEl('line', { x1: x(co.price), x2: x(co.price), y1: top, y2: H - 22, stroke: 'var(--series-2)', 'stroke-width': 2 }));
    svg.appendChild(svgEl('text', { x: x(co.price), y: H - 8, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 650, fill: 'var(--text-primary)' }, t('blPrice') + fmtN(co.price)));
  }
  box.appendChild(svg);
  $('cmpNote').textContent = t('cmpNote');
}
