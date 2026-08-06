# 压力位引擎重写 —— 三份提案的裁决与最终实施规格

> 本轮我只读了代码,没有重跑任何测量。下文引用的所有数字都标了出处(卷宗 / 提案一 / 提案二 / 提案三);凡是我没能在源码里核对到的,一律写「据提案 X,本轮未复核」。源码事实(manifest 顺序、函数签名、行号、常量现值)是我这一轮在 `/home/claude/price-range-app` 里逐个文件读出来的。

---

## 一、三份提案的评分与主干选择

评分尺度 1–5。**我不是投票器**:下面有两处我明确否掉了 3:0 的一致意见(见 1.4),有一处我采纳了唯一一份少数派意见。

### 1.1 提案一(可达性概率 / 校准派)

| 维度 | 分 | 理由 |
|---|---|---|
| 证据支撑度 | **5** | 全场唯一拿出**样本外**正结果的一份:反射原理触及概率 `p=2Φ(−u)` 经 per-h 再校准后,Brier skill +0.045 / +0.257 / +0.393(h=5/21/63),且做了 leave-one-ticker-out。σ 估计窗口 60 根优于 20 根这一条在三个 h 上同向。这是整个卷宗里唯一一个「换掉一只票也不塌」的结论。 |
| 满足用户全部诉求 | **3** | 覆盖了「技术 / 长中短期逻辑」,但**期权多空博弈点几乎没碰**,买入模拟面板只给了轮廓。用户明确要的四条腿它答了两条半。 |
| 落地风险 | **4** | 数学是封闭的,`Φ` 十行、`σd` 十行,没有需要调优才能跑通的地方。风险集中在一个点:σ 的量纲。 |
| 可验收性 | **5** | Brier / skill / 可靠性图是**连续量**,不吃「一年 × 2.1 只有效独立票」这个样本诅咒。它是唯一一个在现有数据量下**能给出非平凡结论**的验收口径。 |
| 维护成本 | **5** | 三个再校准常数 `c={0.60,0.86,1.02}`,一张表,一个函数。没有隐藏状态。 |

**综合:主干。** 理由不是它分最高,是它**改变了被验收的对象**:从「这条线守不守得住」(二元、低功率、已被证伪)换成「这条线本期够不够得着」(连续、高功率、已通过样本外)。这一步换题是本轮唯一真正的进展。

### 1.2 提案二(σ 尺度几何 / 功率派)

| 维度 | 分 | 理由 |
|---|---|---|
| 证据支撑度 | **4** | 它最重要的贡献是**否定性**的,而且是自伤式的:自己提出「三套引擎(长/中/短各一套机制库)」,又自己用 18 个格子的 z 表把它打掉(max\|z\|=1.20)。同时它是第一个指出「邻域平移对照几何退化」的 —— HALF=0.35、REACH=1.0 时可用槽位 (1.0−0.35)/(2×0.35)=0.93,对照臂事件数趋近 0,于是卷宗那条 z=+1.99 的头条结论作废。**否掉一个假阳性,和证实一个真阳性,信息量等价。** |
| 满足用户全部诉求 | **2** | 它把「长中短期」处理成了一个缩放单位,这在工程上是对的,但用户要的是**可感知**的长中短期差异;提案二的答案是「差异只体现在尺子刻度上」,用户会觉得没做。这个缺口必须在渲染层补。 |
| 落地风险 | **5** | σ 尺度化只是把所有长度除以 `σd·√h·P`,是纯重参数化,不引入新机制。 |
| 可验收性 | **5** | 它给了这轮最有用的一张纸:功率算式。h=63 上,一年 × 10 票 × 相关系数 0.413(≈2.1 只有效独立票)能达到的效应天花板是 11pp,而在 α=0.05 / power=0.8 下需要 14pp。**h=63 的二元验收在结构上不可能通过**,这不是「还没通过」,是「这台机器上永远不会通过」。这一条直接决定了验收矩阵里有多少格子必须写「不适用」。 |
| 维护成本 | **4** | 参数从 5 个绝对值变成 4 个无量纲比值,少了一层「换只票就要重调」的债。 |

**综合:嫁接三块。** ①σ 尺度几何(全部长度以 `σd·√h·P` 为单位);②功率算式 → 直接变成验收矩阵里的「不适用」判据;③证据分级的**执行方式**(不是打个标签,而是让 `pending` 腿在渲染层根本不存在输出百分比的代码路径)。

### 1.3 提案三(claim 类型学 / 连续量派)

| 维度 | 分 | 理由 |
|---|---|---|
| 证据支撑度 | **3** | 12 个格子 max\|z\|=1.06,基本全灭。唯一的线索:h=5 上,价格在整五十行权价(x50)附近的**位移抑制**,z=−1.70 / −1.82 —— 不显著,而且在 x25 上没复现。这是一条**线索**,不是结论,提案三自己也这么写。 |
| 满足用户全部诉求 | **3** | 它是三份里唯一认真处理「期权多空博弈点」的:x50/x25 行权价网格、抑制而非反弹。但它同样没给买入模拟。 |
| 落地风险 | **3** | 「连续位移」的定义有自由度(用 MAE?用终点位移?用穿越深度?),定义没锁死之前,它是最容易被无意识 p-hacking 的一块。 |
| 可验收性 | **5** | 它贡献了本轮第二重要的方法论:**同样的数据,连续指标的功率显著高于二元指标**。二元的「守住/击穿」把一次触碰压成 1 bit,连续位移保留了幅度。在 effN≈2.1 只票的量级上,这个差别是「能不能得出任何结论」的差别。 |
| 维护成本 | **4** | 对照设计干净(相邻两网格点的中点),没有需要维护的拟合系数。 |

**综合:嫁接两块。** ①claim 类型学 —— 每个位置声明必须明确是 `bounce`(二元)还是 `contain`(连续),两者对照基准不同、门槛不同、功率不同,**不许混着报**;②x50 抑制线索作为期权轨在本轮唯一被允许进入回测的形态,但落地评级为 `pending`。

### 1.4 我否掉的两处一致意见

**否掉①:三份提案都保留了估值轨(`valuationLevels`)进入 up/down 列表。** 我不保留。仓库自己的 D 组回测已经给出判语 `biased`:中枢相对现价的偏离中位数为负,50% 以上的时点低于现价,方向命中率跌破 50%,原因是 P/E 分位取自该票自身历史而这一年是再评级行情。一条**已经被本仓库回测判为系统性挂偏**的线,不能因为「它是三轨之一」就继续占据「压力位」这个名分。裁决:估值线降级为图上的虚线参考刻度,`evidence='descriptive'`,**永不进入 `up`/`down` 数组,永不参与任何合并,永不产生任何百分比**。

**否掉②:三份提案都同意删掉 0–100 强度分,但都提议用另一个 0–100 的东西替代**(提案一想渲染 `pReach×100`,提案二想渲染归一化 u 距离)。我不允许任何 0–100 的合成刻度出现在这个面板上。原因很具体:卷宗测出 `strength` 与结果的相关是 r≈+0.01,而它在界面上是一根**进度条**——进度条这个视觉隐喻本身就在宣称「越长越可信」。把 `pReach` 塞进同一根进度条里,用户读到的还是「强度」,而 `pReach` 是「够得着的概率」,语义正好相反(概率越高越**容易被打穿到**)。裁决:表格里只出现**带单位的原始量**:距离(σ 单位 + 百分比)、触及概率(百分数,带 Wilson 区间)、证据等级(词,不是数)。不出现任何无量纲 0–100 分,不出现任何进度条。`.plbar/.plbarf` 五条 CSS 规则整组删除。

### 1.5 我采纳的唯一少数派意见

只有提案三坚持:**期权轨的声明形态是「抑制位移」,不是「构成障碍」**。另两份仍把 OI 墙当作 `bounce` 类障碍。采纳提案三 —— 做市商 delta 对冲的机制推论本来就是「减小位移」,不是「在某价位挡一下」。这个措辞差异决定了对照基准长什么样,不是文字游戏。

---

## 二、真正的分歧,和我据以裁决的准绳

共识我基本不看:三份提案读的是同一份卷宗,共识很可能只是同源。下面六条是真分歧。

### D1 · 主声明是二元「守位」还是连续「抑制」?

- 提案二:守位(bounce),18 格 z 表,全灭。
- 提案三:抑制(contain),12 格,一条 −1.7 的线索。
- 提案一:两者都不要,换成可达性。

**准绳:在样本量固定为「一年 × 2.1 只有效独立票」的前提下,哪个口径的最小可检测效应(MDE)小于任何合理的真实效应。** 二元口径在 h=21 的 MDE 已经接近 10pp,h=63 是 14pp(提案二功率算式);连续口径在同样 effN 下 MDE 约为 0.3σ 量级(据提案三,本轮未复核)。真实的支撑效应如果有,量级不会超过几个 pp / 零点几 σ。

**裁决:主声明 = 可达性(概率校准),次声明 = 抑制(连续)。守位(二元)保留在回测里,但它的角色是反例守门 —— 它的作用是在未来某一轮如果突然「站得住」了,提醒我们是不是又漏进了未来函数。它永远不是验收门槛。**

### D2 · 对照基准怎么选?

- 卷宗原版:邻域平移(已死)。
- 提案一/二:距离匹配的同侧同宽带。
- 提案三:相邻两网格点的中点。

**准绳:对照必须只改变被声明的那一个变量,且对照臂的事件数不能塌。** 卷宗那条 z=+1.99 之所以是假的,不是因为统计做错了,是因为对照臂在几何上装不下任何事件 —— 于是它实际比较的是「近处的带」对「远处的带」,而距离本身就是最强的混杂因子(带宽单独就能把命中率从 48% 推到 86%,卷宗实测)。

**裁决:**
- `bounce` 用**距离分层 + 同侧同宽**对照(不是随机位置,现有 `testBands` 的随机带对照也必须改掉 —— 它随机撒在整个价区里,距离完全不匹配)。
- `contain` 用**相邻网格点中点**对照。
- **并且在 harness 里硬编一道退化闸门**:对照臂事件数 < 处理臂 30% 时,z 一律输出空,verdict 输出新词 `degenerate_control`。这道闸门就是为了让「邻域平移」那种事故不可能再产出一个头条数字。

### D3 · 持有期是三套机制还是一把尺子?

提案二自己提出又自己推翻。

**准绳:每多一套 per-h 参数,搜索空间乘 3,而每个 h 上的独立证据量只有全量的 1/3。** 三套引擎的参数/证据比是单引擎的 9 倍差。

**裁决:一套引擎,持有期只作为长度单位 `u = σd·√h·P` 进入。** 但用户要看得见差异 —— 在渲染层,切换持有期必须**肉眼可见地改变带宽和入选档位**(因为 √5 : √21 : √63 ≈ 1 : 2.05 : 3.55,带宽差 3.5 倍,这本来就看得见)。面板上必须写一句话解释:「长中短期不是三套算法,是同一把尺子的三个刻度 —— 持有期越长,同一个位置的不确定性越大,带子就越宽。」

### D4 · 期权轨还留不留?

**准绳:一条完全无法回测的腿,是否有权出现在一个以回测验收为纪律的面板上。**

数据硬约束(卷宗已实测,不重新怀疑):可用期权快照日 4–5 天,其中 2026-07-29 那批还是 18–37 行的残链。这不是「样本小」,这是**没有时间序列**。

**裁决:留,但改性质。** 期权轨从「一条压力轨」降级为「一层前瞻标注」:它渲染,它写前瞻台账,但它**不出现在任何 z 检验里,不产生任何百分比,不参与合并,不影响 up/down 的排序**。它在表格里是一个词(「OI 墙 · 未验证」)和一个数(OI 本身,原始量),仅此而已。同时它的七个参数(`PX_OPT_*`)本轮**一个都不许调** —— 在 5 个数据点上调 7 个参数是纯粹的拟合噪声。

### D5 · 如果什么都没通过,发什么?

**准绳:验收标准必须在看结果之前写死;看完结果再定门槛就是自己给自己发绿灯。**

**裁决:预注册第三节的验收矩阵,然后照单执行。** 按目前已知的数字,预期发出去的东西是:一个校准过的可达性概率、一套 σ 尺度的几何、一个买入模拟面板,以及**面板上明写「本引擎不预测支撑位会不会守住 —— 这一条我们测过,测不出来」**。这句话必须在 UI 里,不是在 README 里。

### D6 · 半衰期到底该是多少?

源码注释(`technical.js:12`)写:「试过 180 天,结果把几百天的老平台整个抹掉了 —— 而老的套牢/建仓区恰恰是最硬的阻力」。tech-menu 卷宗的半衰期扫描给出:45d > 90d > 180d > 365d > 无衰减,在两个持有期上**单调**。**这两条直接冲突,而且方向相反。**

**准绳:一句没有留下测量记录的注释,对不上一次留下了记录的扫描。** 但扫描本身也要过自己的噪声底 —— 单调不等于显著。

**裁决:`PX_HALFLIFE_D` 进入本轮唯一的调参搜索,搜索集 {45, 90, 180, 365, ∞},判据是可达性模型的 LOO-CV 样本外 Brier,**不是**命中率。并且预注册一条:如果五个取值的 OOS Brier 极差 < 0.005,判定为「无效应」,取回 365 并在参数表里把这一行标成 `no_effect`,同时**把源码那句注释删掉** —— 一句被测量否定的经验之谈留在代码里,下一个人还会信。

---

## 三、最终实施规格

### 3.0 不可违背的构建约束(先读这一段,否则后面全白写)

1. `tools/build.mjs` 按 `src/manifest.json` 顺序**原样拼接**成**恰好一个** `<script>`。禁止 IIFE、禁止 `type=module`、禁止 `import`/`export`。新文件里只能有顶层 `function` 和顶层 `const`/`let`。
2. 函数声明会跨文件提升,**调用顺序自由**;顶层 `const` 按 manifest 顺序求值,**任何文件的顶层 const 初始化器若引用了别的文件的 const,它必须排在后面**。这是 manifest 顺序唯一带语义的地方。
3. `src/js/ingest/folder.js`(现 index 17)和 `src/js/app/events.js`(现末位)在**顶层直接绑定监听器并直接 `$('id')` 取 DOM**。`$()` 返回 null 时 `.addEventListener` 抛 TypeError,**该 `<script>` 从抛错处起全部停止执行**,后面所有函数定义都不会生成 —— 页面看起来是「白的」但控制台只有一行错。所以:**events.js 必须永远是 scripts 数组最后一项;新面板的所有 DOM 节点必须静态写在 `src/index.html` 里,不能靠 JS 动态创建。**
4. `tools/backtest.mjs` 用 `vm` 装载 `src/js/**` 的一个**子集**(`loadDashboard()` 里的 `need` 数组)。**`const` 声明不挂到沙箱 `globalThis` 上**,所以有一行桥接 `vm.runInContext('globalThis.state = state;', ctx)`。新增的任何顶层 `const`(参数表、`SIM_PRESETS`)如果要在 Node 侧读,**必须加进这行桥接,否则它在 Node 里是 `undefined` 且不抛错**。

### 3.1 文件清单与 manifest 精确插入位置

**删除三个文件:**
- `/home/claude/price-range-app/src/js/pressure/technical.js`(127 行)
- `/home/claude/price-range-app/src/js/pressure/options.js`(99 行)
- `/home/claude/price-range-app/src/js/pressure/confluence.js`(57 行)

**新增八个文件 + 重写一个:**

| # | 绝对路径 | 职责 | 明确不负责 | 预估行数 |
|---|---|---|---|---|
| 1 | `/home/claude/price-range-app/src/js/pressure/params.js` | 全部可调常量 + 证据分级表。**纯常量,零函数** | 不含任何计算 | ~70 |
| 2 | `/home/claude/price-range-app/src/js/pressure/scale.js` | 日波动率、持有期长度单位、正态 CDF、可达性概率、Brier | 不碰 `state` 以外的全局;不做年化;不做渲染 | ~90 |
| 3 | `/home/claude/price-range-app/src/js/pressure/grid.js` | 价格密度分箱、摆动极值、σ 尺度价位带 | 不做合并、不做排序、不算概率 | ~140 |
| 4 | `/home/claude/price-range-app/src/js/pressure/optionwalls.js` | OI 墙(`pending` 轨) | **不产生 strength、不产生任何百分比、不参与合并** | ~90 |
| 5 | `/home/claude/price-range-app/src/js/pressure/engine.js` | 组装:取 as-of 价 → 生成候选 → 合并 → 算可达性 → 分上下 | 不预测方向;不预测「守不守得住」;不把估值线放进 up/down | ~130 |
| 6 | `/home/claude/price-range-app/src/js/sim/rules.js` | 买入规则文法:谓词表、预设、受限解析器 | **不含 `eval`/`new Function`**;不执行回放 | ~130 |
| 7 | `/home/claude/price-range-app/src/js/sim/engine.js` | 浏览器内规则回放 + 同频随机对照 | 不做仓位管理、不做复利、不做多标的组合 | ~160 |
| 8 | `/home/claude/price-range-app/src/js/render/sim.js` | 模拟面板渲染 | 不绑定事件(事件在 events.js) | ~140 |
| 9 | `/home/claude/price-range-app/src/js/render/pressure.js` | **整文件重写**(现 184 行) | 不出现 0–100 分、不出现进度条 | ~170 |

**新增样式:** `/home/claude/price-range-app/src/styles/sim.css`

**`src/manifest.json` 改写后的完整 `scripts` 数组(0 起索引,照抄):**

```
 0  src/js/core/utils.js
 1  src/js/core/csv.js
 2  src/js/core/state.js
 3  src/js/core/i18n.js
 4  src/js/ingest/companies.js
 5  src/js/valuation/calc.js
 6  src/js/ingest/demo.js
 7  src/js/ingest/xlsx-model.js
 8  src/js/ingest/estimates.js
 9  src/js/ingest/snapshot.js
10  src/js/ingest/resolve.js
11  src/js/ingest/charting.js
12  src/js/ingest/targets.js
13  src/js/ingest/signals.js
14  src/js/ingest/price-summary.js
15  src/js/ingest/roster.js
16  src/js/ingest/files.js
17  src/js/ingest/folder.js          ← 位置不动(顶层监听器)
18  src/js/render/overview.js
19  src/js/render/detail.js
20  src/js/valuation/volstats.js
21  src/js/pressure/params.js        ← 新增(必须先于 22–25)
22  src/js/pressure/scale.js         ← 新增
23  src/js/pressure/grid.js          ← 新增
24  src/js/pressure/optionwalls.js   ← 新增(替 options.js)
25  src/js/pressure/engine.js        ← 新增(替 confluence.js)
26  src/js/render/pressure.js        ← 重写,路径不变
27  src/js/sim/rules.js              ← 新增(必须先于 29)
28  src/js/sim/engine.js             ← 新增
29  src/js/render/sim.js             ← 新增
30  src/js/direction/scores.js
31  src/js/render/direction.js
32  src/js/app/render-root.js
33  src/js/app/events.js             ← 必须永远最后
```

**`styles` 数组:** 在 `src/styles/pressure.css` 之后、`src/styles/charts.css` 之前插入 `src/styles/sim.css`,即变为索引 `[base, overview, detail, pressure, sim, charts]`。

**为什么 21 必须在 22–25 之前:** `params.js` 里 `PX_*` 是顶层 const,`scale.js`/`grid.js`/`engine.js` 的顶层 const(如 `const PX_U_LABELS = Object.keys(PX_HORIZONS)`)会在求值期读它。放反了得到的是 ReferenceError(TDZ),这个会响 —— 但如果实现者为了「稳」把这类派生 const 改写成函数内计算,顺序就不再报错而只是行为漂移。**规格要求:params.js 里所有 `PX_*` 一律为字面量,不许由其它 const 派生;这样它没有前置依赖,可以安全放在 21。**

**为什么 27 在 26 之后而不是更前:** `sim/rules.js` 的 `SIM_PRESETS` 里会引用 `PX_HORIZONS`,必须晚于 21;它不引用渲染层,所以 26/27 谁先都行,选 27 是为了让「压力位三件套」在 manifest 里连成一块可读的区段。

**`src/index.html` 改动(唯一一处):** 在 `#plSec` 的闭合 `</div>`(现第 148 行)之后、`#dirSec`(现第 150 行)之前,插入静态 `#simSec` 区块,内含:`#simHold`(select)、`#simPreset`(select)、`#simRule`(input)、`#simRun`(button)、`#simOut`(div)、`#simTrig`(div)、`#simNote`(p)。**全部必须是静态标签**(理由见 3.0 第 3 条)。区块标题按现有约定用 `.lz`/`.le` 成对 span 写中英静态文本。

### 3.2 导出到全局的全部函数

> 约定:所有函数为顶层声明,自动进入全局。以下签名是契约,实现不得改名或改参数顺序 —— `tests/test-app.mjs` 与 `tools/backtest.mjs` 都直接按名调用。

#### `src/js/pressure/scale.js`

```
sigmaD(ticker, refISO, win)
```
- `ticker` string;`refISO` `'YYYY-MM-DD'` 或 null(null = 用序列最后一根);`win` int,缺省 `PX_SIGMA_WIN`。
- **返回** `{ sd, n, from, to } | null`。`sd` = **日**对数收益样本标准差(不年化);`n` = 参与计算的收益个数;`from`/`to` = 实际窗口首尾日期。
- 不足 `PX_SIGMA_MIN_N` 根返回 `null`。
- **不负责:** 年化(那是 `volStats` 的事,两者不可互换,见第四节)、√t 外推、缺量降级、任何跨票比较。

```
scaleU(sd, h, price)
```
- **返回** number = `sd * Math.sqrt(h) * price`。这是本引擎唯一的长度单位,叫「1u」。
- `sd`/`h`/`price` 任一非有限或 ≤0 → 返回 `NaN`(**不返回 0**,0 会让下游的 `dist/u` 变成 Infinity 而不是 NaN,NaN 才会让比较全部为 false 从而安全地什么都不显示)。

```
normCdf(z)      → Φ(z),Abramowitz-Stegun 7.1.26,绝对误差 < 7.5e-8
reachProb(edgeAbs, sd, h, c)
```
- `edgeAbs` = 现价到目标位边缘的**绝对**价差(正数);`c` = 再校准系数,取自 `PX_REACH_C[h]`。
- **返回** `Math.min(1, 2 * normCdf(-edgeAbs / (c * sd * Math.sqrt(h))))`,范围 [0,1]。
- 语义:**在未来 h 个交易日内至少触及一次**的概率(反射原理)。
- **不负责:** 方向(它对上下对称);不是「守得住的概率」;不是「收盘价落在那里的概率」。这三个误读都会让面板意思反过来,i18n 的 tooltip 必须逐条否掉。

```
wilson(k, n, z)     → { lo, hi }  二项比例的 Wilson 区间,z 缺省 1.96
brier(ps, ys)       → number      Σ(p−y)²/n
brierSkill(ps, ys, base) → number 1 − brier(ps,ys)/brier(base 常数预测, ys)
```

#### `src/js/pressure/grid.js`

```
swingPoints(series, k)
```
- 与现实现同义:`[{price, date, kind:'high'|'low'}]`,左右各 k 根都不超过它。`k` 缺省 `PX_SWING_K`。

```
priceDensity(ticker, refISO, h)
```
- **名字必须保持不变** —— `tools/backtest.mjs:loadDashboard()` 的函数存在性断言里点名了它。
- 第三参 `h` 为新增,int(5/21/63)。**缺省值必须是 `PX_HORIZONS.mid`(=21),不许是 `undefined`** —— 见第四节的 NaN 静默路径。
- **返回** `{ bins, bands, basis, n, from, to, swings, min, max, sd, u, asOf } | null`。
  - `bins[]`:`{lo, hi, wt, share, sm, touch}`,箱宽 = `PX_BIN_U * u`(**不再是固定 48 箱**);
  - `bands[]`:`{lo, hi, peak, share, touch, last}`,半宽下限 `PX_HALF_U * u`;
  - `u` = `scaleU(sd, h, refPrice)`;`asOf` = 实际用于截断的日期。
- **as-of 纪律(必须显式,不许再靠一个 `a >= 0` 撑着):** 函数第一步调用 `asOfSlice(all, refISO)`(见下),该函数返回切片并**在切片为空或末日期 > refISO 时抛出** `Error('as-of 越界')`。现实现里整段防线只有过滤器里的 `a >= 0` 一个子句 —— 那是本仓库最薄的一处未来函数防护。
- **不负责:** 合并、排序、算概率、判上下。

```
asOfSlice(series, refISO)
```
- **返回** `series` 中 `date <= refISO` 的子数组(已排序)。`refISO` 为 null 时返回整段。
- 若返回段的最后一个日期 > `refISO`,抛错。**这个函数是整个引擎唯一被允许做时间截断的地方**,任何别处再写 `filter(d => d.date <= ...)` 一律视为规格违例。

#### `src/js/pressure/optionwalls.js`

```
optionWalls(co, refISO, h)
```
- **返回** `{ walls, expiries, window, evidence: 'pending' } | null`。
- `walls[]` = `{ strike, oi, callOI, putOI, expiry, dte, w, align, isGrid50, isGrid25 }`。
- **`strength` 字段被删除**,不得以任何名义恢复。
- `isGrid50` = `strike % 50 === 0`,`isGrid25` = `strike % 25 === 0 && !isGrid50` —— 提案三的 x50/x25 网格,回测 H 组要用。
- 现有 `maxPain(rows)` 保留不变,仍只作磁吸位参考。
- 「今天到期的链剔除」用 `r.expiry <= today`(现实现已正确,保留,并在测试里钉死)。

#### `src/js/pressure/engine.js`

```
asOfPrice(ticker, refISO, fallback)
```
- **返回** number。`refISO` 为 null → `fallback`(即 `co.price`);否则 = `asOfSlice(state.priceHist.get(ticker), refISO)` 最后一根的 `price`。
- **这个函数存在的唯一理由是修一个已知的未来函数:** 现 `pressureLevels` 用 `co.price` 切分 up/down,历史回放时 `co.price` 是**今天**的价,于是 `price > up[0].hi` 这类突破规则在回放里永远不可能触发。

```
pressureLevels(co, r, refISO, horizon)
```
- **名字必须保持不变**(测试与回测都直接调)。
- `co` 公司对象;`r` = `calcRange()` 结果(**只用于生成估值参考线,不进 up/down**);`refISO` as-of 日;`horizon` ∈ `'short'|'mid'|'long'`,缺省 `'mid'`。
- **返回:**
```js
{
  horizon, h, sd, u, price, asOf,
  up:   [Level],        // 现价之上,由近及远,最多 PX_KEEP
  down: [Level],        // 现价之下,由近及远,最多 PX_KEEP
  inBand: Level | null,
  dens, opt,
  valRefs: [{price, pct, label, x}],   // 只给图用,绝不进 up/down
  evidence: { reach:'verified', contain:'pending', bounce:'falsified',
              opt:'pending', val:'descriptive' },
  why: [string]         // 人话解释,渲染层直接吐给用户
}
```
```js
Level = {
  lo, hi, mid,
  distU,        // (mid - price) / u,带符号
  distPct,      // (mid/price - 1) * 100
  edgeU,        // 到最近边缘的距离 / u(非负)—— 概率用这个,不用 mid
  pReach,       // reachProb(edgeU*u, sd, h, PX_REACH_C[h])
  tracks,       // ['tech'] | ['opt'] | ['tech','opt']
  src: { tech, opts },
  evidence      // 'verified'(纯 tech)| 'pending'(含 opt)
}
```
- **不负责:** ①给出任何 0–100 强度;②预测方向;③预测「守不守得住」(`why` 里必须有一句明说这件事测不出来);④把估值线放进 up/down;⑤跨公司可比。

```
valuationRefs(co, r)
```
- 取代旧 `valuationLevels`。返回 `[{price, pct, label, x}]`,五条 P/E 分位线。**调用方只有渲染层。**

#### `src/js/sim/rules.js`

```
const SIM_PREDICATES = { <id>: { labelKey, argSpec, fn(ctx) → boolean } }
```
- `ctx` = `{ ticker, i, px, price, prev, sd, u, P, ref }`,其中 `P` 是**当天**的 `pressureLevels` 结果(as-of 已截断),`ref` 是 as-of 日。
- 初始谓词集(6 个,不多不少):
  - `nearSupport` — `P.down[0] && P.down[0].edgeU <= arg`(arg 默认 0.5)
  - `nearResistance` — 同上,对 `P.up[0]`
  - `breakResistance` — `price > P.up[0].hi && prev <= P.up[0].hi`
  - `pullbackPct` — `price / max(近 arg 日) - 1 <= -arg2`
  - `maCross` — 短期均线上穿长期均线(arg = [20, 60])
  - `reachBelow` — `P.up[0].pReach <= arg`(「上方最近压力本期够不着」)
- **`fn` 必须是纯函数,只读 `ctx`。** 任何谓词若读了 `ctx.px` 里 index > `ctx.i` 的元素,视为未来函数。

```
const SIM_PRESETS = [ { id, labelKey, hold, all:[{p, args}], exitKey } ]
```
- 五个预设:`supportBuy`(靠近支撑买)、`breakoutBuy`(突破压力买)、`dipBuy`(回撤买)、`trendBuy`(均线金叉)、`roomBuy`(上方压力够不着才买)。

```
parseRule(text) → { ok, rule, error }
ruleToText(rule) → string
```
- **受限文法**,形如 `nearSupport(0.5) and reachBelow(0.4)`。词法只认谓词名、数字、`and`、括号。**禁止 `eval` / `new Function` / 正则驱动的动态派发。** 解析失败返回 `{ok:false, error:<i18n key>}`,渲染层显示为一行红字,不抛异常。

#### `src/js/sim/engine.js`

```
simRun(ticker, rule, hold, opts)
```
- `hold` = 交易日数(5/21/63);`opts = { costBps = SIM_COST_BPS, warm = 120, seed }`。
- 逐根回放:每根调 `pressureLevels(co, r, px[i].date, horizon)`(**as-of 截断由 engine 自己做,sim 不许自行切片**),规则命中则以**次根开盘/收盘**入场(用收盘,数据只有收盘),持有 `hold` 根后平仓。**同一时刻不重复开仓**(已有持仓时跳过)。
- **返回:**
```js
{
  n, win, winPct, avgRet, medRet, maxDD, avgMAE, avgMFE,
  effN,                    // 贪心不重叠去重后的独立事件数
  trades: [{ entryDate, exitDate, entryPx, exitPx, retPct, maePct, mfePct, bars }],
  ctrl: { n, winPct, avgRet },   // 同频随机入场对照
  z,                       // 两比例 z(合并 p),分母用 min(n, effN) 与 min(ctrl.n, ctrl.effN)
  warn: [string]           // 'thin' | 'overlap' | 'noTrigger' | 'shortHistory'
}
```
- `maxDD` 定义写死:**逐笔收益序列的累计权益曲线的最大回撤**(不是单笔最大亏损)。这个定义必须在 i18n tooltip 里写出来。
- **不负责:** 仓位管理、复利(收益按简单算术平均)、滑点以外的成本建模、多标的组合、做空。

```
simControl(ticker, hold, nEvents, seed) → 同结构的对照结果
```
- 对照 = 在同一段历史里**随机挑 `nEvents` 个入场日**,持有期相同。种子由 `ticker + rule 文本` 哈希得到,**同样输入必须每次跑出同一个数**。

#### `src/js/render/pressure.js` / `src/js/render/sim.js`

```
renderPressure(co, r)     // 签名不变,detail.js:34 与 detail.js:72 已在调它
renderSim(co)             // 新增;由 renderDetail() 与 partialRefresh() 各追加一行调用
```

### 3.3 参数表(全部在 `src/js/pressure/params.js`)

| 常量 | 初值 | 搜索范围 | 一句话理由 |
|---|---|---|---|
| `PX_SIGMA_WIN` | `60` | {20,40,60,120} | 提案一实测 60 根在 h=5/21/63 三个 Brier 上都胜 20 根;短窗口把一次财报跳空当成常态波动。 |
| `PX_SIGMA_MIN_N` | `40` | 不调 | 沿用现 `priceDensity` 的 40 根下限,少于此不出结论比出一个错结论好。 |
| `PX_HORIZONS` | `{short:5, mid:21, long:63}` | 不调 | 一周 / 一月 / 一季,对应用户口中的短中长;这是口径,不是参数。 |
| `PX_REACH_C` | `{5:0.60, 21:0.86, 63:1.02}` | 各 ±0.15,步长 0.05 | 提案一按 h 分别拟合的再校准系数;裸反射原理在短周期系统性高估触及率(日收益尖峰厚尾)。判据 = OOS Brier,不是命中率。 |
| `PX_HALF_U` | `0.35` | {0.20,0.28,0.35,0.45,0.60} | 价位带半宽,单位 1u。**这是全表最危险的参数** —— 卷宗实测带宽单独就能把命中率从 48% 推到 86%,所以它只许按「带宽 × 触及率」的联合曲线定,严禁按命中率单调调优。 |
| `PX_REACH_U` | `1.00` | {0.75,1.0,1.5} | 视野闸门:距离超过 1u 的位置本期不入表。1u = 本期一个标准差,再远就不是「本期的位置」了。 |
| `PX_MERGE_U` | `0.50` | {0.3,0.5,0.8} | 两个点位相距 <0.5u 视为同一位置。取代旧 `PL_MERGE_PCT=0.015`(固定 1.5% 对高波动票太严、对低波动票太松)。 |
| `PX_BIN_U` | `0.25` | 不调(由 `PX_HALF_U` 派生约束:`PX_BIN_U ≤ PX_HALF_U/1.4`) | 分箱宽度,单位 1u。取代旧 `PL_BINS=48`(固定箱数会让一年区间大的票被切碎)。 |
| `PX_LOOKBACK_D` | `730` | 不调 | 沿用旧值,未被任何测量否定;更长的历史对当下没有约束力。 |
| `PX_HALFLIFE_D` | `365` | **{45,90,180,365,Infinity}** | **本轮唯一需要裁决的历史遗留参数**(见 D6)。源码注释与卷宗扫描直接冲突。判据 = LOO-CV 的 OOS Brier;极差 < 0.005 判 `no_effect` 并回到 365。 |
| `PX_SWING_K` | `8` | {5,8,13} | 摆动极值左右各 k 根。沿用旧值,搜索范围只是为了确认它不敏感。 |
| `PX_PEAK_X` | `1.15` | 不调 | 峰值判据:平滑密度 > 均值 ×1.15。沿用。 |
| `PX_BAND_CUT` | `0.55` | 不调 | 从峰值向外扩张到密度降至峰值 55%。沿用。这两个是形状参数,不是效应参数,本轮不动。 |
| `PX_KEEP` | `3` | 不调 | 上下各留 3 档 —— UI 容量决定的,不是统计决定的。 |
| `PX_OPT_EXPIRIES` | `3` | **不调** | 以下七个期权参数全部沿用现值。理由是硬的:可回测快照只有 4–5 天,在 5 个点上调 7 个参数就是纯拟合。 |
| `PX_OPT_MAX_DTE` | `60` | 不调 | 同上 |
| `PX_OPT_DTE_HALF` | `30` | 不调 | 同上 |
| `PX_OPT_WINDOW` | `0.25` | 不调 | 同上 |
| `PX_OPT_WALL_X` | `1.5` | 不调 | 同上 |
| `PX_OPT_KEEP` | `4` | 不调 | 同上 |
| `PX_OPT_MIN_OI` | `500` | 不调 | 同上 |
| `SIM_COST_BPS` | `10` | 不调 | 单边 10bp 往返成本。取整数是为了让用户一眼知道这是个假设不是测量。 |
| `SIM_MIN_TRIG` | `8` | 不调 | 触发次数 < 8 时面板拒绝显示胜率,只列触发时点。 |
| `SIM_WARM` | `120` | 不调 | 与 `testBands` 现有 `warm=120` 对齐,免得浏览器内和 Node 内两套热身长度。 |
| `PX_EVIDENCE` | `{reach:'verified', contain:'pending', bounce:'falsified', opt:'pending', val:'descriptive'}` | 由回测结果更新 | 这张表是渲染层的开关:见 3.7 的强制约束。 |

### 3.4 `tools/backtest.mjs` 的改动

**(a) `loadDashboard()` 的 `need` 数组** —— 把 `'src/js/pressure/technical.js'` 一行替换为五行:
```
'src/js/pressure/params.js', 'src/js/pressure/scale.js', 'src/js/pressure/grid.js',
'src/js/pressure/optionwalls.js', 'src/js/pressure/engine.js',
```
并追加 `'src/js/sim/rules.js', 'src/js/sim/engine.js'`(I 组要用)。

**(b) 桥接行**必须扩成:
```js
vm.runInContext(`globalThis.state = state;
  globalThis.PX = { PX_SIGMA_WIN, PX_REACH_C, PX_HALF_U, PX_REACH_U, PX_MERGE_U,
                    PX_BIN_U, PX_LOOKBACK_D, PX_HALFLIFE_D, PX_SWING_K, PX_HORIZONS, PX_EVIDENCE };
  globalThis.SIM_PRESETS = SIM_PRESETS;`, ctx, { filename: '<bridge>' });
```
**(c) 函数存在性断言**数组追加 `'sigmaD', 'reachProb', 'pressureLevels', 'simRun'`,并新增一条:
```js
if (!ctx.PX || !ctx.PX.PX_REACH_C) throw new Error('装进来了但桥接没带出 PX —— 新增常量忘了加进 bridge');
```
这一条不是洁癖:见第四节。

**(d) 测试组**

| 组 | 状态 | 处理组 | 对照基准 | 通过门槛 | 输出行(long-form) |
|---|---|---|---|---|---|
| **A** 波动率覆盖 | 不动 | — | — | — | 不变 |
| **B** 技术带守位 | **改** | 真实带的 hold/break | **距离匹配的同侧同宽带**(现实现是「同一价区随机撒」,距离不匹配 → 改掉) | 两比例 z ≥ 2 且 effN ≥ 30。**已知 max\|z\|=1.20(提案二),预期不过,过不了就照实记 `inverted`/`inconclusive`** | `B,bandHoldRate,{h},...` |
| **B2** 对照退化闸门 | **新** | — | — | 对照臂事件数 < 处理臂 30% → verdict = `degenerate_control`,z 留空 | `B,controlCoverage,{h},...` |
| **C/D/E/F** | 不动 | — | — | — | 不变 |
| **G** 可达性校准 | **新** | `reachProb(edge, sd, h, c)` 对「h 日内是否触及」 | 气候基准(全样本触及率常数预测) | **OOS Brier skill:h=5 > 0;h=21 > +0.15;h=63 > +0.25;且 LOO-CV 的 10 折下界 > 0** | `G,brierSkill,{h},n,effN,skill,0,,{calibrated\|miscalibrated}` + `G,reliabilityMaxDev,{h},...`(10 桶可靠性图的最大偏离,> 0.10 判 `miscalibrated`) |
| **H** 位移抑制 | **新** | 到真实网格点的**标准化位移** \|Δ\|/u 与 MAE/u | **相邻两网格点的中点**(同距离、同宽度) | 配对差的 cluster bootstrap(按 ticker 重采样,2000 次)95% CI **上界 < 0**,且点估计 z ≤ −2。h=5 与 h=21 各判一次 | `H,containDisp,{h},n,effN,meanDiff,0,z,{holds\|inconclusive}` |
| **H2** x50 / x25 分层 | **新** | 同 H,但按 `isGrid50` / `isGrid25` 分层 | 同 H | 不设门槛,**只记不判**(verdict = `recorded`)。理由:提案三的 z=−1.70/−1.82 在 x25 上没复现,这是一条待复制的线索,不是待验收的结论 | `H,containDispX50,{h},...` |
| **I** 买入规则模拟 | **新** | 每条 `SIM_PRESETS` 全样本回放 | **同频随机入场**(同标的、同持有期、同触发次数、固定种子) | 胜率两比例 z ≥ 2 **且** effN ≥ 30 **且** 去掉贡献最大的一只票后 z 仍 ≥ 1.5 | `I,{presetId},{hold},n,effN,winPct,ctrlWinPct,z,{holds\|inconclusive}` |

**(e) verdict 词表**新增四个词(现有注释明确写「加词可以,改词不行」):`degenerate_control`、`calibrated`、`miscalibrated`、`pending_no_history`。CSV 表头与列顺序**一个字不改**:`run_date,group,metric,horizon,n,effN,value,baseline,z,verdict`。

**(f) 终端输出格式**照现有风格:每组一个 `H('X · 标题')` 加粗标题,一行灰字说明「这一组在测什么、为什么这个对照」,表头用 `pad`/`lpad` 对齐,末列是 `verdict()` 三色判语。**G 组额外打印 10 桶可靠性表**(预测概率区间 / 实际触及率 / 样本数),因为校准出问题时只看一个 skill 数看不出是哪一头偏。

**(g) 期权轨那两行灰字提示必须更新** —— 现在写的是「攒够半年就能测」,要改成写明「已攒 4–5 个快照日,其中一日为残链;H 组测的是价格网格,不是 OI 历史」。

### 3.5 买入模拟面板

**数据结构**(不进 `state`,挂在模块级 `let simLast = null`,因为它是纯派生物,重算比缓存便宜):
```js
simLast = { ticker, ruleText, rule, hold, result /* simRun 的返回 */, at /* Date.now() */ }
```
`state` 里只加一个字段:`state.simPref = { hold: 'mid', presetId: 'supportBuy', custom: '' }`(记住用户的选择,跨公司切换保留)。

**UI**(静态写在 `src/index.html` 的 `#simSec` 内):
1. 持有期三选一 `<select id="simHold">`:短(5 日)/ 中(21 日)/ 长(63 日)。
2. 规则预设 `<select id="simPreset">`:五个预设 + 「自定义」。
3. 自定义输入 `<input id="simRule">`:选到「自定义」才 enable;下方灰字给出文法示例和可用谓词清单。
4. `<button id="simRun">` 立即模拟。
5. `#simOut`:六个 KPI 格 —— 触发次数 / 胜率(带 Wilson 区间)/ 平均收益 / 中位收益 / 最大回撤 / 平均最大不利偏移。**胜率旁边必须并排显示随机对照的胜率和 z**,不是藏在 tooltip 里。
6. `#simTrig`:全部触发时点的表 —— 入场日、入场价、出场日、出场价、收益%、期间最大不利偏移%。用户要的是「每一次触发的时间点」,所以**这张表不分页、不折叠、不截断**。
7. `#simNote`:三句话 —— 成本假设、`maxDD` 的定义、以及「触发次数 < 8 时本面板不显示胜率」。

**事件绑定**全部写在 `src/js/app/events.js` 末尾(该文件必须留在 manifest 最后):
```js
$('simHold').addEventListener('change', ...)      // 改 state.simPref.hold,不自动跑
$('simPreset').addEventListener('change', ...)    // 切换 custom 输入的 disabled
$('simRule').addEventListener('input', ...)       // 只做 parseRule 的即时校验,不跑
$('simRun').addEventListener('click', ...)        // 唯一触发计算的入口
```
**规则:输入不自动触发回放。** 一次 `simRun` 要跑 ~250 根 × 每根一次 `pressureLevels`,同步阻塞在几百毫秒量级,挂在 `input` 上会卡死输入框(现有 `bindEps` 之所以用 `partialRefresh` 就是踩过这个)。

**i18n 词条(中英必须成对,`[6]` 节的「中英词表键完全对齐」断言会强制这一点):**

| key | zh | en |
|---|---|---|
| `simTitle` | 买入逻辑模拟 | Buy-rule simulation |
| `simHold` | 持有期 | Holding period |
| `simHoldOpt` | `{short:'短线(5 个交易日)', mid:'中线(21 个交易日)', long:'长线(63 个交易日)'}` | `{short:'Short (5 sessions)', mid:'Mid (21 sessions)', long:'Long (63 sessions)'}` |
| `simPreset` | 买入规则 | Buy rule |
| `simCustom` | 自定义 | Custom |
| `simRuleHint` | 可用条件:`nearSupport(0.5)` 靠近下方支撑 · `nearResistance(0.5)` 靠近上方压力 · `breakResistance()` 向上突破最近压力 · `pullbackPct(20,0.08)` 20 日内回撤 8% · `maCross(20,60)` 均线金叉 · `reachBelow(0.4)` 上方压力本期够不着。用 and 连接。 | Available conditions: `nearSupport(0.5)` near support below · `nearResistance(0.5)` near resistance above · `breakResistance()` breaks the nearest resistance · `pullbackPct(20,0.08)` 8% drawdown within 20 sessions · `maCross(20,60)` golden cross · `reachBelow(0.4)` resistance above is out of reach this period. Join with `and`. |
| `simRuleErr` | `p => '看不懂这一段:' + p + ' —— 只认上面列出的条件名和 and'` | `p => "Can't parse: " + p + ' — only the condition names listed above and `and` are accepted'` |
| `simRun` | 立即模拟 | Run simulation |
| `simTrig` | 触发次数 | Triggers |
| `simWin` | 胜率 | Win rate |
| `simAvgRet` | 平均收益 | Mean return |
| `simMedRet` | 中位收益 | Median return |
| `simMaxDD` | 最大回撤 | Max drawdown |
| `simMAE` | 平均最大不利偏移 | Mean adverse excursion |
| `simCtrl` | `(w, z) => '随机入场对照 ' + w + '%(z=' + z + ')'` | `(w, z) => 'Random-entry control ' + w + '% (z=' + z + ')'` |
| `simMaxDDTip` | 最大回撤 = 把每一笔按时间顺序接成一条权益曲线后的最大回撤,不是单笔最大亏损 | Max drawdown of the equity curve formed by chaining trades in time order — not the worst single trade |
| `simThin` | `n => '只触发了 ' + n + ' 次,少于 8 次 —— 胜率不显示,下面只列触发时点。样本这么少时,胜率是噪声,不是结论。'` | `n => 'Only ' + n + ' triggers (fewer than 8) — win rate withheld. Below are the trigger points. At this sample size a win rate is noise, not a finding.'` |
| `simNoTrig` | 这条规则在这段历史里一次都没触发 —— 先把条件放宽,或者换一只票 | This rule never triggered over the available history — loosen the condition or pick another ticker |
| `simCost` | `bps => '已扣单边 ' + bps + 'bp 往返成本(假设值,不是实测滑点)'` | `bps => 'Includes ' + bps + 'bp round-trip cost (an assumption, not measured slippage)'` |
| `simHead` | `['入场日','入场价','出场日','出场价','收益%','期间最不利%']` | `['Entry','Entry px','Exit','Exit px','Return %','Worst %']` |
| `simDisclaim` | 这里模拟的是「按这条规则在过去一年会怎样」。一年 × 10 只票在统计上非常薄,而且这一年是单边上行行情 —— 任何「一直买就一直赚」的结果,先怀疑是行情不是规则,所以旁边永远并排放着随机入场的对照。 | This replays "what this rule would have done over the past year." One year × 10 tickers is statistically thin, and that year was a one-way bull market — treat any "always buy, always win" result as the market, not the rule. That is why a random-entry control sits next to every number. |

**压力位面板新增/改写的 i18n(旧的 `plStr`、`plMultiTip`、`plKind.multi` 全部删除):**

| key | zh | en |
|---|---|---|
| `plHorizon` | 持有期 | Horizon |
| `plHorizonNote` | 长中短期不是三套算法,是同一把尺子的三个刻度:持有期越长,同一个位置的不确定性越大,带子就越宽(√5 : √21 : √63 ≈ 1 : 2 : 3.6)。 | Long/mid/short are not three algorithms but three notches on one ruler: the longer the horizon, the wider the band around the same level (√5 : √21 : √63 ≈ 1 : 2 : 3.6). |
| `plDistU` | 距离(σ) | Distance (σ) |
| `plReach` | 本期触及概率 | Touch probability |
| `plReachTip` | 未来 N 个交易日内**至少触及一次**的概率。它不是「守得住的概率」,也不是「收盘会落在那里的概率」;它对上下对称,不含任何方向判断。 | Probability of touching this level **at least once** within the next N sessions. It is not the probability that the level holds, nor that price closes there; it is symmetric and carries no directional view. |
| `plNoStrength` | 这张表不再给「强度分」。旧版那个 0–100 分与后续走势的相关系数是 +0.01 —— 它看上去像信息,实际上不是,所以整列删掉了。 | This table no longer shows a "strength" score. The old 0–100 score correlated +0.01 with what happened next — it looked like information and wasn't, so the column is gone. |
| `plBounceNote` | **我们不预测支撑位会不会守住。** 用距离匹配的对照测过,在这份数据上测不出任何优于对照的守位能力(最大 z ≈ 1.2,门槛 2)。这一栏的位置只回答「够不够得着」,不回答「挡不挡得住」。 | **We do not predict whether a level will hold.** Tested against distance-matched controls, no track beat control on any horizon (max z ≈ 1.2 against a threshold of 2). This table answers "can price reach it," not "will it stop there." |
| `plEvidence` | `{verified:'已验证', pending:'未验证', descriptive:'仅描述', falsified:'已证伪'}` | `{verified:'Verified', pending:'Unverified', descriptive:'Descriptive', falsified:'Falsified'}` |
| `plEvidenceTip` | `{verified:'该口径通过了样本外校准检验(见 tools/backtest.mjs G 组)', pending:'历史不足以检验,只记录不下结论', descriptive:'只是把已知的数画出来,不含任何预测主张', falsified:'检验过,没通过 —— 面板保留它是为了不让同一个错误再被重新发明'}` | `{verified:'Passed out-of-sample calibration (see group G in tools/backtest.mjs)', pending:'Not enough history to test — recorded, not concluded', descriptive:'Just plotting known numbers; makes no predictive claim', falsified:'Tested and failed — kept visible so the same idea does not get reinvented'}` |
| `plValRef` | 估值参考线(不是压力位) | Valuation reference (not a level) |
| `plValRefTip` | P/E 分位反推的价位。本仓库自己的回测已判定它系统性偏低(D 组 `valAnchorBias`:中位偏离为负,方向命中率低于 50%),所以它只画在图上作参照,不进压力/支撑表。 | Prices implied by P/E percentiles. This repo's own backtest flagged them as systematically low (group D `valAnchorBias`: negative median deviation, directional hit rate under 50%), so they are drawn as reference only and never enter the level tables. |
| `plOptPending` | `n => 'OI 墙 ' + n + ' 面 · 未验证'` | `n => n + ' OI wall(s) · unverified'` |
| `plOptPendingTip` | 可回测的期权快照只有 4–5 天(其中一天是残链),没有时间序列就没法检验「这堵墙顶住没有」。这一轨只标注,不参与任何统计。 | Only 4–5 usable option snapshots exist (one of them a partial chain). Without a time series there is no way to test whether a wall held. This track annotates only; it enters no statistics. |

### 3.6 前瞻台账

**为什么必须单独一个工具:** 台账是**只追加**的证据,回测是**反复重跑**的调参台。同一个进程里既能写台账又能调参,迟早有人跑一次调参就往台账里写进一批用调完的参数事后生成的「预测」。所以:

**新增 `/home/claude/price-range-app/tools/ledger.mjs`**,`package.json` 加两个 script:`"ledger:write": "node tools/ledger.mjs --write"`、`"ledger:resolve": "node tools/ledger.mjs --resolve"`。**`tools/backtest.mjs` 一行台账代码都不许有。**

**文件一:`Assets/_logs/forward-ledger.csv`(预测,只追加)**
```
pred_id,written_at,engine_ver,ticker,asof,horizon_d,claim,resolve_after,
level_lo,level_hi,level_mid,dist_u,edge_u,p_reach,tracks,evidence,
sigma_d,price_asof,ctrl_of,features_sha,seal
```
- `pred_id` = `sha256(engine_ver|ticker|asof|horizon_d|claim|level_lo|level_hi)` 前 16 位。**内容哈希** —— 同一天同一引擎版本重跑得到同一个 id,重复写入被拒绝。这就是「不回填」的执行机制。
- `engine_ver` = `sha256(params.js + scale.js + grid.js + optionwalls.js + engine.js 的拼接)` 前 8 位。**参数一动,分区就换**,老预测和新预测永远不会被混在一起统计。
- `claim` ∈ `reach` | `contain` | `bounce` | `opt_wall`。
- `resolve_after` = `asof` 往后数 `horizon_d` 个交易日的日期。**在这一天之前不许结算**。
- `ctrl_of` = 若本行是配对随机对照,填被配对的真实行 `pred_id`;否则空。对照的随机种子 = 真实行的 `pred_id`,所以对照**不可能被挑选**。
- `features_sha` = 写入时刻全部输入特征 JSON 的哈希 —— 特征在写入时冻结,结算时若重算出的特征哈希对不上,该行标 `tainted` 而不是悄悄用新特征。
- `seal` = 本行前面所有字段 + 上一行 `seal` 的 sha256 前 12 位(哈希链)。中间删一行,后面全部对不上。

**文件二:`Assets/_logs/forward-outcomes.csv`(结果,只追加)**
```
pred_id,resolved_at,px_asof,px_resolve,touched,touch_date,side_from,
outcome,displacement_u,mae_u,note,seal
```
- `outcome` ∈ `hit` | `miss` | `unresolved` | `tainted` | `stopped`。
- **停表规则:** 若 `asof` 与 `resolve_after` 之间该票发生拆股/并股/停牌 > 3 日,记 `stopped` 并**永久排除**,不许「顺延」——顺延等于按结果挑窗口。

**谁写:** `ledger:write` 由 fetcher 每轮拉数之后调一次,对 roster 里每只票 × 三个持有期各写一行真实 + 一行配对对照。`ledger:resolve` 每次跑时扫描所有 `resolve_after <= today` 且尚无 outcome 行的预测,逐条结算。

**怎么回填:不回填。** 明确写进 `tools/ledger.mjs` 的文件头注释:「本文件里没有回填函数,以后也不要加。用今天的代码给昨天写预测,写出来的不是证据,是拟合。台账从第一次运行那天开始有意义,在此之前的空白就让它空着。」唯一允许的历史读法是**淘汰赛式**:同一个 `engine_ver` 分区内累积到 30 个独立事件才第一次出判语,判语一旦是「反了」,该 `claim` 在面板上立刻降级为 `falsified`。

### 3.7 测试清单

风格照 `tests/test-app.mjs`:断言名是**一句中文的话,说明这条断言在防什么事故**。

**`[7]` 整节重写 —— 压力位几何与 as-of(现 201–357 行)**

| 断言名 | 防的事故 | 为什么不能省 |
|---|---|---|
| `σ 是日波动率不是年化 —— sigmaD 与 volStats 相差约 √252 倍` | 把 `volStats().sigma`(年化)误传进 `reachProb` | 两者都是有限正数,不会抛错,只会让所有概率静默塌到 0。这是本轮最像「财年翻车」的一处 |
| `持有期从短换到长,带宽必须按 √h 变宽(5→63 应约 3.5 倍)` | 持有期参数被接住但没真的进几何 | 「切了没反应」是用户最容易发现、最难在代码里看出来的失败 |
| `horizon 传 undefined 时退回 mid,不产生 NaN 带宽` | `√undefined = NaN` → 所有比较为 false → 面板自动隐藏 | 隐藏的面板看起来像「这只票没数据」,不像 bug |
| `refISO 指定为一年前时,面板用的是一年前的价,不是 co.price` | 现版本的 as-of 泄漏(`co.price` 切 up/down) | 这个泄漏让所有基于突破的回放规则永远无法触发,回测会安静地少掉整类事件 |
| `asOfSlice 收到末日期晚于 refISO 的序列时抛错,不静默通过` | 把「防线」写成一个过滤子句,某次重构顺手删掉 | 现版本整段 as-of 防护就是 `a >= 0` 一个子句 |
| `上下各自最多 PX_KEEP 档,且 up 全在现价上方、down 全在下方` | 排序/切片写反 | 沿用旧断言,零成本 |
| `现价落在密集带内时 inBand 命中,且该带不重复出现在 up/down` | 同一条带被数两次 | 沿用旧断言 |
| `触及概率单调:同一持有期下 edge 越大 pReach 越小` | `reachProb` 里符号写反 | 符号反了以后所有数仍在 [0,1] 内,看不出来 |
| `触及概率单调:同一 edge 下持有期越长 pReach 越大` | `√h` 写成 `/√h` | 同上 |
| `pReach 恒在 [0,1] 且 edge=0 时为 1` | `2Φ(−0)=1` 的边界 | 没有 `min(1,·)` 时长尾会溢出到 >1 |
| `表格里不出现任何 0–100 的强度数字,也不渲染 .plbar` | 强度分被「顺手」恢复 | 这是本轮的核心决定,只靠 code review 守不住 |
| `估值参考线画在图上,但一条都不在 up/down 里` | 估值线偷偷回到压力位表 | 同上 |
| `evidence 为 pending 的位置,DOM 里不含任何 % 号` | 未验证的腿印出百分比 | 提案二的执行方式:不是打标签,是让代码路径不存在 |
| `历史不足 40 根 → 返回 null,不硬算` | 沿用旧断言 | 零成本保留 |
| `现价缺失 → 整体返回 null,面板隐藏` | 沿用旧断言 | 零成本保留 |

**`[8]` 整节重写 —— 期权轨(现 358–494 行)**

| 断言名 | 防的事故 |
|---|---|
| `walls 里不再有 strength 字段(旧的 55/20/25 加权分已删除)` | 删了一半 |
| `今天到期的链被排除(expiry <= today,不是 <)` | 现实现已正确,钉死它 |
| `取窗口内 OI 最重的三个到期日,不是日历上最近的三个` | 周度期权把月度挤出去 —— 这是 2026-07-30 修过一次的老账 |
| `均值分母只含有参与的行权价(零 OI 行不进分母)` | 门槛被压到形同虚设,满屏都是墙 |
| `x50 网格标记正确:150 是 isGrid50,175 是 isGrid25,163 两者皆非` | H2 组分层依赖这个标记 |
| `期权轨的 evidence 恒为 pending,不因任何输入变成 verified` | 有人往台账里塞几行就以为可以升级 |

**`[13]` 新增 —— 买入模拟**

| 断言名 | 防的事故 |
|---|---|
| `规则解析器拒绝任何含括号函数调用以外的内容(不许 eval)` | 自定义输入变成任意代码执行 |
| `解析失败返回 {ok:false},不抛异常(输入框不能把页面搞挂)` | `input` 事件里抛错会连带打断后续绑定 |
| `谓词只能读 ctx.i 及之前的价格 —— 喂一段结尾被篡改的序列,结果不变` | 模拟里的未来函数;这是整个面板最值得怀疑的一处 |
| `同一规则同一票跑两次,trades 数组逐条相同(随机对照种子固定)` | 对照本身是噪声 |
| `触发次数 < SIM_MIN_TRIG 时不显示胜率,只列时点` | 3 次触发 3 次赢显示 100% |
| `maxDD 按权益曲线算:两笔 -10%、+5%、-10% 的序列应得 -19%,不是 -10%` | 把「最大单笔亏损」当成回撤 |
| `成本被真的扣掉:零成本与 10bp 的平均收益差约 0.1%` | 成本参数接了但没用 |
| `每一次触发都在触发时点表里,一条不漏(不分页不截断)` | 用户明确要「每一次触发的时间点」 |

**`[14]` 新增 —— 证据分级的执行**

| 断言名 | 防的事故 |
|---|---|
| `PX_EVIDENCE 里标 falsified 的 claim,面板上必须有一句话说明它被证伪了` | 悄悄拿掉一个功能,用户以为还在 |
| `中英词表键完全对齐(现有 [6] 节断言自动覆盖新增的 30 余条)` | 加了中文忘了英文 |
| `渲染层不存在把 pending 腿格式化成百分数的代码路径(源码文本检查)` | 见上,这条是文本级的,故意的 |

### 3.8 实施顺序与每步的验证

> 每一步结束都跑 `node tools/build.mjs && npm test`。**第 0 步之前先把当前 `npm test` 的通过数记下来**,后面每一步都拿它比。

**第 0 步 · 建基线。** 跑 `npm test` 记下 `X passed, 0 failed`;跑 `cp tools/backtest.mjs tools/scratch/baseline.mjs`(去掉末尾 `main()` 的 `--log` 路径)存一份当前各组数字。**验证:** 有了这两份基线,后面任何一步的偏移都能归因。

**第 1 步 · 只加 `params.js` + `scale.js`,不删任何东西。** manifest 插到 21/22。`grid.js` 等暂不存在。**验证:** `npm test` 通过数必须**一字不变**(纯新增,不该影响任何现有断言);`node -e` 在 vm 里调 `reachProb(0, 0.02, 21, 0.86)` 应得 1.0,`reachProb(0.2, 0.02, 21, 0.86)` 应落在 (0,1) 内且随 h 增大而增大。

**第 2 步 · 加 `grid.js`,同时把 `technical.js` 从 manifest 移除但文件先不删。** `priceDensity` 换成新实现(带 `h` 参数、σ 尺度分箱、`asOfSlice` 硬防线)。**验证:** `[7]` 节会大面积红 —— **这是预期的**,此时只确认两件事:(a) 红的全是 `[7]` 里与带宽/箱数有关的断言,`[0]`–`[6]`、`[8]`、`[11]`、`[12]` 一条不红;(b) `tools/scratch/baseline.mjs` 改掉 `need` 后 B 组仍能跑出数,`noBand` 轮数不应暴涨(暴涨说明新的带宽下限把带全挤没了)。

**第 3 步 · 加 `optionwalls.js` + `engine.js`,删掉 `options.js`/`confluence.js`/`technical.js` 三个文件。** **验证:** 页面能加载(控制台零 pageerror —— 这一步最容易因为 `render/pressure.js` 还在读 `L.strength` 而在渲染时抛错);`[8]` 节的期权断言大部分应仍绿(逻辑基本沿用),红的只有 `strength` 相关那几条。

**第 4 步 · 重写 `render/pressure.js` + 改 `pressure.css`(删 `.plbar*` 五条)+ 补 i18n 中英词条。** **验证:** `[6]` 节的「中英词表键完全对齐」必须绿(这是新词条唯一的自动守卫);肉眼在浏览器里切三次持有期,带宽必须明显变化;切中英,面板无一处残留中文。

**第 5 步 · 重写 `[7]`/`[8]` 两节测试。** **验证:** `npm test` 回到全绿,且总断言数 ≥ 第 0 步的基线(重写不许净减少覆盖)。

**第 6 步 · 改 `tools/backtest.mjs`:`need` 数组 + 桥接 + `PX` 存在性断言,B 组对照改成距离匹配 + B2 退化闸门。** 先在 `tools/scratch/` 里改完跑通再落到正式文件。**验证:** B 组的对照臂事件数打印出来必须与处理臂同量级;若 B2 判 `degenerate_control`,说明距离匹配写错了(距离匹配的对照不该退化)。

**第 7 步 · 加 G 组(校准)与 H/H2 组(位移抑制)。** **验证:** G 组的 10 桶可靠性表必须每桶都有样本(某桶为空说明概率被挤在一头,多半是 σ 量纲错了);G 组 h=5 的 skill 应落在 +0.045 附近(提案一的数,若差一个数量级,先查 σ)。

**第 8 步 · 加 `sim/rules.js` + `sim/engine.js` + `render/sim.js` + `index.html` 的 `#simSec` + `events.js` 末尾的四个绑定 + `sim.css`。** **验证:** **先只加 `index.html` 的静态标签和 `events.js` 的绑定,跑一次 `npm test`** —— 如果任何一个 `$('simXxx')` 拼错,这一步会立刻以 pageerror 炸出来,而不是等到功能测试;然后再加渲染逻辑。最后加 `[13]` 节测试。

**第 9 步 · 加 `tools/ledger.mjs` 与两个 npm script,跑一次 `--write` 再跑一次 `--write` 确认第二次全部被拒(内容哈希去重生效),跑一次 `--resolve` 确认没有任何行被结算(`resolve_after` 都在未来)。**

**第 10 步 · 加 I 组(模拟规则 vs 随机入场)。** 放最后,因为它依赖第 8 步的 `simRun` 在 vm 里可用。

### 3.9 验收矩阵

**门槛全部预注册于此。跑完回测再改这张表 = 作弊。**

| 轨 / 声明 | h=5(短) | h=21(中) | h=63(长) |
|---|---|---|---|
| **技术轨 · 可达性**(`reach`) | **回测门槛**:OOS Brier skill > 0,LOO-CV 10 折下界 > 0,可靠性图 10 桶最大偏离 ≤ 0.10 | **回测门槛**:skill > **+0.15**,同上两条 | **回测门槛**:skill > **+0.25**,同上两条 |
| **技术轨 · 位移抑制**(`contain`) | **回测门槛**:cluster bootstrap(按 ticker,2000 次)95% CI 上界 < 0,点估计 z ≤ −2 | **回测门槛**:同左 | **不适用** → **前瞻记账**。effN ≈ 252/63 × 2.1 ≈ 8,MDE 远大于任何合理效应 |
| **技术轨 · 守位**(`bounce`) | **回测门槛**:距离匹配对照的两比例 z ≥ 2 且 effN ≥ 30。已知 max\|z\|=1.20 → **预期判 falsified** | **回测门槛**:同左 → 预期 falsified | **不适用**。提案二功率算式:效应天花板 11pp < 所需 14pp,结构上不可能通过 |
| **期权轨 · OI 墙** | **不适用** → 前瞻记账。可回测快照 4–5 天,无时间序列 | **不适用** → 前瞻记账 | **不适用** → 前瞻记账 |
| **期权轨 · x50 价格网格抑制** | **回测门槛(只记不判)**:`recorded`,与 H 组同口径输出,不设通过线。理由:提案三 z=−1.70/−1.82 未在 x25 复现 | 同左,`recorded` | **不适用** |
| **估值轨** | **不适用**:仅描述,不产出任何百分比。D 组 `valAnchorBias` 已判 `biased` | 同左 | 同左 |
| **买入模拟 · 五个预设** | **回测门槛**:vs 同频随机入场,胜率 z ≥ 2,effN ≥ 30,去掉贡献最大的一只票后 z ≥ 1.5 | **回测门槛**:同左 | **不适用** → 前瞻记账。一年 252 根 / 63 = 4 个不重叠窗口 × 2.1 只有效票 ≈ 8 |
| **买入模拟 · 自定义规则** | **不适用**:用户现搓的规则不进任何验收流程,面板必须并排显示随机对照 | 同左 | 同左 |

**兜底条款:** 任何一格判为「未过」时,该腿在面板上的 `evidence` 落为 `pending` 或 `falsified`,**并且不得为了让它过而回头改参数**。唯一允许的参数搜索是参数表里已经写明搜索范围的那三个(`PX_SIGMA_WIN`、`PX_REACH_C`、`PX_HALFLIFE_D`),判据一律是 **LOO-CV 的样本外 Brier**,不是命中率,不是 z。

---

## 四、这份规格最可能在哪里翻车

不是免责声明。下面四条是有具体数字支撑的预测,每条都给了在哪一步能抓到。

### 4.1 最可能白调的参数:`PX_HALFLIFE_D`

**预测:五个取值(45/90/180/365/∞)的样本外 Brier 极差小于 0.005,判 `no_effect`。**

理由是算术的:时间衰减只改变**密度分箱的权重**,而带的位置由平滑后的峰值决定。峰值位置对权重的单调变换相当不敏感 —— 只有当两个候选峰的权重排序被衰减翻转时,带的位置才会变,而这需要两个峰的原始权重比落在 `0.5^(Δage/H)` 这个很窄的区间里。一年只有 252 根、两年回看窗口里能形成的独立平台通常 3–5 个,翻转事件的期望次数是个位数。

更麻烦的是:卷宗那个「45d > 90d > 180d > 365d > ∞ 单调」的扫描是在**命中率**上做的,而命中率对带宽极度敏感(48%→86%)。半衰期变短 → 近期成交权重上升 → 峰更尖 → 按 `PX_BAND_CUT=0.55` 向外扩张时带更**窄** → 触碰次数下降、条件命中率上升。**那条单调曲线很可能测的是带宽,不是半衰期。** 换成 Brier(它同时吃概率和结果,对带宽不敏感)之后,单调性大概率消失。

**在哪抓到:** 第 7 步。做半衰期扫描时**同时打印每个取值下的平均带宽**;如果 Brier 的变化方向和平均带宽的变化方向完全同步,就是这个混杂。

### 4.2 最可能被证伪的轨:技术轨的「守位」

**预测:B 组在 h=5 和 h=21 都判 `inconclusive` 或 `inverted`,`PX_EVIDENCE.bounce` 落定为 `falsified`。**

已知:提案二 18 格 max\|z\|=1.20,提案三 12 格 max\|z\|=1.06,提案一唯一排除 0 的 bootstrap CI 由单只 QQQ 驱动。三份提案用三套不同的对照,得到同一个「没有」。而卷宗里那个 85% vs 41% 的支持/压力分裂,在一个单边上行年里就是「上涨年份里下方的东西都守住了」的同义反复。

这条被证伪不是失败,是这轮最该交付的结论之一。风险在**执行**上:面板上少了「压力位会不会守住」这个功能,用户第一反应会是「你们做少了」。所以 `plBounceNote` 那段话不能藏在 tooltip 里,必须是压力位表下方的常驻正文。

**在哪抓到:** 第 6 步。如果改成距离匹配对照后 z **反而变大了**,先怀疑距离分层的分桶边界是不是按结果调过的。

### 4.3 最可能藏静默 bug 的实现细节:σ 的量纲

**这是本轮的「财年翻车」同型事故。**

仓库里已经有一个 `volStats(ticker)`,返回的 `sigma` 是**年化**的(`Math.sqrt(va) * Math.sqrt(perYear)`,`perYear` 按日期中位间隔推断为 252/52/12/1)。新引擎要的是 `sigmaD` 的**日**波动率。两者:

- 都是有限正数;
- 都叫 `sigma` 这个语义位置;
- `volStats` 已经在 `render/pressure.js` 同一个文件里被 `renderCompare` 调用着(第 152 行附近),就在手边;
- 差 √252 ≈ 15.9 倍。

如果误用年化 σ:`u = σ_annual · √h · P` 会放大约 16 倍 → 每一条带都宽到覆盖整个价区 → `edgeU` 全部趋近 0 → `pReach` 全部趋近 1.0 → **面板上每个位置都显示「本期触及概率 99%」**。不抛异常,不打日志,数字全在合法范围,可靠性图会显示成一条贴着右边界的直线 —— 而如果没人看可靠性图,只看 Brier skill,skill 会变成一个不大不小的负数,很容易被读成「这个 h 上模型就是不行」。

反向误用(把日 σ 当年化喂给 `renderCompare`)则让 ±1σ 区间缩成一根线。

**防线三道,必须都上:**
1. `params.js` 的文件头注释第一句就写清两者的区别与换算;
2. `[7]` 节那条断言:`σ 是日波动率不是年化 —— sigmaD 与 volStats 相差约 √252 倍`(直接比值断言,`Math.abs(volStats().sigma / (sigmaD().sd * Math.sqrt(252)) - 1) < 0.2`);
3. `scale.js` 里 `reachProb` 加一道运行期哨兵:`if (sd > 0.25) return NaN;` —— 日波动率超过 25% 的股票不存在,这个值只可能来自年化 σ。返回 NaN 会让整条带静默消失,比返回 0.99 好:**消失是看得见的,0.99 不是。**

### 4.4 第二可能藏静默 bug 的地方:vm 桥接与 `horizon` 的缺省

两个,都是同一类 —— **`undefined` 在 JS 里不抛错,只往下游传染。**

**(a) 桥接遗漏。** 新增的 `PX_*` 是顶层 `const`,不挂 `globalThis`。若 3.4(b) 那行桥接漏了某个常量,Node 侧读到的是 `undefined`。`PX_REACH_C[h]` → TypeError(会响,好);但 `PX_HALF_U` 漏掉 → `0.35 * u` 变成 `undefined * u = NaN` → 带宽 NaN → `bands` 数组为空 → B 组打印 `noBand` 轮数暴涨 → 报告上看起来像「这段历史画不出带」。**这就是为什么规格要求加那条 `if (!ctx.PX || !ctx.PX.PX_REACH_C) throw` 断言** —— 用一个必炸的检查去挡一整类不炸的错误。

**(b) `horizon` 缺省。** `render/detail.js:34` 和 `:72` 现在都是 `renderPressure(co, r)`,两个参数。新 `pressureLevels` 是四个参数。如果实现者在 `renderPressure` 里写 `pressureLevels(co, r, null, state.horizon)` —— 注意 **`state.horizon` 是 `'fy1'`/`'fy2'`,是财年,不是持有期**。`PX_HORIZONS['fy1']` = `undefined` → `√undefined` = NaN → `u` = NaN → 所有 `distU`、`pReach` 全 NaN → `up`/`down` 过滤条件 `mid > price` 仍然成立(那一步不涉及 NaN),但 `edgeU <= PX_REACH_U` 恒为 false → **两个数组都空 → `renderPressure` 走到 `sec.hidden = true` 分支 → 面板整个消失。**

用户看到的是:压力位那一块没了。控制台干净。测试如果只断言「有内容时正确」而不断言「horizon 缺省时退回 mid」,全绿。

**这两个字段名的碰撞是真实存在的**:`state.horizon` 已经被财年占用了。规格因此要求持有期存在 **`state.simPref.hold`**,而不是 `state.horizon`,并且 `pressureLevels` 的第四参只接受 `'short'|'mid'|'long'` 三个字符串,**收到任何其它值时退回 `'mid'` 并往 `why` 数组里推一句可见的提示** —— 退回本身不该是静默的,面板上要能看出「你传了个我不认识的持有期」。
---

## 附录 R · 2026-08-06 调参搜索结果记录(**事后**,不是预注册)

> **这一节的性质,先说清楚。** 上面全部内容写于看数据之前,是预注册。这一节写于跑完之后,
> 是**结果记录**。它不修改上面任何一条门槛、任何一句预期判语、任何一条判据 —— 一个字都没动,
> 可以逐行 diff 核对。往下读的时候请始终记住:**上面那些数是承诺,这里这些数是成绩单。**
> 成绩单不好看的时候,该改的是别的东西,不是承诺。

### R.1 搜了什么,在什么范围里搜

许可范围就是 3.3 参数表「搜索范围」栏里写明的那三个,一个不多:

| 参数 | 网格 | 来源 |
|---|---|---|
| `PX_SIGMA_WIN` | {20, 40, 60, 120} | 3.3 |
| `PX_HALFLIFE_D` | {45, 90, 180, 365, Infinity} | 3.3 / D6 |
| `PX_REACH_C` | 各持有期初值 ±0.15、步长 0.05,共 7 档(h5: 0.45–0.75;h21: 0.71–1.01;h63: 0.87–1.17) | 3.3 |

其余 21 个数值常量一个字节都没碰(有机器核对,见 R.6)。`PX_EVIDENCE` 不在搜索范围内,
它那一栏写的是「由回测结果更新」,本轮复核后维持 2026-08-06 早些时候降级后的取值。

工具:`tools/paramsearch.mjs`(`npm run paramsearch`)。它 `import` `tools/backtest.mjs` 的
`loadDashboard / loadDaily / testReach / tCrit95`,不复制一行回测逻辑;`backtest.mjs` 的 `main()`
加了 `import.meta.url === pathToFileURL(process.argv[1]).href` 的守卫,被 import 时不出报告。
参数注入的办法:`PX_*` 是 vm 词法环境里的顶层 `const`,从沙箱外既读不到也写不进,
所以只能在源码文本进沙箱**之前**改写它,正则必须命中且只命中一次(否则抛),
进沙箱之后再从桥接的 `ctx.PX` 读回来核对一遍(对不上抛)。
盘上的 `src/js/pressure/params.js` 全程只读,搜索脚本不写 `src/` 里任何一个字节。

### R.2 判据:为什么必须是嵌套的

3.9 写的判据是「LOO-CV 的样本外 Brier」。但有一处统计陷阱,预注册时没有点破:

`reachProb` 在**运行期零拟合参数**。所以 G 组现有的那个「样本外」划分,实际上只是逐折
重估了气候基准(把基准钉死在全样本上,三个持有期得到 0.2325 / 0.0913 / 0.2611,
与样本内逐位相同)。**一旦拿折上的结果去挑 `PX_REACH_C`,c 就变成了拟合参数**,
那个划分立刻不再是样本外。在同一批折上挑、又在同一批折上报分,报出来的是样本内。

因此本轮的评分是**嵌套**的:外层留一票用于评分,内层在那 9 只训练票里再做一次留一来
挑配置,留出的那只票不参与任何挑选。这样评的不是「某个配置」,而是「**搜索这个动作**」——
后者才是真正要被检验的东西,因为下一轮真要用,用的就是搜索的产物。

对照臂 = 同一套嵌套流程,但候选池只有 3.3 初值一个(= 根本不搜索)。两臂之差 = 搜索的净贡献。
对照臂三个持有期分别是 0.2428 / 0.1093 / 0.3859,与 `tools/backtest.mjs` G 组打印的
0.24 / 0.11 / 0.39 逐位吻合 —— 两个脚本对「样本外」的理解没有分家。

### R.3 `PX_HALFLIFE_D` 的裁决(D6 要求的那一次,已执行)

固定 win=60、c 取初值的单参数扫描:

| 半衰期 | h=5 样本 / 带宽u / OOS | h=21 样本 / 带宽u / OOS | h=63 样本 / 带宽u / OOS |
|---|---|---|---|
| 45 | 334 / 1.553 / 0.0374 | 261 / 1.160 / 0.0996 | 128 / 0.869 / 0.2107 |
| 90 | 300 / 1.880 / 0.1340 | 330 / 1.238 / −0.0070 | 204 / 0.956 / 0.3322 |
| 180 | 279 / 1.973 / 0.1799 | 387 / 1.331 / 0.0267 | 236 / 0.952 / 0.3845 |
| 365 | 274 / 2.023 / 0.2428 | 420 / 1.361 / 0.1093 | 253 / 0.908 / 0.3859 |
| ∞ | 253 / 1.911 / 0.2190 | 427 / 1.263 / 0.1759 | 264 / 0.906 / 0.3869 |

极差 0.2055 / 0.1830 / 0.1762。**预注册那条「极差 < 0.005 判 no_effect」的规则并没有触发。**
这一点必须原样写下来,不能含糊。

判 `no_effect` 靠的是另外两条,而且都比极差规则硬:

1. **那个极差不归半衰期。** 4.1 点名要打印的混杂探针就是带宽,现在它开口说话了:h=5 上
   skill 从 0.037 单调升到 0.243 的同时,平均带宽从 1.553u 单调升到 2.023u,样本量从
   334 掉到 253。换一档半衰期就是换一批观测、换一套带宽 —— 而带宽单独就能把命中率
   从 48% 推到 86%(3.3 里 `PX_HALF_U` 那一行原话)。这条曲线量的是带宽,不是半衰期。
2. **嵌套评分上它不赚钱。** 含半衰期的全网格搜索净贡献 −0.0750 / +0.1549 / −0.0969,
   留出折可靠性图最大偏差 0.22 / 0.21 / 0.20,三格全过不了 ≤0.10。

顺带回答 D6 里那个冲突:卷宗那条「45d > 90d > 180d > 365d」的单调扫描**没有复现**,
本轮三个持有期上 365 与 ∞ 都排在 45 前面,方向是反的。而 D6 要求「把源码那句注释删掉」——
`technical.js` 在重写之后已经不存在于 `src/` 里,那句话如今只以**引文**形式活在
`params.js` 的注释里,删无可删,留着正好当裁决的对照。

`PX_HALFLIFE_D` 回到(其实是留在)365。裁决行已写入 `Assets/_logs/param-adjudication.csv`。

### R.4 两轮嵌套评分的成绩单

判据照 3.9 三条并联:样本外 skill > 门槛(0 / 0.15 / 0.25)、CV 下界 > 0、可靠性图最大偏差 ≤ 0.10。

**第一轮 · 全网格(win × 半衰 × c),每个持有期各挑各的 —— 故意给搜索占便宜:**

| 持有期 | 候选 | 对照 | 处理 | 净贡献 | CV下界 | maxDev | 判定 |
|---|---|---|---|---|---|---|---|
| 5 | 105 | 0.2428 | 0.1679 | −0.0750 | −0.031 | 0.22 | 未过 |
| 21 | 105 | 0.1093 | 0.2642 | +0.1549 | +0.133 | 0.21 | 未过(skill 过线,maxDev 不过) |
| 63 | 105 | 0.3859 | 0.2891 | −0.0969 | −0.113 | 0.20 | 未过 |

**第二轮 · 只搜 c,引擎钉在 3.3 初值** —— 这是第一轮候选池的**子集**,不是放宽。
选它的理由:c 不改变观测集合,两臂逐条比的是同一批位置、同一批结局,
是全程唯一没有「换了道题」嫌疑的对比。

| 持有期 | 候选 | 对照 | 处理 | 净贡献 | CV下界 | maxDev | 判定 |
|---|---|---|---|---|---|---|---|
| 5 | 7 | 0.2428 | 0.2371 | −0.0057 | +0.030 | 0.13 | 未过 |
| 21 | 7 | 0.1093 | 0.0876 | −0.0217 | −0.057 | 0.21 | 未过 |
| 63 | 7 | 0.3859 | 0.3952 | +0.0093 | +0.010 | 0.17 | 未过 |

**两轮合计六格,过线零格。** 全网格逐配置的样本外 skill(105 × 3 行)由
`npm run paramsearch` 第 ② 段全量打印 —— 只印赢家等于要人相信搜索过程。

按 3.9 兜底条款:三个参数一律取回 3.3 初值。没有回头改参数,没有回头改门槛,没有第三轮。

### R.5 本轮暴露出来的三处缺陷(记录,本轮不修)

1. **`PX_SIGMA_WIN = 20` 在引擎里根本跑不出来。** 冻结常量 `PX_SIGMA_MIN_N = 40` 要求至少
   40 根收益,20 根窗口喂不满,`sigmaD()` 返回 null,于是 20 这一档在全部 5 档半衰期、
   全部 3 个持有期上都是**零观测**。3.3 的搜索范围与同一张表里的冻结常量互相矛盾:
   范围里写着的值,引擎跑不出来。名义 4×5×7=140 个候选,实际可用 105 个。
   这也让 3.3 里「60 根在三个 Brier 上都胜 20 根」那句话在本仓库口径下无法复核 ——
   不是输了,是比不了。本轮不改任何冻结常量,只记下来。
2. **h=21 的最优 c 落在许可范围的边界上。** 第一轮 h=21 十折**一致**挑中 c=0.71,
   而 0.71 正是初值 0.86 减 0.15 的下边界。十折一致说明这不是折间噪声,
   说明最优点很可能在许可范围之外。**这是下一轮预注册前该提的动议,不是本轮改范围的理由。**
3. **半衰期扫描的观测集合随参数变化。** 见 R.3 第 1 条。任何「换一档参数就换一批观测」的
   扫描,其纵向比较都不是同一道题的比较。下一轮若还要扫半衰期,应先固定观测集合
   (例如只在所有档位都出观测的交集上比),否则再扫一遍也还是量带宽。

### R.6 冻结常量的机器核对

从 3.3 表格里正则抽出每个常量的初值,与 `src/js/pressure/params.js` 里
`const NAME = …;` 的字面量逐个比对(忽略空白与引号形式):
**25 个常量,24 个逐字相同;唯一不同的是 `PX_EVIDENCE`,而它那一栏写的就是「由回测结果更新」。**
三个被搜的参数搜完之后都停在初值上:`PX_SIGMA_WIN = 60`、`PX_HALFLIFE_D = 365`、
`PX_REACH_C = {5:0.60, 21:0.86, 63:1.02}`。

### R.7 一句话结论

**这条信号在现有数据下测不出效果。** 位置排序大致对(样本外 Brier skill 一直是正的),
但刻度不对(可靠性图最大偏差 0.13–0.22,门槛 0.10),而且 3.9 许可范围里的
任何一个参数配置都修不好这件事 —— 两轮六格,一格没过。`PX_EVIDENCE.reach` 维持 `pending`,
面板继续只报位置与 σ 距离、不报百分比,并已在 tooltip 里补上「搜过了,仍然过不了」这句话:
「未验证」会被读成「还没顾上测」,而实情是测了、搜了、没测出来。

---

## 附录 K · K 线图技术指标的验收矩阵(**预注册**,写于 2026-08-06,写在算出任何一个指标数字之前)

### K.0 这一节的性质,先说清楚

附录 R 是**成绩单**,写于跑完之后。这一节是**承诺**,写于跑之前 —— 与第三节同一个性质,
只是晚了一轮才写。写完这一节我才动手实现 `tools/backtest.mjs` 的 J 组,J 组跑出来的数
一律进附录 K 之外的地方(终端与 `Assets/_logs/backtest-history.csv`),**不回头改这一节的任何一个数**。

为什么要多此一举地把它写在前面:上一轮 R.5 已经记下了一次教训 —— h=21 的最优 c 落在许可范围的
边界上,而那件事之所以只能记成「下一轮的动议」而不能当场改范围,靠的就是范围写在前面。
指标这件事的诱惑比调参大得多:能从收盘价上算出来的「标准指标」有几十个,
挨个试一遍再报最好看的那个,和随机挑一个报出来在统计上是同一件事,
但在读者眼里前者像研究、后者像抛硬币。**这一节存在的唯一目的,就是让那条路走不通。**

### K.1 用户的裁决,以及它推出来的硬约束

问的是「要不要在仪表盘上加一张 K 线图,把技术分析画上去」。给出的选项里选中的是
**「指标必须过同一道闸」**:任何要画到图上、并且带着判断意味的东西(均线、突破、RSI……),
必须先在样本外赢过压力位引擎 `reach` 轨被要求赢的那一类基准,才有资格带颜色、带徽章、带判语。

推出来三条硬约束,后面每一条设计都服从它们:

1. **过不了闸的指标不是不画,是画成素线** —— 无颜色、无徽章、无判语、无「金叉/死叉」这类词。
   一条灰线加一句「未通过验收闸门(effN=…)」,和一条绿色的、写着「金叉」的线,
   传达的东西差着一个数量级,而它们背后的证据是同一份:没有。
2. **判语只能来自跑出来的数**,不能来自「大家都这么用」。RSI 30/70 是教科书数字,
   不是本仓库的测量结果;它进不进颜色,由 J 组说了算。
3. **矩阵必须能在 5 年数据上原样重跑。** 现在预注册的价值全在这里:5 年那一跑必须是
   一次**检验**,而不是一次**搜索**。所以下面每一格都写清 1 年与 5 年各自的样本预算,
   哪些格子今天就没救、哪些格子只是还没到时候,读者一眼要能分开。

### K.2 数据边界:今天能算什么,什么被 O/H/L 卡死

`Assets/charting/*.xlsx` 现在只有 **Date / Close / Volume** 三列,没有 Open/High/Low。
这不是「精度差一点」,是一整类指标**在数据上不存在**:

| 被卡死的东西 | 卡在哪 | 状态 |
|---|---|---|
| **K 线的实体与影线本身** | 需要 O/H/L 四个值,现在只有 C | `pending_no_ohlc` —— 今天这张图**只能是收盘价折线**,叫它 K 线图是名不副实 |
| ATR / 真实波幅、以其为基础的通道与止损 | 需要 High−Low 与前收的三取大 | `pending_no_ohlc` |
| 经典随机指标 KD、Williams %R | 需要窗口内的最高价/最低价 | `pending_no_ohlc` |
| 枢轴点 / 传统支撑压力(PP、R1、S1) | 需要 (H+L+C)/3 | `pending_no_ohlc` |
| 一目均衡表的转换线/基准线 | 需要 (最高+最低)/2 | `pending_no_ohlc` |
| 缺口(跳空) | 需要 Open 与前收 | `pending_no_ohlc` |

**这些指标本轮一个都不测,也不许用收盘价近似出一个「差不多的 ATR」再拿去过闸。**
用 |ΔClose| 冒充真实波幅,算出来的东西会通过闸门也说不定,但它验收的不是用户以为的那个指标 ——
这正是 4.3 那类静默事故的同型:数字全在合法范围,没人会发现口径换了。
等 O/H/L 到位再单开一节预注册,那一节同样要写在看到数之前。

**能算的**:一切只吃 Close 与 Volume 的东西 —— 均线关系、新高/突破、RSI、量能确认、
乖离、动量。下面从中挑四个。

### K.3 指标集:四个,以及为什么不是八个

多测一个指标,家族里就多一格,Bonferroni 的临界值就往上抬一截,**已经在测的那些格子会跟着变难**。
八个指标 × 三个前瞻 = 24 格,临界 z 要 3.09;四个 × 三个 = 12 格,临界 z 是 2.87。
在 effN 只有几十到几百的样本上,这个差别足以决定「有没有可能过」。
所以指标集必须小,而且必须在看数之前定死。挑选准绳只有两条:**教科书里就有、不含任何可调的自选参数**
(参数一旦可调,「哪个窗口最好」就是又一层搜索),以及**四个之间尽量不同源**
(趋势 / 突破 / 摆动 / 量能各一个,四个都是均线变体就等于把一格算了四遍)。

| id | 指标 | 定义(规范定义,以此为准) | 类别 |
|---|---|---|---|
| `maState` | 均线状态 | `SMA20(t) = mean(close[t−19..t])`,`SMA60(t) = mean(close[t−59..t])`;`s=+1` 当 SMA20 > SMA60,`s=−1` 当 SMA20 < SMA60,相等记 `s=0`(不入样) | 趋势 |
| `breakout55` | 55 日新高突破 | `H55(t) = max(close[t−55..t−1])`(**不含当日**);`s=+1` 当 `close[t] > H55(t)`,否则 `s=0` | 突破 |
| `rsi14` | RSI(14) 超买超卖 | Wilder 平滑,首值用前 14 根涨跌幅的简单平均播种;`s=+1` 当 RSI<30,`s=−1` 当 RSI>70,其余 `s=0` | 摆动 |
| `breakoutVol` | 带量突破 | `breakout55` 触发 **且** `vol[t] > 1.5 × mean(vol[t−19..t−1])`;否则 `s=0`。无成交量列的标的整只排除 | 量能确认 |

20/60 这一对不是本轮挑的:`src/js/sim/rules.js` 的 `trendBuy` 预设已经用的就是 `maCross(20,60)`,
沿用它是为了不让「窗口长度」变成第五个自由度。55 是海龟系统的长周期突破,30/70 是 RSI 的教科书线,
1.5× 是量能确认最常见的写法 —— **四个数字全部来自外部惯例,没有一个是在这份数据上挑的。**

**明确不测**:MACD(它是 12/26/9 三个参数,而且与 `maState` 同源)、布林带(它是 σ 的另一种画法,
A 组已经在测 σ 的覆盖率了,再测一遍是同一份证据用两次)、任何均线组合的最优化。

### K.4 每个指标声明的到底是什么

「指标有效」这句话不能进验收,它没有可证伪的形状。四个指标各自声明的是**同一种东西的四个实例**:

> **在 `s≠0` 的那些交易日上,未来 h 日对数收益的符号等于 `s`,其频率高于在同一段可入场区间里
> 随便挑同样多天、按同样的方向多空配比去猜的频率。**

`maState` / `rsi14` 是双向的(`s` 可正可负),`breakout55` / `breakoutVol` 是单向的(只声明 `s=+1`)。
`rsi14` 声明的是**均值回复**方向(超卖看涨、超买看跌),这是教科书读法;
**动量读法(超买继续涨)不在预注册之内** —— 如果跑出来 z ≤ −2.87,那是 `inverted`,
是一个结果,不是「那就反过来用」的许可。反过来用要另开一次预注册,并且在新数据上跑。

前瞻期 **h ∈ {5, 21, 63}**,就是 `PX_HORIZONS` 那三个刻度,不新造口径。
热身 **W = 120 根**,与 `SIM_WARM`、`testBands` 的 `warm` 对齐(SMA60 要 60 根、突破要 55 根、
RSI 要 15 根,120 都盖得住,而且三处热身长度一致才好对账)。
可入场根的区间是 `[W, len−1−h]`,与 `simControl` 同一口径。

### K.5 闸门:四条判据,并联,全过才算过

「同一道闸」的字面意思:`reach` 轨被要求的是**气候基准 + 留一标的的样本外 + 折间稳定**,
`I` 组被要求的是**同频随机对照 + 效应量 + 有效样本**。J 组两样都要,合成四条:

| # | 判据 | 内容 | 不过的后果 |
|---|---|---|---|
| **C1** | 有效样本 | `min(effN处理, effN对照) ≥ 30`。`effN` = 贪心不重叠计数(同 `simEffN`:按时间排序,下一次触发距上一次 ≥ h 才算新证据) | `inconclusive`。**样本不足永远不给证伪的权利** |
| **C2** | 样本外信息量 | 折 = 标的(留一标的,上限 10 折,与 G 组同一套)。模型 = 训练折上按状态 `s` 拟合的 `P(涨|s)`;基准 = 训练折上**全部可入场日**的无条件 `P(涨)`(气候基准)。结算集 = 留出折里 `s≠0` 的那些日子。要求 **OOS Brier skill > 0** | `inconclusive` |
| **C3** | 折间稳定 | 各折 skill 的均值 − `t(k−1)·sd/√k` **> 0**。临界值走 `tCrit95(df)`,不是 1.96(理由见该函数注释) | `inconclusive` |
| **C4** | 效应量 | 处理臂命中率 vs **同频随机对照**臂命中率的两比例 z(合并 p,分母用各臂 `min(n, effN)`,与 `simZ` 同一个式子)。要求 **z ≥ 临界值**(见 K.6) | `inconclusive`;若 **z ≤ −临界值** 则 `inverted` |

**同频随机对照怎么造**:逐标的,数出处理臂声明「涨」的天数 k₊ 与声明「跌」的天数 k₋,
在同一只票、同一段可入场区间 `[W, len−1−h]` 里**不放回**抽 k₊+k₋ 个互不相同的日子,
洗牌后前 k₊ 个派「涨」、其余派「跌」。种子由 `FNV-1a(ticker|指标id|h)` 派生,固定不可挑。
对照臂不看任何指标,它回答的是「这段行情里随便挑同样多天、按同样的多空配比猜,会对多少」。
**为什么必须是同频随机而不是 50%**:I 组那段注释已经写过,这一年是单边上行年,
无条件 5 日胜率 52.4%(n=1260),拿 50% 当基准会让一堆指标「跑赢」,而它们赢的是行情。
`maState` 这一格尤其要注意:它每天都触发,于是 k₊+k₋ = 可入场天数,
抽出来的集合**就是处理臂自己那批日子**,只有方向标签被打乱 —— 那正好是一次标签置换检验,
这是这四格里对照最干净的一格。

**退化闸门(照搬 B2)**:对照臂 `effN` 不足处理臂 30% → 判 `degenerate_control`,z 不发布。
按上面的造法它不该退化;真退化了,是抽样写错了,不是数据的问题。

**为什么没有可靠性图那一条**:G 组第三条判据是「10 桶最大偏差 ≤ 0.10」。
指标是 k 状态的,最多只能给出 k 个不同的预测值(这里 k ≤ 3),10 桶里必然有 7 个以上是空桶,
而 G 组的注释里写着「空桶本身就是警报」—— 那条警报在这里会**结构性地**响,毫无信息。
所以 J 组把它换成**状态表**:逐个状态打印样本数、样本外平均预测、实际涨幅频率、偏差。
状态表**只记不判**(`recorded`),不设门槛 —— 再给它安一个门槛就是凭空多一个没依据的数字。

### K.6 多重比较:家族是 12 格,一个主检验,其余走 Bonferroni

4 个指标 × 3 个前瞻 = **12 格,这就是家族全集**,不多不少。测 12 格只报最好看的那一格,
是加了工序的 p-hacking;所以纠正必须和门槛写在同一张表里,而不是事后补一句「注意多重比较」。

- **主检验(confirmatory),恰好一格:`maState` @ h=21。** 临界值 **|z| ≥ 2.00**(不校正)。
  它是唯一一个事先指定的假设,单个事先假设不需要校正,用 2.00 而不是 1.96 只是与全仓库其它组对齐。
  选它的理由是先验而非功效:趋势跟随是这四类里文献最厚的一类,20/60 这一对已经在 `trendBuy` 里用着,
  而 21 日是这对均线在教科书里对应的持有量级。**明知它在 1 年数据上没救也选它** ——
  见 K.7,这一格 1 年的 MDE 是 18.2pp。为了 1 年的功效改挑 h=5 当主检验,
  就是拿手上已有的样本去优化预注册本身,那是同一个病的轻症。
- **其余 11 格(exploratory):Bonferroni,临界值 |z| ≥ 2.87。**
  α=0.05,m=**12**(把主检验也算进分母 —— 少算一格能把临界值降到 2.85,
  这种便宜不占,而且「声明一个主检验来缩小 m」本身就该被堵死)。
  双侧,每尾 0.05/12/2 = 0.002083;Φ(−2.87) = 0.002052 ≤ 0.002083,取 2.87 略偏保守。
- **m 为什么把 h=63 也算进去**:h=63 在 1 年数据上是死格(effN=20 < 30,C1 必挂),
  按理可以不测、把 m 降到 8(临界 2.73)。不这么做的理由是 K.1 第 3 条:
  这张矩阵要在 5 年数据上**原样重跑**,而 h=63 在 5 年上是活格(effN≈180)。
  家族必须覆盖**这张矩阵将来会报出来的每一格**,否则 5 年那一跑就得换一个 m,
  两次的数字也就不再可比。今天为此多付 2.73→2.87 的代价,是这张矩阵能被重跑的价钱。
- **`breakoutVol` 与 `breakout55` 谁更强,不构成第 13 格。** 两者嵌套、共用同一批日子,
  比较它俩是又一次比较,而 m 没给它留位置。所以「量能确认有没有加分」这件事
  **只记录两格各自的 z,不做差、不判语**。

### K.7 样本预算与 MDE:哪些格子今天就没救,哪些只是还没到时候

10 只票 × 252 根;可入场根数 = 252 − 120 − h;贪心不重叠的独立数 = `floor((span−1)/h)+1`,再 ×10 只票。
5 年一栏按 1260 根、同样 10 只票推。MDE 按两臂等量、p≈0.55 的两比例检验算:
`MDE = z* × sqrt(2·p(1−p)/effN)`。

| 前瞻 | 1 年 span/票 | 1 年 effN 上限 | 1 年 MDE@2.00 | 1 年 MDE@2.87 | 5 年 effN 上限 | 5 年 MDE@2.00 | 5 年 MDE@2.87 |
|---|---|---|---|---|---|---|---|
| h=5 | 127 | **260** | 8.7pp | 12.5pp | **2270** | 3.0pp | 4.2pp |
| h=21 | 111 | **60** | 18.2pp | 26.1pp | **540** | 6.1pp | 8.7pp |
| h=63 | 69 | **20** | 31.5pp | 45.2pp | **180** | 10.5pp | 15.1pp |

上表是**天天触发**的指标(只有 `maState`)才拿得到的上限。事件型指标要再乘触发率:
`breakout55` 在单边上行年估计触发率 10% 上下,`rsi14` 两侧合计估计 10–15%,
`breakoutVol` 是 `breakout55` 的子集,估计只剩两三成 —— 它们的 effN 会是
`min(触发数, 上表的上限)`,h=5 时受触发数约束,h=21/63 时受上限约束。

**读这张表得出的三件事,现在就写下来:**

1. **1 年数据上唯一有一点功效的是 h=5 那一行**,而它要求 12.5pp 的效应
   (主检验那格不在这一行)。本项目至今最强的信号是 `trendBuy` @21 日的 83.3% 对无条件 55.5%、
   z=+1.94 —— 那个 27.8pp 看着够大,但它建立在 12 次触发上,换成同频随机对照后 z 只有 +0.20,
   而且三道闸门一道没过。**真实的技术指标效应量级是个位数 pp,12.5pp 这条线,一年数据上过不去。**
2. **h=21 与 h=63 在 1 年上是死格**,C1 直接判 `inconclusive`(h=63 的 effN=20 < 30 是算术,不是运气)。
   它们不是被删掉、而是照跑照记 —— 5 年重跑时同一行代码、同一个门槛,那一跑才有话说。
3. 因此 **1 年这一跑的预注册预期是:12 格全部 `inconclusive`,零格 `holds`。**
   这句话写在这里是为了让它可以被推翻:真跑出一格 `holds`,说明要么效应真的很大,
   要么实现里有未来函数 —— 后者的先验概率更高,届时第一件事是回头查 as-of 截断,不是发新闻。

### K.8 判语词表,以及它到底决定图上画成什么样

沿用 `tools/backtest.mjs` 现有词表(那里写着「加词可以,改词不行」),J 组用到的是:

| 判语 | 含义 | K 线图上的后果 |
|---|---|---|
| `holds` | C1–C4 全过,方向与声明一致 | 允许**带颜色、带徽章、带判语**绘制。徽章必须写明前瞻期与 z,不许只写「有效」 |
| `inverted` | C1 过,且 z ≤ −临界值(**不要求 C2/C3**) | **不带徽章**,画成素线,并在图下方常驻一句「这条指标在本仓库数据上测出来是反的」 |
| `inconclusive` | 样本不足,或 C2/C3/C4 任一未过 | 素线。无颜色、无徽章、无判语。tooltip 写「未通过验收闸门」并附 effN |
| `no_signal` | **新词**。整段历史该指标一次都没触发 | 素线,且不进图例 —— 它和「触发了 12 次但 effN=2」是两回事,后者是样本少,前者是没有样本 |
| `degenerate_control` | 对照臂 effN 不足处理臂 30%(照搬 B2) | 素线。z 不发布 |
| `recorded` | 状态表、OOS skill、CV 下界这三行辅助记录 | 不决定任何绘制 |
| `pending_no_ohlc` | **新词**。K.2 那张表里被 O/H/L 卡死的东西 | 根本不画。K 线实体与影线本身也在此列 —— 今天这张图只能是收盘折线 |

**`inverted` 为什么不要求 C2/C3,这个不对称是故意的**:让一条线**开始**带颜色需要四条判据全过,
让一条线**停止**被当成正向信号只需要它稳定地错。一个方向反了但折间不稳的指标,
如果因为 C3 没过就继续被画成绿色,这个词表就白设了。**举证责任在「要画」的那一边。**

两个新词:`no_signal` 与 `pending_no_ohlc`。选它们而不是复用现有词的理由 ——
`inconclusive` 会把「一次没触发」和「触发过但看不清」压成同一格,而 I 组现在正是这么干的
(终端上印「整段历史一次都没触发」,CSV 里却记成 `inconclusive`),读账的人分不出来;
`pending_no_history` 语义是「这一轨没有时间序列」(期权 OI),而 O/H/L 的问题是
**有时间序列但少了三列**,两者的解法完全不同(一个要等快照攒够,一个改一次导出模板就有了)。

3.9 的兜底条款只给了 `pending` / `falsified` 两个词,这是那一节已知的缺口
(CHANGELOG v18.0「本轮已知未修」里记着 `inconclusive` 不在兜底词表里,而 bounce 恰好落在那里)。
J 组不去补 3.9 —— SPEC 只许追加 —— 而是在这里把自己用到的词一次列全,
并且**明说 J 组不产生 `falsified`**:12 格里没有任何一格的功效撑得起「证伪」这两个字。

### K.9 兜底条款

1. 任何一格判为「未过」时,该指标在 K 线图上落为素线,**并且不得为了让它过而回头改指标定义、
   改窗口长度、改前瞻期、改临界值**。K.3 那四行定义、K.5 那四条判据、K.6 那两个临界值,
   跑完之后一个字符都不许动。
2. **不许加第五个指标。** 看完 12 格再想「要不要也试试 MACD」,那就是在用结果挑候选;
   要加,下一轮预注册,并且 m 从头重算。
3. 5 年数据到位后**原样重跑同一条命令**,不改任何门槛。届时新增的行按 `run_date` 与今天这一跑
   并排躺在 `Assets/_logs/backtest-history.csv` 里,谁在哪一轮翻的判语,一眼看得见。
4. J 组里那四个指标的实现,是它们在本仓库的**规范定义**。将来任何一格过了闸、真画到图上,
   渲染层必须调同一套公式,并且要有一条断言把两处钉在一起 —— 否则画的和验收的不是同一个东西,
   这是 4.3 那类静默事故最容易复发的地方。

---

## 附录 L · 2026-08-06 K 线面板交付记录(**事后**,不是预注册)

> **这一节的性质,先说清楚。** 和附录 R 一样,这是**交付记录**,写于面板做完之后。
> 它不修改上面任何一条门槛、任何一个指标定义、任何一条判据 —— 附录 K 的 K.3 四行定义、
> K.5 四条判据、K.6 两个临界值、K.8 判语词表,一个字符都没动,可以逐行 diff 核对。
> **上面那些是承诺,这里这句是交代承诺兑现成了什么样子。**

### L.1 交付了什么,以及图上有几条指标线

K 线面板已交付:`src/js/render/candles.js`,手写 SVG,零依赖,读取层(浏览器侧
`src/js/ingest/charting.js`、Node 侧 `tools/backtest.mjs` 的 `loadDaily()`)已兼容
`Open` / `High` / `Low` 三列。

**图上的技术指标线数量是零。** 这不是"暂时还没画",是 K.8 的直接后果:
附录 K 的 12 格(4 个指标 × 3 个持有期)当前**全部未过验收闸门** ——
其中依赖 O/H/L 的那一整类被 K.2 判为 `pending_no_ohlc`(导出里根本没有这三列),
其余的样本预算不足(K.7)。K.8 规定一格没过就落为素线,于是 12 格全挂 = 一条线都不画。

随之不许出现在面板上的还有:任何颜色徽章、任何"看涨 / 看跌 / 金叉 / 死叉 / 超买 / 超卖"
字样、任何百分数(胜率、强度分、"上涨概率")。这几条都有断言钉着(`tests/test-app.mjs`)。

**唯一允许留在图上的颜色是蜡烛实体的红 / 绿**,因为它描述的是"这一天开盘到收盘是涨是跌"
这个**事实**,不是对明天的判断。面板正文里写死了这句话,也有断言钉着。
数据里凑不齐 O/H/L 时面板降级成收盘折线,而降级之后**连红绿都不许有** ——
折线没有"当天开收方向"这个事实可描述,再涂色就只剩暗示了。

### L.2 将来哪一格过了闸,才允许画,以及画的时候必须做什么

这一条是把 K.9 第 4 款在交付侧钉死,不新增任何门槛:

1. **先过闸,再画线。** 某个指标要出现在 K 线图上,前提是它在附录 K 的判据下真的过了 ——
   判据就是 K.5 那四条并联、K.6 那两个临界值,跑完之后一个字符都不许动。
   数据到位后**原样重跑同一条命令**,不许为了让它过而回头改指标定义、窗口长度、前瞻期或临界值。
2. **画的必须是验收的那一套公式。** `tools/backtest.mjs` J 组里那四个函数是这些指标在本仓库的
   **规范定义**。渲染层不许另写一份"差不多的" —— 另写一份,画出来的和验收过的就不是同一个东西,
   而这种不一致是静默的:图照画,数不对,没人报错。
3. **必须加一条断言把两处钉在一起。** 光在代码里调同一个函数不够,得有测试证明它调的是同一个;
   否则下一次重构随手复制一份公式过去,断言不响。这条断言是"允许画线"的组成部分,不是后续工作。
4. 在上述三条同时满足之前,面板上正文那句"12 格全部未过验收闸门"必须常驻,不许摘掉。

---

## 附录 M · 情绪面轨道的验收矩阵(**预注册**,写于 2026-08-06,写在算出任何一个情绪指标数字之前)

### M.0 这一节的性质,以及一个必须先澄清的命名

和附录 K 完全同一个性质:**承诺**,不是成绩单。写完这一节我才动手实现 `tools/backtest.mjs` 的
**K 组**(J 组之后的下一个字母),K 组跑出来的数一律进附录之外的地方(终端与
`Assets/_logs/backtest-history.csv`),**不回头改这一节的任何一个数**。

先澄清命名,否则后面每一句都会读岔:**回测组代号 `K` 与 SPEC 附录 K 不是一回事。**
附录 K 预注册的是**技术面**,它对应的回测组是 `J`;这一节(附录 M)预注册的是**情绪面**,
它对应的回测组是 `K`。附录与组号错开一位是既成事实(附录 K ↔ J 组已经这样了),
本节沿用而不去修正 —— SPEC 只许追加,改前文比这点混乱危险得多。
下文凡说「K 组」一律指回测组,凡说「附录 K」一律指技术面那一节。

为什么情绪面这一轨也要先写这一节:情绪面比技术面更容易造出好看的数字。
技术指标至少还受「教科书里得有」这条约束卡着,而「情绪」是一个**可以自己发明**的量 ——
词典多加一个词、计数窗口挪三天、阈值从 1.5 挪到 1.4,每一次都是一个自由度,
而这些自由度在 2000 条标题上一次也不会被样本量惩罚。
挨个试一遍再报最好看的那个,和随机挑一个报出来在统计上是同一件事。
**这一节存在的唯一目的,就是让那条路走不通。**

### M.1 用户的要求,以及它推出来的硬约束

用户最初的要求是「无论是从技术面、情绪面、期权多空博弈点、还是长期短期的逻辑都最后达到验收」。
到附录 L 为止,技术面走完了(附录 K → J 组,12 格全部未过闸),期权轨被判 `pending_no_history`
(没有时间序列,不是样本少),情绪面是唯一一块完全没动过的。这一节把它补上。

用户对这一轨额外给了三条,逐条抄在这里,后面每一个设计都服从它们:

1. **「以新闻强度为主。」** 客观可复现的那一类 —— 按日计数、相对该票自身基线的计数异常。
   标题关键词词典是主观的,词典本身就是一组自由参数。
2. **「不许为了让数字好看回头改规格或改参数。」** 与 K.9 第 1 款同款,只是说得更直白。
3. **「样本不足只能判 `inconclusive`,不许判 `falsified`」** —— 样本不足不给人宣告证伪的权利。
   这一条与 K.5 的 C1 是同一条,写两遍是因为情绪面的样本比技术面**更少**(见 M.9)。

### M.2 数据边界:这份新闻数据里有什么、没有什么

`Assets/news/*.csv` 共 **9 份**(AAPL / AMD / AMZN / ASML / GOOGL / MSFT / NVDA / SPCX / TSM),
约 2000 行,跨度 2025-07-28 ~ 2026-08-06。列**只有三列**:`date` / `ids` / `headline`。

| 没有的东西 | 后果 |
|---|---|
| **情绪分**(没有任何一列给出正负或强度) | 「情绪」这个量在这份数据里**不存在现成值**,只能从计数或标题文本构造出来 |
| **正文**(只有一行标题) | 任何需要文章长度、来源权威度、事件类型分类的做法一律没得做 |
| **发布时刻**(部分标题里有 `(~9:45ET)` 之类,但不是列,也不是每条都有) | 无法可靠区分盘中与盘后 → 对齐规则必须按最保守的写(见 M.5) |
| **SPCX-US 的日线**(`Assets/charting/SPCX-US Daily Charting.xlsx` 只有 36 根,`loadDaily()` 的 40 根下限把它整份丢掉) | SPCX 有新闻但没有可用价格 → **不进 K 组** |
| **QQQ-US / SPY-US 的新闻** | 有日线没有新闻 → **不进 K 组**。没有新闻文件 ≠ 这只票没有新闻,只是没抓;拿「零新闻」当事实会把它整年判成 drought,那是凭空造出来的信号 |

于是 **K 组的标的集合恰好是 8 只:AAPL / AMD / AMZN / ASML / GOOGL / MSFT / NVDA / TSM。**
折数上限因此是 **8**,比 J 组的 10 还少两折 —— 这个数字后面 C3 那条判据要用到,先记下。

### M.3 指标集:三个,全部来自新闻强度;关键词词典**明确不做**

先说不做的那一半。**(b) 标题关键词词典这一类,本轮一格都不测**,理由有两条,任何一条单独成立:

1. **本仓库已经有一条关键词词典腿了,就是 F 组**(`newsScore`,30 日关键词打分,仪表盘情绪腿权重 0.25)。
   再写一份词典去测同一批标题,是**同一份证据用两次** —— 与 K.3 拒绝布林带的理由字面相同
   (「A 组已经在测 σ 的覆盖率了,再测一遍是同一份证据用两次」)。
2. 词典是一组自由参数,而这份语料只有约 1800 条参与行。在 1800 条上挑词等于拟合噪声,
   而且**这种拟合不会在任何一个统计量上留下痕迹** —— 跑出来的 z 不知道我改过几版词典。
   要做,只有一条合法路径:词典在预注册时一次性写全、跑完一个词都不许增删。
   我选择不走这条路,因为第 1 条理由已经让这条路的产出为零。

**做的是 (a) 新闻强度,三个指标。** 为什么不是六个:与 K.3 同一个理由 —— 多测一格,
Bonferroni 临界值就往上抬一截,已经在测的格子会跟着变难。三个 × 三个前瞻 = 9 格。

挑选准绳只有两条,与 K.3 一字不差:**不含任何在这份数据上挑出来的自选参数**,
以及**三个之间尽量不同源**(事件型放量 / 事件型沉寂 / 连续型加速度各一个)。

先定义计数序列。设某只票的交易日索引为 `t = 0..251`(`Assets/charting` 的 252 根,已按日期升序),
`c[t]` = 该票**归属到交易日 t** 的新闻条数(归属规则见 M.5,严格只含 t 之前发布的)。

| id | 指标 | 定义(规范定义,以此为准) | 类别 |
|---|---|---|---|
| `newsBurst` | 新闻放量 | `s=+1` 当 `c[t] ≥ 1` **且** `c[t] > 1.5 × mean(c[t−20..t−1])`;否则 `s=0` | 事件型·放量 |
| `newsDrought` | 新闻沉寂 | `s=−1` 当 `sum(c[t−19..t]) == 0`;否则 `s=0` | 事件型·沉寂 |
| `newsFlowState` | 新闻流状态 | `r20 = sum(c[t−19..t])/20`,`r60 = sum(c[t−59..t])/60`;`s=+1` 当 `r20 > r60`,`s=−1` 当 `r20 < r60`,相等记 `s=0`(不入样) | 连续型·加速度 |

伪码(实现必须与此逐行对应,不许「等价改写」):

```
c[t] = |{ 新闻行 r : r 属于本票的 News.csv 且 bucket(r.date) == t }|      # bucket 见 M.5

newsBurst(t):
    if t < 20: return 0
    m = (c[t-20] + c[t-19] + ... + c[t-1]) / 20
    if c[t] >= 1 and c[t] > 1.5 * m: return +1
    return 0

newsDrought(t):
    if t < 19: return 0
    if (c[t-19] + ... + c[t]) == 0: return -1
    return 0

newsFlowState(t):
    if t < 59: return 0
    r20 = (c[t-19] + ... + c[t]) / 20
    r60 = (c[t-59] + ... + c[t]) / 60
    if r20 > r60: return +1
    if r20 < r60: return -1
    return 0
```

**三个指标里的每一个数字都不是在这份数据上挑的:**
`1.5×` 与 `20 日均值`直接抄 J 组 `breakoutVol` 的量能确认口径(那里写着「1.5× 是量能确认最常见的写法」);
`20 / 60` 这一对直接抄 J 组 `maState`,而 `maState` 又是抄 `src/js/sim/rules.js` 里 `trendBuy` 已经在用的那一对。
**没有一个新的自由度被引进来。** 这是刻意的:情绪面本来就是自由度最泛滥的一轨,
唯一能让它不泛滥的办法是连一个新常数都不许出现。

**明确不测**(写下来是为了将来有人问「怎么不试试」时有个出处):
标题关键词词典(理由见上)、按 `ids` 里代码个数加权的「新闻广度」(它是 M.6 那个跨票相关问题的
另一种形式,拿它当指标等于把偏差当信号)、新闻计数的 z-score 标准化(标准化要一个窗口长度,
那是第四个自由度)、任何「计数 × 词典符号」的交叉项。

### M.4 每个指标声明的到底是什么

与 K.4 同一个句式,三个指标是同一句话的三个实例:

> **在 `s≠0` 的那些交易日上,未来 h 日对数收益的符号等于 `s`,其频率高于在同一段可入场区间里
> 随便挑同样多天、按同样的方向多空配比去猜的频率。**

方向从哪来,逐条交代,**跑完不许改**:

- **`newsBurst` 声明 `s=+1`。** 外部读法:注意力效应(Barber–Odean 2008,「All that glitters」)——
  被新闻集中报道的票在短周期内承接净买入压力。这是三条里外部依据最硬的一条,也是主检验选它的原因(M.8)。
- **`newsDrought` 声明 `s=−1`。** 这是 `newsBurst` 的**镜像假设**:没有注意力就没有注意力驱动的买盘。
  **必须老实说:这条的外部依据比 burst 弱得多**,它更像是「为了对称」而不是「文献这么说」。
  我仍然把方向写死在这里,是因为唯一比「依据弱」更糟的做法,是跑完看见符号再决定方向 ——
  那不是弱依据,那是没有依据。跑出来 `z ≤ −临界值`,结果是 `inverted`,是一个**结果**,
  不是「那就反过来用」的许可;反过来用要另开一次预注册,并且在新数据上跑。
- **`newsFlowState` 声明 `s=+1` 当 `r20 > r60`。** 同一个注意力读法的连续形式:
  近 20 日的新闻流密度高于近 60 日的,说明关注度在上升。结构上它是 `maState` 的新闻版。

前瞻期 **h ∈ {5, 21, 63}**,就是 `PX_HORIZONS` 那三个刻度,不新造口径。
热身 **W = 120 根**,与 `SIM_WARM`、`testBands`、J 组 `J_WARM` 对齐(`newsFlowState` 要 60 根计数历史,
120 盖得住,而且四处热身长度一致才好对账)。可入场根的区间是 `[W, len−1−h]`,与 `simControl`、J 组同一口径。
未来 h 日对数收益 `r = ln(close[t+h]/close[t])`,`r == 0`(平盘)的那一天**不进任何分母**,与 J 组同一条规则。

### M.5 对齐规则与前瞻污染:新闻日 → 交易日,**严格向后一天**

这是这一节最容易出事的地方,单开一小节。本项目栽过一次同型的跟头:期权墙没按 `asof` 过滤,
回放到六周前读到的是六周后才登记的数据,导致规则「处处应验」。
新闻这里的坑一模一样,而且更隐蔽 —— 新闻有日期,看起来天然带 as-of,但**同一天的新闻不一定在收盘前**。

数据里的标题带着 `(~9:45ET)` 这类时刻碎片,但它既不是一列、也不是每条都有,更没有时区保证。
既然分不清盘中与盘后,就不许猜。归属规则按**最保守**的写:

> **`bucket(D) = min{ t : tradingDate(t) > D }`** —— 发布日期为 `D` 的一条新闻,
> 归属到**第一个日期严格晚于 D 的交易日**。找不到这样的 t(新闻晚于最后一根日线)则整条丢弃。

这条规则的三个直接后果,都是想要的:

1. **`c[t]` 里的每一条新闻,发布日期都严格小于 `date(t)`。** 于是在 t 日收盘做决策时,
   用到的信息全部是**昨天及以前**已经公开的。盘中/盘后之分不再重要,因为两者都被推到了下一根。
   代价是牺牲了半天到一天的时效 —— 这个代价是故意付的:**宁可信号迟一天,不可让它早一秒。**
2. **周末与节假日的新闻自动向后滚。** 周六/周日/节假日发布的条目落到下一个交易日,
   不需要单独的假日表,也不会被静默丢掉。(本语料里周六 30 条、周日 120 条,占约 7.5%,不是可忽略量。)
3. **最后一根日线之后发布的新闻被丢弃。** 语料到 2026-08-06,日线到 2026-08-04/05,
   于是最后一两天的新闻不进任何 `c[t]`。这是对的:它们对应的未来收益也不存在。

实现上必须有一条断言把这条规则钉死:构造出 `c[]` 之后,**逐票核对每一条被计入 `c[t]` 的新闻,
其 `date` 严格 < `date(t)`**;有一条不满足就是前瞻污染,自检必须 FAIL 而不是打印警告。

### M.6 一条新闻挂多只票:跨票相关怎么处理

`ids` 列是一条新闻涉及的一串代码(例如 `"AMZN-US,AVGO-US,GOOGL-US,NVDA-US,0NWJ69-E"`),
于是**同一条新闻会同时出现在多只票的 CSV 里**。在参与 K 组的 8 只票上,
按 `(date, headline)` 去重后可以数出这个比例:约 **503 / 1816 = 27.7%** 的行是共享行。

这件事有两个不同的后果,必须分开处理,不能用一句话糊过去:

**后果一,对计数的影响 —— 不做任何处理,这是正确的。**
「今天关于 NVDA 的新闻有几条」这个量,本来就该把一条同时提到 NVDA 和 AMZN 的新闻算进 NVDA。
把它按 `1/k` 折价、或者只留独家新闻,都是在回答另一个问题。所以 `c[t]` 用**原始行数**,不加权、不去重。

**后果二,对有效样本的影响 —— 必须处理,而且只能往保守的方向处理。**
27.7% 的共享意味着 NVDA 的触发日和 AMZN 的触发日不是独立的两份证据:
同一条新闻可能同时把两只票推进处理臂。按票聚类的 `effN` 把它们数成两条,是**高估**。
它同时也污染留一标的折 —— 留出 NVDA 时,训练折里的 AMZN 带着同一条新闻,那一折不是干净的样本外。

处理方式,写死在这里:

1. **定义共享率** `ρ_share = |{参与票的新闻行 r : (r.date, r.headline) 在 ≥2 只参与票下出现}| / |参与票的全部新闻行|`。
   这个数**每轮从语料重新算**,不是常数;今天它是 0.2770。它作为一行 `recorded` 进台账,
   将来语料变了,读账的人能看出闸门是在什么共享率下判的。
2. **C1 用折价后的有效样本**:`effN_used = floor( min(effN处理, effN对照) × (1 − ρ_share) )`,
   闸门是 `effN_used ≥ 30`。今天的折价系数是 0.7230。
3. **老实交代这是什么**:`(1 − ρ_share)` 是一个**保守近似**,不是精确的方差修正。
   精确修正需要知道每条共享新闻的跨票收益相关系数,那要另做一整套估计,而估计本身又是自由度。
   选这个近似的唯一理由是它的**误差方向是确定的**:它只会让 C1 更难过,不会让 C1 更好过。
   一条判据如果只能错,那就让它往「不敢发结论」的方向错。
4. **C2 / C3 的污染不做修正,只声明方向。** 留一折里的跨票泄漏会让样本外 skill **偏高**。
   于是:**C2/C3 没过,是干净的失败**(在被污染成偏好看的条件下都没过);
   **C2/C3 过了,不算干净的成功**,届时第一件事是回头看这一格的触发日里有多少挂着共享新闻,
   而不是宣布指标有效。这个不对称与 K.8 里 `inverted` 那个不对称同源:**举证责任在「要发结论」的那一边。**

### M.7 闸门:四条判据,并联,全过才算过

与 K.5 逐条同构,阈值也一样 —— 情绪面不配拿一套比技术面松的尺子:

| # | 判据 | 内容 | 不过的后果 |
|---|---|---|---|
| **C1** | 有效样本 | `effN_used = floor(min(effN处理, effN对照) × (1 − ρ_share)) ≥ 30`。`effN` = 贪心不重叠计数(同 `simEffN` / J 组 `jEffN`:按时间排序,下一次触发距上一次 ≥ h 才算新证据) | `inconclusive`。**样本不足永远不给证伪的权利,更不给 `falsified`** |
| **C2** | 样本外信息量 | 折 = 标的(留一标的,上限 10 折;本轮实际 8 折,因为只有 8 只票)。模型 = 训练折上按状态 `s` 拟合的 `P(涨|s)`;基准 = 训练折上**全部可入场日**的无条件 `P(涨)`(气候基准)。结算集 = 留出折里 `s≠0` 的那些日子。要求 **OOS Brier skill > 0** | `inconclusive` |
| **C3** | 折间稳定 | 各折 skill 的均值 − `t(k−1)·sd/√k` **> 0**。临界值走 `tCrit95(df)`,不是 1.96 | `inconclusive` |
| **C4** | 效应量 | 处理臂命中率 vs **同频随机对照**臂命中率的两比例 z(合并 p,分母用各臂 `min(n, effN)`,与 `simZ` / `simPropZ` 同一个式子)。要求 **z ≥ 临界值**(见 M.8) | `inconclusive`;若 **z ≤ −临界值** 则 `inverted` |

**同频随机对照怎么造**(与 K.5 逐字同款,换成新闻指标):
逐标的,数出处理臂声明「涨」的天数 k₊ 与声明「跌」的天数 k₋,
在同一只票、同一段可入场区间 `[W, len−1−h]` 里**不放回**抽 k₊+k₋ 个互不相同的日子,
洗牌后前 k₊ 个派「涨」、其余派「跌」。种子由 `FNV-1a(ticker|指标id|h)` 派生,固定不可挑。
对照臂不看任何指标,它回答的是「这段行情里随便挑同样多天、按同样的多空配比猜,会对多少」。

**为什么基线必须是同频随机而不是 50%,这一条本仓库付过学费:**
J 组 `breakout55` 的 63 日,处理臂 74.2%,同频随机对照臂 **95.5%** —— 对照赢了 21 个百分点。
拿 50% 当基线,74.2% 看起来是个漂亮信号;拿同频随机当基线,它是「随便挑同样多的日子都比它强」。
这一年是单边上行年,无条件 5 日胜率 52.4%,50% 这条线会让一堆东西「跑赢」,而它们赢的是行情。

`newsFlowState` 这一格与 K.5 里 `maState` 同理:它几乎天天有非零状态,于是 k₊+k₋ ≈ 可入场天数,
抽出来的集合**就是处理臂自己那批日子**,只有方向标签被打乱 —— 那正好是一次标签置换检验,
是这九格里对照最干净的一格。`newsDrought` 是单向的(只声明 `s=−1`),
于是它的对照臂全部派「跌」,回答的是「在这段行情里随便挑同样多天做空会对多少」——
在单边上行年里这个数会很低,而那正是它该比的对手。

**退化闸门(照搬 B2 / K.5)**:对照臂 `effN` 不足处理臂 30% → 判 `degenerate_control`,z 不发布。
按上面的造法它不该退化;真退化了,是抽样写错了,不是数据的问题。

**没有可靠性图那一条**,理由与 K.5 一字不差:指标是 k≤3 个状态的,10 桶里必然有 7 个以上空桶,
而 G 组注释里写着「空桶本身就是警报」—— 那条警报在这里会**结构性地**响,毫无信息。
换成**状态表**:逐个状态打印样本数、样本外平均预测、实际涨幅频率、偏差。
状态表**只记不判**(`recorded`),不设门槛 —— 再给它安一个门槛就是凭空多一个没依据的数字。

### M.8 多重比较:家族是 9 格,一个主检验,其余走 Bonferroni

3 个指标 × 3 个前瞻 = **9 格,这就是家族全集**,不多不少。

- **主检验(confirmatory),恰好一格:`newsBurst` @ h=5。** 临界值 **|z| ≥ 2.00**(不校正)。
  单个事先指定的假设不需要校正,用 2.00 而不是 1.96 只是与全仓库其它组对齐。
  选它的理由是**先验**:注意力效应是三条里唯一有像样外部文献的一条(M.4),
  而该效应在文献里就是一个**短周期**现象(天到两周),h=5 是三个刻度里唯一对得上的。
  **必须说清一件事,因为它看起来像在挑功效**:h=5 恰好也是三行里样本预算最宽的一行(M.9)。
  这是巧合,不是理由 —— 证据是我**没有**把主检验放在 `newsFlowState` @ h=5 上,
  而那一格的 effN 会是 `newsBurst` @ h=5 的好几倍(前者几乎天天触发,后者是事件型)。
  按功效挑,主检验就该是 flowState@5;我放弃了那一格,选了文献对得上的那一格。
- **其余 8 格(exploratory):Bonferroni,临界值 |z| ≥ 2.78。**
  α=0.05,m=**9**(把主检验也算进分母 —— 少算一格能把临界值降到 2.77,这种便宜不占,
  而且「声明一个主检验来缩小 m」本身就该被堵死)。
  双侧,每尾 0.05/9/2 = 0.002778;Φ(−2.78) = 0.002718 ≤ 0.002778,取 2.78 略偏保守。
  (Φ(−2.77) = 0.002803 > 0.002778,不够,所以不是 2.77。)
- **m 为什么把 h=63 也算进去**:与 K.6 同一个理由。h=63 在 1 年数据上是死格(M.9:折价后 effN 上限 11 < 30,C1 必挂),
  按理可以不测、把 m 降到 6(临界 2.64)。不这么做,是因为这张矩阵要在 5 年数据上**原样重跑**,
  而 h=63 在 5 年上是活格。家族必须覆盖**这张矩阵将来会报出来的每一格**,
  否则 5 年那一跑就得换一个 m,两次的数字也就不再可比。
- **K 组的 9 格不并入 J 组的 12 格算一个 m=21 的大家族。** 理由:两组测的是不同的声明、
  用的是不同的输入,而且 J 组已经跑完并记进台账了 —— 事后把别人的家族扩大,
  等于回头改 J 组的临界值,那是 K.9 第 1 款明令禁止的。代价是全仓库层面的族错误率比 5% 大,
  这一点写在这里,不藏:**J 组 12 格 + K 组 9 格,两族各自控制在 5%,合起来不是 5%。**
- **`newsBurst` 与 `newsFlowState` 谁更强,不构成第 10 格。** 两者共用同一批新闻、高度重叠,
  比较它俩是又一次比较,而 m 没给它留位置。只记录两格各自的 z,不做差、不判语。

### M.9 样本预算与 MDE:哪些格子今天就没救

8 只票 × 252 根;可入场根数 `span = 252 − 120 − h`;贪心不重叠的独立数 = `floor((span−1)/h)+1`,再 × 8 只票;
再乘 M.6 的折价系数 `(1 − ρ_share) = 0.7230`。
MDE 按两臂等量、p≈0.55 的两比例检验算:`MDE = z* × sqrt(2·p(1−p)/effN)`。

| 前瞻 | span/票 | 折价前 effN 上限 | 折价后 effN 上限 | MDE@2.00 | MDE@2.78 |
|---|---|---|---|---|---|
| h=5 | 127 | 208 | **150** | 11.5pp | 16.0pp |
| h=21 | 111 | 48 | **34** | 24.1pp | 33.5pp |
| h=63 | 69 | 16 | **11** | 42.4pp | 59.0pp |

上表是**天天触发**的指标(只有 `newsFlowState`,而且只在它两侧都有状态时)才拿得到的上限。
事件型的两个要再乘触发率:`newsBurst` 是「今天的条数超过近 20 日均值 1.5 倍」,
在一份平均每票每年只有一两百条新闻的语料上,估计触发率一两成;
`newsDrought` 是「连续 20 个交易日一条新闻都没有」,对 GOOGL / NVDA 这种几乎天天有新闻的票**可能一次都不触发**,
对 ASML(全年 65 条)则会触发很多 —— 也就是说这一格的样本会**高度集中在两三只票上**,
而按票聚类的折间稳定(C3)对这种集中最不友好。

**读这张表得出的四件事,现在就写下来:**

1. **h=63 今天就是死格**,折价后 effN 上限 11 < 30,C1 必挂,是算术不是运气。它照跑照记,5 年重跑时才有话说。
2. **h=21 只有 34 的上限**,只有 `newsFlowState` 有机会摸到,而它要求 33.5pp 的效应量 —— 过不去。
3. **h=5 那一行是唯一有一点功效的**,而主检验那一格(`newsBurst` @ h=5)因为触发率的关系
   拿不到 150 这个上限。真实的情绪效应量级,文献上是个位数 pp;11.5pp 这条线,一年数据上过不去。
4. **C3 才是真正卡死这一轨的那条,不是 C1。** 附录 K 那一轮的教训写得很清楚:
   J 组 12 格里 C1 过了 4 格,而 **C3 折间一致性和 C4 效应量 0 格通过**,CV 下界最深到 −28.40。
   原因是按票聚类只有 10 折。**K 组只有 8 折**,`tCrit95(7) = 2.365`(J 组 10 折是 `tCrit95(9) = 2.262`),
   折数更少、临界 t 更大、`sd/√k` 的分母更小 —— 三样都朝坏的方向走。

### M.10 预注册预期:我预计会得到什么,为什么

**一句话:9 格全部 `inconclusive`,零格 `holds`,零格 `inverted`。**

理由按可能性排:(i) C3 会挂满 9 格 —— 8 折、`t(7)=2.365`、按票聚类的 skill 方差在这种样本量上
必然大到把下界压到 0 以下,这在 J 组已经发生过一次,而 K 组的折数更少;
(ii) C4 会挂满 9 格 —— 需要 11.5~59pp 的效应,而情绪面的真实效应量级是个位数 pp;
(iii) C1 会挂掉 h=63 全部三格,以及事件型指标在 h=21 的两格;
(iv) `newsDrought` 可能在 GOOGL / NVDA 这类票上一次都不触发,若某一格**所有** 8 只票都不触发,
那一格判 `no_signal` 而不是 `inconclusive`(两者要做的事不一样:样本少要等历史变长,一次没触发要先问指标是不是写错了)。

**这句话写在这里是为了让它可以被推翻。** 真跑出一格 `holds`,先验上更可能是实现里有未来函数
而不是情绪面真的有这么大效应 —— 届时第一件事是回头查 M.5 那条 `bucket(D) > D` 的截断和它的断言,
不是发新闻。**全部 `inconclusive` 不是失败,那就是这份数据能给出的正确答案。**

### M.11 判语词表

沿用 `tools/backtest.mjs` 现有词表(那里写着「加词可以,改词不行」)。K 组用到的是:

| 判语 | 含义 |
|---|---|
| `holds` | C1–C4 全过,方向与 M.4 声明一致 |
| `inverted` | C1 过,且 z ≤ −临界值(**不要求 C2/C3**,理由同 K.8:举证责任在「要发结论」的那一边) |
| `inconclusive` | 样本不足,或 C2/C3/C4 任一未过 |
| `no_signal` | 整段历史该指标在**所有**参与票上一次都没触发 |
| `degenerate_control` | 对照臂 effN 不足处理臂 30% |
| `recorded` | 状态表、OOS skill、共享率 `ρ_share` 这三类辅助记录 |

**K 组不产生 `falsified`**,一格都不产生:9 格里没有任何一格的功效撑得起「证伪」这两个字。
这是 M.1 第 3 条的直接后果,也是 3.9 兜底条款那个已知缺口(它只给了 `pending` / `falsified` 两个词)
在这一轨的处理方式 —— 与 K.8 同款,不去补 3.9(SPEC 只许追加),在这里把用到的词一次列全。

**不需要新词。** `no_signal` 与 `pending_no_ohlc` 是 J 组加的,`no_signal` 这一轨正好用得上;
`pending_no_ohlc` 与情绪面无关。**SPCX(有新闻没日线)和 QQQ/SPY(有日线没新闻)不产生任何一行台账** ——
它们不是「测不出来」,是根本不在这个矩阵的定义域里,给它们发一个判语是在假装测过。
这两件事只在终端印一行盘点,不进 CSV。

### M.12 兜底条款

1. **M.3 那三行指标定义、M.5 的对齐规则、M.6 的折价公式、M.7 那四条判据、M.8 那两个临界值(2.00 / 2.78),
   跑完之后一个字符都不许动。** 任何一格判为「未过」时,不得为了让它过而回头改指标定义、
   改计数窗口、改 1.5 这个倍数、改前瞻期、改临界值,也不得改 `ρ_share` 的定义或把折价去掉。
2. **不许加第四个指标。** 看完 9 格再想「要不要也试试新闻广度 / 词典 / 标准化计数」,那就是在用结果挑候选;
   要加,下一轮预注册,并且 m 从头重算。**也不许事后补一个关键词词典** —— M.3 已经把这条路的理由写死了。
3. **5 年数据(或语料变长之后)原样重跑同一条命令 `node tools/backtest.mjs`**,不改任何门槛。
   届时新增的行按 `run_date` 与今天这一跑并排躺在 `Assets/_logs/backtest-history.csv` 里,
   谁在哪一轮翻的判语,一眼看得见。`ρ_share` 那一行会跟着变 —— 它本来就该跟着语料变,
   这正是把它记进台账而不是写成常数的原因。
4. K 组里那三个指标函数,是它们在本仓库的**规范定义**。将来任何一格过了闸、真画到面板上,
   渲染层必须调同一套公式,并且要有一条断言把两处钉在一起 —— 否则画的和验收的不是同一个东西
   (与 K.9 第 4 款同款;这是 4.3 那类静默事故最容易复发的地方)。
5. **M.5 那条前瞻断言不许降级成警告。** 它 FAIL 就是 FAIL:一条早了一天的新闻不会让任何数字变成 NaN,
   它只会让所有数字变好看一点点,而这正是本项目在期权墙上栽过的那一跤。
