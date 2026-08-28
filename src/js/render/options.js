/* ================= render: options behavior timeline ================= */
function renderOptionsBehavior(co) {
  const sec = $('optBehaviorSec'), grid = $('optBehaviorGrid'), meta = $('optBehaviorMeta'), macro = $('optMacro'), note = $('optBehaviorNote');
  const data = co && optionBehavior(co.ticker);
  sec.hidden = !data; grid.replaceChildren(); meta.replaceChildren(); macro.replaceChildren(); note.textContent = '';
  if (!data) return;
  meta.className = 'optMeta';
  meta.textContent = t('optMeta')(data.snaps, data.from, data.asof, data.rows);
  for (const b of data.buckets) {
    const card = el('div', 'optHorizon ' + b.id);
    card.appendChild(el('h3', '', t('optBucket')[b.id]));
    if (!b.rows) { card.appendChild(el('p', 'empty', t('optNoBucket'))); grid.appendChild(card); continue; }
    const pc = b.callOI ? b.putOI / b.callOI : NaN;
    const facts = el('div', 'optFacts');
    facts.appendChild(el('div', '', t('optCallOI') + ' ' + fmtInt(b.callOI)));
    facts.appendChild(el('div', '', t('optPutOI') + ' ' + fmtInt(b.putOI)));
    facts.appendChild(el('div', '', 'P/C ' + (isFinite(pc) ? pc.toFixed(2) : '—')));
    card.appendChild(facts);
    const delta = el('p', 'optDelta ' + (b.totalDelta > 0 ? 'up' : b.totalDelta < 0 ? 'down' : 'flat'));
    delta.textContent = data.prev ? t('optDelta')(b.callDelta, b.putDelta, b.coverage) : t('optNoPrev');
    card.appendChild(delta);
    if (b.expiry) card.appendChild(el('p', 'optLine', t('optExpiry')(b.expiry[0], b.expiry[1])));
    if (b.topCall) card.appendChild(el('p', 'optLine', t('optTopCall')(b.topCall.strike, b.topCall.callOI)));
    if (b.topPut) card.appendChild(el('p', 'optLine', t('optTopPut')(b.topPut.strike, b.topPut.putOI)));
    grid.appendChild(card);
  }
  const peers = optionMacroPeers(co.ticker);
  const mh = el('h3', 'optMacroHead', t('optMacroHead')); macro.appendChild(mh);
  if (!peers.length) macro.appendChild(el('p', 'hint warn', t('optMacroMissing')));
  else {
    const row = el('div', 'optMacroRow');
    for (const p of peers) {
      const d = p.buckets.find(x => x.id === 'mid');
      row.appendChild(el('div', 'optMacroChip', p.ticker.split('-')[0] + ' · ' + t('optSnaps')(p.snaps)
        + ' · ' + t('optMidDelta')(d ? d.totalDelta : 0)));
    }
    macro.appendChild(row);
  }
  note.textContent = t('optNote')(data.prev, data.asof);
}
