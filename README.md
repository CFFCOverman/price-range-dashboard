# Price Range Dashboard · 股价区间仪表盘

**Author / 作者: Xuhao Chao** · License: MIT · Not investment advice / 不构成投资建议

A single-file, offline-friendly dashboard that turns FactSet exports into **implied stock price ranges** — multiples method (EPS forecast range × historical valuation percentiles), volatility bands, 52-week range and analyst targets, all on one shared price axis. Bilingual UI (中文 / English), light & dark themes.

单文件股价区间测算仪表盘:导入 FactSet 导出文件,用 **EPS 预测区间 × 历史估值分位** 计算隐含价格区间,并与波动率统计区间、52 周实际区间、分析师目标价同轴对比。中英双语,亮暗双主题。

## Quick start · 快速开始

- **Online**: enable GitHub Pages for this repo (Settings → Pages → Deploy from branch → `main` / root), then open `https://<your-username>.github.io/<repo-name>/`.
- **Local**: just open `price-range-dashboard.html` (or `index.html`, same file) in Chrome/Edge. No install, no server.

Click **载入演示数据 / Load demo data** to explore with sample companies, or drag in your own FactSet exports.

## Supported input files · 支持的数据文件

| File | What it provides |
|---|---|
| `companies.csv` | price + FY1/FY2 consensus EPS low/mean/high (template downloadable in-app) |
| `history.csv` | monthly NTM PE series → valuation percentiles; optional `price` column feeds volatility |
| FactSet **company model** `.xlsx` ("Earnings Per Share" block) | FY1/FY2/FY3 EPS means; price derived from forward PE |
| FactSet **Estimate History** `.xlsx` | consensus EPS low/mean/high + monthly P/E series (last 24 months used — it tracks a fixed fiscal year) |
| FactSet **Snapshot** `.xlsx` | real closing price, 52-week range, analyst target/rating, annual PE refs |
| FactSet **Charting** `.xlsx` (Date + Close) | real price history → volatility band |
| FactSet **Price Summary** `.xlsx` | latest price |

Use **Connect folder** (Chrome/Edge) to scan a whole folder at once — files import oldest→newest so the latest data wins; the folder is remembered across sessions where browser storage is available.

## Privacy & data licensing · 隐私与数据授权

All parsing and computation happen **entirely in your browser** — no data is uploaded anywhere. FactSet exports are licensed market data: keep them out of public repos (this repo's `.gitignore` excludes `Assets/`, `*.xlsx` and `*.csv` by default).

所有解析与计算完全在浏览器本地进行,数据不会上传。FactSet 导出属于授权数据,请勿提交到公开仓库(`.gitignore` 已默认排除)。

## Method notes · 方法说明

Implied price = EPS scenario × historical NTM PE percentile. Ranges combine earnings-forecast uncertainty with valuation volatility. Percentiles depend on the chosen history window — the window itself is an assumption. The volatility band is realized-vol based (`price × e^±σ`, ~68% one-year band under lognormal assumptions). **Not investment advice.**

不构成投资建议。
