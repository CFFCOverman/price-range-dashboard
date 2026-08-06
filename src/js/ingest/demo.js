/* ================= demo data ================= */
function loadDemo() {
  const cos = [
    ['DEMO-TECH', '示例科技(演示)', 'USD', 152.00, '2026-07-23', [5.10, 5.60, 6.20], [6.00, 6.70, 7.40], 24, 4.5, 0.02, 0.8],
    ['DEMO-CONS', '示例消费(演示)', 'USD', 84.00, '2026-07-23', [4.20, 4.60, 5.00], [4.80, 5.30, 5.80], 18, 2.8, 0.0, 2.1],
    ['DEMO-PHRM', '示例医药(演示)', 'USD', 46.50, '2026-07-23', [1.60, 1.90, 2.20], [1.95, 2.30, 2.70], 27, 6.0, -0.04, 4.4],
  ];
  const months = [];
  for (let y = 2020; y <= 2026; y++)
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 6) break;
      months.push(y + '-' + String(m).padStart(2, '0') + '-28');
    }
  for (const [t, name, cur, price, pd, f1, f2, base, amp, trend, ph] of cos) {
    state.companies.set(t, {
      ticker: t, name, currency: cur, price, priceDate: pd,
      eps: { fy1: { low: f1[0], mean: f1[1], high: f1[2] }, fy2: { low: f2[0], mean: f2[1], high: f2[2] } },
    });
    const series = months.map((d, i) => ({
      date: d,
      pe: +(base + trend * i + amp * Math.sin(i / 5.1 + ph) + amp * 0.55 * Math.sin(i / 2.3 + ph * 2.7)).toFixed(2),
    }));
    state.history.set(t, series);
    state.priceHist.set(t, series.map(s => ({ date: s.date, price: +(s.pe * f1[1]).toFixed(2) })));
  }
  state.selected = 'DEMO-TECH';
  renderAll(t('demoLoaded'));
}

