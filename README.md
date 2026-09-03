# Price Range Dashboard · 股价区间仪表盘

**Author / 作者: Xuhao Chao** · License: MIT · Not investment advice / 不构成投资建议

A single-file, offline-friendly dashboard that turns FactSet exports into **implied stock price ranges** — multiples method (EPS forecast range × historical valuation percentiles), volatility bands, 52-week range and analyst targets, all on one shared price axis. Bilingual UI (中文 / English), light & dark themes.

单文件股价区间测算仪表盘:导入 FactSet 导出文件,用 **EPS 预测区间 × 历史估值分位** 计算隐含价格区间,并与波动率统计区间、52 周实际区间、分析师目标价同轴对比。中英双语,亮暗双主题。

## Quick start · 快速开始

- **New machine (Windows) · 新机器**: double-click **`setup.bat`** at the repo root. It finds (or offers to install) Node.js, then installs dependencies, runs the health check, verifies the build and runs the tests. It stops to ask you exactly twice — install Node with winget, and download chromium (~150MB) — and installs nothing behind your back. 双击根目录的 **`setup.bat`** 就行,只有那两处会停下来问你。
- **Just want to look at the dashboard · 只想看仪表盘**: skip `setup.bat` entirely — open `price-range-dashboard.html` (or `index.html`, same file) in Chrome/Edge. No install, no server, no Node.
- **Online**: enable GitHub Pages for this repo (Settings → Pages → Deploy from branch → `main` / root), then open `https://<your-username>.github.io/<repo-name>/`.
- **Fetching data (Windows)**: double-click **`run-factset.bat`** at the repo root.
- **Options interpretation**: open **`options-dashboard.html`**, or choose **`9`** in the `run-factset.bat` menu. Connect the repo's `Assets/` folder once; the browser remembers the folder and automatically scans `options/` plus `summary/` on later visits. After a new fetch, click **重新扫描 / Rescan**. The manual CSV picker remains as a fallback. The page separates OI facts from directional inference and explicitly marks unavailable Volume/Bid/Ask/IV/Greeks.
  The built-in Chinese field guide explains OI, Volume, ΔOI, Delta, Bid–Ask and the evidence levels; table headers also carry hover explanations.
- **Fetching data (macOS)**: double-click **`run-factset.command`** (on first use, Control-click → Open if Gatekeeper asks). It checks Node/Chrome, installs locked dependencies when needed, and uses the same local `Assets/` layout.

Click **载入演示数据 / Load demo data** to explore with sample companies, or drag in your own FactSet exports.

**`setup.bat` 挂了,或者你想知道它到底干了什么?** 看 **[docs/SETUP-NEW-MACHINE.md](docs/SETUP-NEW-MACHINE.md)** —— 那五步逐条写清楚了,附一张"症状 → 原因 → 一条命令"对照表和手动路径。 / If `setup.bat` fails, or you want the manual path, see **[docs/SETUP-NEW-MACHINE.md](docs/SETUP-NEW-MACHINE.md)**.

> **Before you read the pressure / support panel**, read [that section](#reading-the-pressure--support-panel--压力位与支撑位怎么读). It currently withholds the reach probabilities it used to print, because that number failed a calibration test that was written down before it was run. The panel saying less than you expect is the intended behaviour, and the section explains why that is worth more than a percentage would have been.
>
> **读压力位面板之前先读[那一节](#reading-the-pressure--support-panel--压力位与支撑位怎么读)。** 它现在不报触及概率的百分数 —— 那个数没通过一条**跑之前就写死的**校准判据。面板说得比你预期的少,这是设计,不是坏了。

## Working on the code · 改代码

The two HTML files at the repo root are **build artifacts — don't edit them**. The source lives in `src/`, split by feature area (valuation range / pressure tracks / direction probability / data ingest / rendering / i18n), and `tools/build.mjs` concatenates it back into the zero-dependency single file that makes "double-click to open" and GitHub Pages work. The build does no bundling or transpiling, so the artifact is byte-for-byte what the modules say it is.

```
npm run setup          # 新机器一键准备:装依赖 → 问一句装不装 chromium → 体检 → 构建校验 → 跑测试
                       #   (Windows 直接双击根目录 setup.bat 更省事,它还会替你找/装 Node)
npm run doctor         # 环境体检:node / 依赖 / 浏览器 / 数据 / 目录 / git,每条问题配一条能照抄的命令
npm run build          # 改完 src/ 后拼装产物
npm test               # 无头浏览器端到端断言(第一组就是"产物与 src/ 是否同步";条数以命令自己打印的为准,当前约 242 项)
npm run test:fetch     # fetcher 纯函数自检(路径锚点、Assets 归类、清单对齐、拉取清单与落榜清理、期权接口解析、滚存边界与回测排期;当前约 298 项)
npm run backtest       # 拿 Assets/ 的历史回放仪表盘的算法,看这几条线过去准不准
npm run backtest -- --log   # 同上,并把关键数字追加进 Assets/_logs/backtest-history.csv
npm run fetch          # 跑一轮 FactSet 抓取(Windows 也可直接双击根目录 run-factset.bat)
```

`fetcher/` is split the same way, one file per scrape step under `fetcher/steps/` — when FactSet redesigns a page, the ledger names the step that broke and the file has that name. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full map of what lives where.

## Supported input files · 支持的数据文件

| File | What it provides |
|---|---|
| `companies.csv` | price + FY1/FY2 consensus EPS low/mean/high (template downloadable in-app) |
| `history.csv` | monthly NTM PE series → valuation percentiles; optional `price` column feeds volatility |
| FactSet **company model** `.xlsx` ("Earnings Per Share" block) | FY1/FY2/FY3 EPS means; price derived from forward PE |
| FactSet **Estimate History** `.xlsx` | consensus EPS low/mean/high + monthly P/E series (last 24 months used — it tracks a fixed fiscal year) |
| FactSet **Snapshot** `.xlsx` | real closing price, 52-week range, analyst target/rating, annual PE refs |
| FactSet **Charting** `.xlsx` (Date + Close, plus **Volume** if present) | real price history → volatility band; volume enables the true volume-at-price congestion profile behind the pressure/support panel |
| FactSet **Price Summary** `.xlsx` | latest price |
| `_MARKET-BENCH/SECTOR/CREDIT/RATES <SYM> Daily Charting.xlsx` | market-level series (e.g. SPY/SOXX/HYG/IEF) → auto macro / industry / liquidity signals for the direction-probability panel |
| `<ticker> Targets Ratings.xlsx` (Targets & Ratings, History view) | monthly mean target price + rating distribution → auto sentiment signal |
| `short-interest.csv` (accumulated by the fetcher) | short interest (days to cover / % of float) → auto sentiment signal |
| `<ticker> News.csv` (StreetAccount headlines, accumulated by the fetcher; columns `date,ids,headline`) | 30-day headline keyword score → auto sentiment signal |
| `<ticker> Options.csv` (option-chain snapshots, accumulated by the fetcher; core columns `asof,expiry,strike,call_oi,put_oi`, plus optional `fetched_at`, per-leg Volume, Delta and Bid/Ask) | OI walls and an activity/liquidity evidence layer. Old five-column files remain valid. Optional-field absence is stored as blank, never zero. OI remains a position stock and does not identify dealer direction. |

Use **Connect folder** (Chrome/Edge) to scan a whole folder at once — files import oldest→newest so the latest data wins; the folder is remembered across sessions where browser storage is available.

**Where the fetcher puts things** · Everything lands under one `Assets/` folder at the repo root, sorted into sub-folders by data type, with logs kept out of the way:

```
Assets/
  estimates/   <ticker> Estimate History.xlsx
  charting/    <ticker> Daily Charting.xlsx  ·  _MARKET-* Daily Charting.xlsx
  targets/     <ticker> Targets Ratings.xlsx
  news/        <ticker> News.csv
  options/     <ticker> Options.csv
  summary/     companies.csv  ·  short-interest.csv
  misc/        anything that matches no rule
  _logs/       sources.txt(源出台账)  ·  fetch-YYYY-MM-DD.log(每天一份跑批日志)  ·  backtest-history.csv(回测台账)
```

Point **Connect folder** at `Assets/` itself — the scan recurses into sub-folders and identifies every file by its **name**, not its location, so this layout costs the dashboard nothing. Files left over from older versions (in `Assets/` root, or in the wrong `fetcher/Assets/`) are moved into place automatically the next time the fetcher starts.

**Which files accumulate, and which get overwritten.** It depends on whether the export already carries its own history. The charting / estimates / targets workbooks each contain a full series inside one file, so each round overwrites them — keeping old copies would just make `folder.js` ingest the same series twice. `News.csv` and `short-interest.csv` accumulate, because each round only ever sees what is new. As of v16.8 `Options.csv` accumulates too, keyed by `asof` — one layer per day, kept for 365 days, re-running on the same day replaces that day's layer rather than adding a second one. Before v16.8 it was overwritten, which meant every option chain older than the current round was gone and there was no way to ask whether a given open-interest wall actually held. Retained layers cost the dashboard nothing: `ingestOptions` already keys on `expiry|strike` and takes the **newest** `asof`, and the pressure panel already skips expired expiries.

The fetcher now starts Chrome in the background by default (`FS_HEADLESS=auto`). A valid saved FactSet session stays windowless; if the session has expired, the background context is closed before the same persistent profile is reopened in a visible Chrome window for login. `--login` is always visible. Use `FS_HEADLESS=0` to force a visible window or `FS_HEADLESS=1` to force background mode; forced background mode stops with login instructions instead of waiting invisibly when authentication has expired.

Interactive fetcher runs use one top-level menu both before and after every round. Type `run` to fetch and `exit` to quit; an empty Enter stays in the menu. Existing ticker, `edit`, `mkt`, `sync`, `chk`, `bt`, and `sources` commands remain available. `open` / `dashboard` opens the local dashboard on Windows, waits for your confirmation, then returns to the same menu. Non-interactive scheduled runs still perform exactly one automatic round and exit.

## Reading the pressure / support panel · 压力位与支撑位怎么读

**Read this section before you read the panel.** As of the 2026-08-06 round the panel deliberately says *less* than it used to, and the things it stopped saying are the things people most want it to say. If you skip this and go straight to the chart, you will read the silences as bugs.

### What it does not claim · 它不说什么

**It no longer prints reach probabilities.** Every level used to carry a "本期触及概率 / probability of being reached this period" percentage. Those numbers are gone, replaced by a plain distance in σ and a 未验证 / unverified badge. The reason is not that the code broke — the reason is that the number failed the calibration test that had been **written down before the test was run**. The pre-registered bar (SPEC §3.9) was three conditions AND-ed together: out-of-sample Brier skill above a horizon-dependent threshold, a cross-validated lower bound above zero, and a **10-bucket reliability diagram whose worst bucket deviates by no more than 0.10**. The measured worst-bucket deviations came in at 0.2213 / 0.2035 / 0.2648 for the 5 / 21 / 63-day horizons. All three cells failed on the third condition.

What that means concretely: the *ordering* is roughly right — out-of-sample Brier skill stayed positive throughout, so a level the model calls "far" really is harder to reach than one it calls "near". The *scale* is wrong. Buckets the model labelled 40% resolved closer to 65%. A miscalibrated probability is worse than no probability at all, because a percentage sign is an invitation to size a position off it, and nothing on the screen tells you the number is off by twenty-odd points.

**This is the feature, not the bug.** The threshold was fixed in advance and then not moved. There was a plausible-sounding argument available for moving it — `PX_REACH_U = 1.0` puts a hard floor of 0.0956 / 0.2449 / 0.3269 under `pReach`, so the bottom two or three buckets can never fill and the reliability criterion may be unreachable by construction. That argument may well be correct. It is still a motion for the *next* pre-registration round, not a reason to edit the bar after seeing the score. A threshold you are willing to move once you have seen the result is not a threshold. So the leg was downgraded first, and the argument goes in the queue.

Two further things the panel does not do, both for the same reason — they were built, tested, and rejected:

**It does not tell you whether a level will hold.** Three separate control designs were tried; the largest |z| any of them produced was 1.20 against a threshold of 2. Three proposals, three different controls, one identical answer: nothing there. The evidence badge for this leg reads 测不出 / inconclusive rather than 已证伪 / falsified, and the distinction is load-bearing: the samples were effN 17 and 16 where the pre-registration demanded 30. **Failing a test and never having taken it are different states.** The first is a finding, the second is a blank.

**It does not give a 0–100 strength score.** The old one correlated with subsequent price movement at r ≈ +0.01, and it was rendered as a progress bar — a metaphor that asserts "longer means more reliable" whether or not anything backs that up. The table now carries only raw quantities with units on them.

**Nor does the valuation line count as a support level.** Backtest group D graded it `valAnchorBias = biased`: the median deviation of the anchor from spot is negative and its directional hit rate falls below 50%, because the P/E percentiles come from the stock's own history and the past year was a re-rating market. A line your own backtest has graded systematically off-centre does not get to keep the name "support". It survives as a dashed reference tick on the chart and never enters either table.

### What it does claim · 它说什么

One measurement, stated in one unit. Every length in the engine is expressed in `1u = σd·√h·P` — daily log-return standard deviation, times the square root of the holding period in trading days, times the as-of closing price. Long / mid / short are therefore not three algorithms but three notches on one ruler: the same level is more uncertain over a quarter than over a week, so its band is wider, in the ratio √5 : √21 : √63 ≈ 1 : 2 : 3.6. Anything more than 1u away is dropped from the table entirely — beyond that it is not a level *for this period*.

**Technical track**: 730 days of history, weighted by volume where the Charting export carries a Volume column and by days-spent-at-price otherwise, decayed with a 365-day half-life, binned at 0.25u per bin (not a fixed bucket count — a fixed count shreds wide-range stocks and smears narrow ones). Density peaks expand outward until density falls to 55% of the peak; bands closer than 0.5u merge. Swing highs and lows (±8 bars) count as touches.

**Options track**: open interest, not option volume — OI is a *stock* of positioning that has to be unwound, which is what makes it a wall; volume is a *flow* that is gone by the next session. The three expiries carrying the heaviest OI inside a 60-day window are used, time-weighted `w = 1/(1+dte/30)` and reported **separately, never summed**: a wall three weeks out pins hard and then vanishes, a wall two months out is soft but lives much longer, and adding them reads two different facts as one. Strikes are limited to ±25% of the as-of price; a strike is a wall only if its OI is at least 1.5× the mean over *participating* strikes in the window and at least 500 contracts, four walls per expiry maximum. An alignment discount applies — a wall above spot must be call-heavy and one below put-heavy to score in full — because large OI pointing the wrong way is more likely somebody's hedge leg than resistance. **Max pain is annotated for reference and never enters any score.** This whole track is on forward-ledger only: there are 4–5 usable snapshot days in the archive, one of them a partial chain, and you cannot answer "did the wall hold" without a time series.

A level carrying an options leg takes **the weaker of the two evidence grades**, always. A leg that has not been validated does not become validated by standing next to one that has.

Where two tracks land on the same price the level is tagged **多轨重合 / tracks agree**. That is the interesting case, and it is reported as a fact about the inputs — the tracks share no data at all, so agreement between them means something — not as a strength number.

The note under the panel always states which basis was used. If it says 停留时间 / time-at-price, the fetcher could not turn on a Volume series; see below. If volatility cannot be estimated at all (fewer than 40 returns, or non-positive prices in the series) the panel **disappears** rather than degrading. That is deliberate: a missing panel is visible, a screen full of 99% is not.

**Getting volume**: the fetcher tries, best-effort, to enable a Volume series on the FactSet chart (toolbar toggle, then the Studies menu). The toolbar is a custom-drawn widget whose layout varies per saved account profile, so this can miss — and the fetcher judges success by the **exported file's headers**, not by whether a click appeared to land. If it misses, add a Volume series manually in FactSet Charting once and save the layout; every later round picks it up automatically. Set `FS_NO_VOLUME=1` to skip the attempt entirely.

### 中文摘要

这块面板现在**不报触及概率的百分数**。不是算不出来,是那个数没通过跑之前就写死的校准判据:
10 桶可靠性图最大偏差 0.2213 / 0.2035 / 0.2648(h = 5/21/63),门槛 ≤0.10,三个持有期全灭。
排序大致对(样本外 Brier skill 一直为正),但刻度不对 —— 标 40% 的桶实际发生了 65% 左右。
**一个刻度不对的概率比没有概率更坏**,因为百分号会被拿去定仓位,而屏幕上没有任何东西提示它偏了二十几个点。

门槛是事先定死的,看完结果没有回头改。有一个听起来很有道理的改门槛理由
(`PX_REACH_U = 1.0` 给概率压了硬下限,最低几个桶可能永远填不满,门槛也许根本够不到)——
那个论证可能是对的,但它是**下一轮预注册前**的动议,不是这一轮看完成绩再回头改承诺的理由。
看完结果就能改的门槛不是门槛。所以先降级,再论证。

同理不做的还有三件:不预测支撑位守不守得住(三套对照 max|z| = 1.06–1.20,门槛 2;
徽章写「测不出」而不是「已证伪」,因为 effN 只有 17 / 16,预注册要求 30 ——
**样本不足不给人宣告证伪的权利**);不给 0–100 强度分(与后续走势相关 r ≈ +0.01,
而它在界面上是进度条,进度条本身就在宣称"越长越可信");估值线不进上下两张表
(D 组已判 `valAnchorBias = biased`,降级成图上的虚线参考)。

面板真正说的只有一件事:**本期够不够得着**,单位是 `1u = σd·√h·P`。长中短期不是三套算法,
是同一把尺子的三个刻度,带宽比例 √5 : √21 : √63 ≈ 1 : 2 : 3.6;超过 1u 的位置本期不入表。
含期权腿的位置整条取**更弱的那一档**证据等级。σ 估不出来时面板整个收起,不降级显示 ——
消失看得见,一屏 99% 看不见。

## When a fetch breaks · 拉取失效时怎么定位

`fetcher/factset-fetch.mjs` keeps a provenance ledger at `Assets/_logs/sources.txt`: one line per expected output file, with status, the FactSet tab path, the URL, last-success and last-failure timestamps, and — for failures — **the exact sub-step it broke at** (导航 → 等待页面 → 切换 Report Type → 定位表格 → 解析行 → 写文件) plus the truncated error. Type `chk` in the fetcher menu for a health report that also cross-checks the ledger against real file timestamps, so a step that stopped updating *without* raising an error still gets flagged.

A different kind of drift, caught at startup: `tickers.txt` decides what gets **fetched**, but the dashboard renders whatever is in the **folder**. So a ticker whose files are on disk but whose symbol is missing from the list keeps showing up on screen and silently stops updating — missing data you go and investigate, stale data you just act on. Every run now reconciles the two (`fetcher/lib/reconcile.mjs`), **adds the unregistered-but-present tickers straight into `tickers.txt`**, and reports what it added and which of the five data kinds each one still lacks. The reverse case — listed but no files — is only reported, never auto-removed. Drop one with `-TICKER` in the menu and it is recorded as `# ignore: TICKER` in the same file, because deleting from the list does not delete the data and a ticker that resurrects itself on the next launch is worse than a tool that does less.

Reading the failure phase: 导航/等待页面 means the URL changed or you are logged out; 切换 Report Type means a dropdown label changed; 定位表格 means the page markup was redesigned; 解析行 means column order or the date format moved.

Alongside the ledger, each run appends its full console output to `Assets/_logs/fetch-YYYY-MM-DD.log` — the terminal scrollback always eats exactly the lines you needed, so read the file instead.

One failure mode the ledger cannot see: the **Options** tab is a top-level FactSet app (`workstation/options-montage/`) that carries no company context in its URL, so the ticker has to be typed into the page's own search box. The fetcher types it *before* reading the table, never after — reading first would happily accept the previous ticker's chain, which looks complete and plausible and is the hardest kind of wrong to notice. If the ticker somehow fails to land, the run prints a 「页面上没找到 …字样」 warning rather than silently trusting the table.

## Verification · 验证

抓取器按数据变化速度分别判断是否需要重拉：现价按 `price_date` 每日更新（同一天重跑可跳过）；新闻、期权、空头、公司/市场日线沿用原有 20 小时（日更）窗口；Estimate History 为 96 小时（4 天）；Targets & Ratings 为 144 小时（6 天）。旧代码若仍以 `isFresh(filename)` 调用，会继续使用原来的 20 小时语义。

`npm run test:fetch` runs the fetcher's pure-function assertions — currently ~298, and the command prints the exact count, which is the number to trust (date parsing, CSV quoting, news row filtering, ledger column integrity, volume-column detection, options-page URL resolution, the option-chain parser across both the `calls | strike | puts` layout and the one-row-per-type layout, the FactSet Options Montage **export** reader — sheet-name identity, cross-ticker rejection, multi-file merge under the 500-contract cap, staleness — the **option-chain API** path that supersedes both, whose fixtures are bytes copied verbatim off `/services/IDCServ/oc` and `/services/Fql` on 2026-07-30 (25-column header with its trailing pipe, real strikes, real open interest) and which pins the one trap unique to that path: an unknown ticker returns HTTP 200 with an empty body, so "request succeeded" must not become "succeeded with zero rows" — the short-interest block parser, whose assertions are written from the page's **verbatim** text rather than from the regexes they guard, the option-chain roll-over boundaries — a snapshot exactly 365 days old is kept and one at 366 is dropped, over-cap eviction removes a *whole* oldest snapshot rather than slicing rows (half a chain gives a wrong max pain, which is worse than none) and never touches today's layer — and the monthly backtest schedule, which compares year-and-month rather than "30 days since last run", plus a source-level ban on `tools/backtest.mjs` statically importing `xlsx` by bare specifier — ESM resolves bare names by walking up from the *importing file's own directory*, never from `cwd`, so a script in `tools/` cannot see the `fetcher/node_modules` that the first-run bootstrap actually populates, and the assertion exists because that exact import shipped in v16.8 and crashed on the first real machine that ran it). `npm test` drives the dashboard in headless Chromium — currently ~242 assertions, again with the run itself printing the count — covering: build freshness (the artifact must match `src/`), the fiscal-year classifier (the sheet's own `Jan '27E` label decides which fiscal year an Estimate History belongs to, the filename is only a fallback, and both load orders are pinned because the v17.1 sign-flip happened only when the FY3 file loaded *first*), the base-consistency guard (`P/E percentile head × base EPS` must land within 25% of the price, and the warning must reach the DOM rather than just the console), the valuation identities (core range endpoints equal `EPS scenario × P/E percentile`), the scenario matrix corners being the *same numbers* as the headline core range, every EPS/percentile guard firing, and the pressure/support engine (volume-vs-time basis selection and graceful degradation, band merging, swing-touch counting, expiry selection by open interest rather than by calendar proximity, the ±25% strike window, wall thresholds computed over participating strikes only, alignment scoring, a hand-computable max-pain case, three-track confluence scoring, and the short-history / missing-price / no-chain fallbacks). Three groups were added in the 2026-08-06 round and each of them exists because the thing it checks had already gone wrong once: that `PX_EVIDENCE` actually **drives** rendering (flip the constant to `pending`, re-render, and count percent signs in the live table — the old code read a hard-coded literal, so the downgrade clause in SPEC §3.9 was a law with no enforcement); that no code path in `render/pressure.js` can format a `pending` leg as a percentage **at the source-text level**, since a runtime check can only prove "it did not happen this time"; and that the treatment win rate, the random control and the confidence interval in the simulation panel share one CSS declaration for size, weight and colour, because typography that makes an un-skilled number look like a headline is a lie the assertions above would not have caught. Needs `npm install` (playwright + xlsx are declared in `package.json`) plus `npx playwright install chromium` for the browser itself — see [docs/SETUP-NEW-MACHINE.md](docs/SETUP-NEW-MACHINE.md) if either step misbehaves.

`npm run backtest` answers a different question from `npm test` — not "is the arithmetic right" but "have these lines actually held up". It loads `src/js/**` into a `node:vm` sandbox and calls `volStats` / `priceDensity` / `peStats` / `dirScores` / `newsScore` themselves, so what gets tested is the shipped code rather than a reimplementation of it. Two things there are easy to get wrong in opposite directions. Rolling windows overlap, so with a 63-day horizon two adjacent observations share 62 days of the same path; hit rates use `n` but standard errors must use `effN = n/h`, and skipping that inflates every z by about √h. The mirror-image error is just as bad: with `effN` in single digits a genuine miss (49.6% coverage where 68.3% was expected) must read "sample too thin" rather than green. Adding `--log` appends the run to `Assets/_logs/backtest-history.csv` as a long table, one row per metric with a controlled `verdict` vocabulary, so that a leg flipping from *inconclusive* to *inverted* leaves a dated trace. Nothing in that loop adjusts a weight — a year of daily bars is about 32 non-overlapping 21-day windows, and tuning parameters against 32 windows fits noise. It reads `Assets/`, which is licensed data and not in the repo, so it is deliberately kept out of `npm test`.

## Privacy & data licensing · 隐私与数据授权

All parsing and computation happen **entirely in your browser** — no data is uploaded anywhere. Nothing is sent to a server, and the delivered artifact is a single HTML file with no network calls in it.

**FactSet exports are licensed market data and must never be committed.** The ignore list at the repo root (`.gitignore`) excludes `Assets/` — where every fetched file lands — plus `*.xlsx`, `*.xls` and `*.csv` wherever they appear, `_to_delete/`, `fetcher/options-inbox/` (the option-export drop box, already covered by `*.xlsx` but named again so a slipped `git add -f` still bounces), and `fetcher/.options-url` (the locally probed Options-page address, which varies by account entitlement and version and has no business travelling with the repo). The two `*_template.csv` files at the root are the only CSVs deliberately un-ignored — they are empty column headers, not data.

Belt and braces is the point here. `Assets/` alone would be enough if every file always landed where it was supposed to; the extension rules are there for the copy someone drops on the desktop and then drags into the repo folder to test an import.

所有解析与计算完全在浏览器本地进行,数据不会上传。**FactSet 导出属于授权数据,一个字节都不许提交。**
根目录的忽略清单排除 `Assets/`、任意位置的 `*.xlsx` / `*.xls` / `*.csv`、`_to_delete/`、
`fetcher/options-inbox/`、`fetcher/.options-url`;只有两份 `*_template.csv` 是故意放行的 ——
那是空表头,不是数据。目录规则和扩展名规则重复了一层,重复是有意的:
目录规则挡的是正常落盘的文件,扩展名规则挡的是有人把导出临时拖进仓库目录试导入的那一份。

## Method notes · 方法说明

Implied price = EPS scenario × historical NTM PE percentile. Ranges combine earnings-forecast uncertainty with valuation volatility. Percentiles depend on the chosen history window — the window itself is an assumption. The volatility band is realized-vol based (`price × e^±σ`, ~68% one-year band under lognormal assumptions). **Not investment advice.**

不构成投资建议。
