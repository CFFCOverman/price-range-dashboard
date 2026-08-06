# 换新机器 / 别人第一次 clone · Setup on a new machine

Author: Xuhao Chao · License: MIT

这份文档回答一个问题:**在一台干净的 Windows 机器上,从零到绿要做什么。**
答案现在只有一步:**双击仓库根目录的 `setup.bat`**。下面把它会做什么、会在哪两处停下来问你、
出错时屏幕上那句原文对应哪条命令,全部写清楚。

命令和报错一律保留原文,不翻译 —— 你要拿它去对屏幕上的字。

---

## 0. 先看这一条:先确认这份 clone 是完整的

**这是"新环境跑不起来"的头号原因,而且没有任何工具能修它 ——**
**如果别人 clone 到的是一份残缺快照,连 `setup.bat` 都不在里面,后面整份文档都用不上。**

这一节**不写死数字**。上一版文档里那些"跟踪了 N 个文件、最后一次 commit 是 xxxxxxx"是某次会话里
现查出来的,而 Cowork 这边的工作副本**根本不是 git 仓库**(`git ls-files` 在这里直接报
`fatal: not a git repository`),没法复核。照抄一个复核不了的数字,只会把过期信息钉进文档。
**以你自己终端里跑出来的为准:**

```
cd <你的仓库根目录>
git log --oneline -1                # 最后一次提交停在哪
git ls-files | wc -l                # 一共跟踪了几个文件(Windows cmd 没有 wc,用 git ls-files ^| find /c /v "")
```

判据不是"数字够不够大",而是**这几样东西在不在版本库里**:

```
git ls-files | grep -E "^(setup\.bat|package\.json|tools/setup\.mjs|src/|tests/|docs/)"   # bash
git ls-files | findstr /R "^setup.bat ^package.json ^tools/setup.mjs ^src/ ^tests/ ^docs/" & rem Windows cmd
```

上面这条要能同时列出 `setup.bat`、`package.json`、`tools/setup.mjs`、`src/` 下的文件、
`tests/` 下的文件。**少任何一样,别人 clone 到的都是残缺快照:**

| 少了什么 | 别人那边的症状 |
|---|---|
| `setup.bat` | 根目录压根没有那个可以双击的文件,这份文档第 1 节无从谈起 |
| `tools/setup.mjs` | 双击 `setup.bat` 停在 `[ERROR] tools\setup.mjs is missing next to this file.` |
| `package.json` | 任何 npm 命令都是 `npm error code ENOENT ... package.json` |
| `src/` | 没有源码,`npm run build` 无从谈起,构建校验那步必红 |
| `tests/` | 没有 `npm test` |

`npm run doctor` 的第六项会替你看一部分:它检查 `package.json`、`tests/`、`tools/`、`src/`
有没有进版本库,没进就报一条黄字并给出该敲的命令。**但它的名单里没有 `setup.bat`**
(而且 `tools/` 只要有任意一个文件在就算过),所以上面那条 `git ls-files` 还是得你自己扫一眼。

### 怎么修

只能**你自己在你自己的终端里**跑(Cowork 这边不代跑 git 写操作,这是项目的既定约束)。
提交前先确认忽略清单确实在拦授权数据:

```
cd <你的仓库根目录>
git status --short                 # 先看一眼,不要闭着眼睛 git add -A
git status --short | grep Assets   # 应该没有任何输出;有输出就先别提交,回去查 .gitignore
```

确认干净之后:

```
git add -A
git commit -m "v18: setup.bat、tools/、src/、tests/、docs/ 与 package.json 入库"
git push
```

`Assets/`、`*.xlsx`、`*.xls`、`*.csv`(两份 `*_template.csv` 除外)由 `.gitignore` 挡着,
**FactSet 导出一个字节都不许提交**。

---

## 1. 主线:双击 `setup.bat`

仓库根目录下的 **`setup.bat`**,双击它,完事。不用先装 Node、不用开命令行、不用 `cd`。

它是 ASCII + CRLF 写的(和 `run-factset.bat` 同样的理由:cmd.exe 按当前控制台代码页解析 .bat,
中文会被搞乱,LF 结尾会让多行 `if (` 块直接语法错)。所有中文都由它调起的 Node 脚本打印。

### 1.1 它依次做什么

前两件事由 `setup.bat` 自己做,`[n/5]` 那五步由 `tools/setup.mjs` 做:

| 顺序 | 做什么 | 大概多久 |
|---|---|---|
| 找 Node | 先 `where node`,找不到再探 `%ProgramFiles%\nodejs\`、`%ProgramW6432%\nodejs\`、`%ProgramFiles(x86)%\nodejs\`、`%LOCALAPPDATA%\Programs\nodejs\` 四个标准安装目录 | 瞬间 |
| (缺 Node 时)装 Node | **停下来问你一句**,答应了就 `winget install -e --id OpenJS.NodeJS.LTS`;可能弹 UAC(那是安装程序,不是这个脚本)。装完会接住 winget 的退出码:装成功但 PATH 没刷新、和"UAC 被拒/没权限",给的是两句不同的话 | 几分钟,看网速 |
| 交棒前补 PATH | 把找到的 `node.exe` 所在目录塞进**本进程**的 PATH(`setlocal` 里改,不动系统)。刚装完 Node 的那个窗口 PATH 还是旧的,而下一步要用的 `npm.cmd` 是靠 PATH 找的 —— 少这一下,新机器第一次跑必然 ENOENT | 瞬间 |
| `[1/5]` 依赖 | 探 `node_modules` 里有没有 `playwright`、`xlsx`;缺了才 `npm install --no-audit --no-fund`,装完还会**复查一遍包是不是真在了** | 已齐:秒级(打印"已就绪,跳过 npm install");首装:几分钟,看网速 |
| `[2/5]` chromium | **停下来问你一句**;要装就 `node node_modules/playwright/cli.js install chromium` | 装:几分钟(脚本自己标的是"约 150MB");不装:瞬间 |
| `[3/5]` 体检 | 跑 `tools/doctor.mjs`,node 版本 / 依赖 / 浏览器 / 授权数据 / 当前目录 / git 六项 | 秒级(这边实测不到 1 秒) |
| `[4/5]` 构建校验 | 跑 `tools/build.mjs --check`,对 `src/` 与两份交付 HTML 是否同步 | 秒级(这边实测不到 1 秒) |
| `[5/5]` 全套测试 | 跑 `tests/test-app.mjs`,无头 chromium 端到端断言 | Linux 沙箱实测 6 秒上下;Windows 首跑要冷启动浏览器会慢些,仍是秒到十几秒的量级 |

**断言条数、体检项的具体输出,这份文档一律不贴** —— 那些会随版本变,贴了就会过时。
**以命令自己打印的为准。**

一步失败就**停在那一步**,后面的步骤不跑。理由写在脚本注释里:`npm install` 挂了还去跑测试,
只会再叠一屏无关的红字,把真正的死因埋掉。所以**从上往下第一条 `✗` 就是死因**。

它是**幂等**的:第二次、第十次双击都安全,已经就绪的步骤原地报"已就绪"就走,不重装、不重下。

### 1.2 会停下来问你的,只有两处

**第一处(只在这台机器没有 Node 时才出现):**

```
  Node.js was not found on this machine.
  The dashboard HTML works without it, but tests, backtests
  and the FactSet fetcher all need it.

  Install Node.js LTS now with winget? Type y to install [y/N]
```

- **要装就得敲一个 `y`(或 `yes`)再回车**;直接回车、敲别的、或者根本没人在键盘前,一律当"不装"。
  这一处和下面 chromium 那处的默认值是反的,不是笔误:`.bat` 里的 `set /p` 在 stdin 走到头
  (被管道调起、`< nul`、CI runner)时**根本不赋值**,和人按了回车在脚本内部长得一模一样,
  分不出来。分不出来的时候,宁可少装一个安装包,也不能背着人装。
  chromium 那处跑在 Node 里,能直接看 TTY,所以敢让回车 = 装。
- 答"不装":屏幕上留一句 `Nothing installed (anything other than "y" means no).`,
  退出码 0 —— 这是你自己的选择,不算失败。
- 机器上没有 winget(它随 Windows 11 和较新的 Windows 10 版本一起来):脚本不会硬闯,
  直接让你去 <https://nodejs.org/en/download> 手动装,装完重新双击 `setup.bat`。
- winget 装失败(最常见是 UAC 那个框被点掉,或者这个账号不许装软件):会明说是这个原因,
  给两条路 —— 右键 `setup.bat` → "以管理员身份运行",或者去官网手动装。
  **不会**跟你说"PATH 还没刷新,重开窗口再试"—— 那句话在这种情况下是错的,照做只会再被拒一次。

**第二处(chromium):**

```
  要装抓数据用的 chromium 吗?约 150MB,不装也不影响仪表盘和测试。[Y/n]
```

- 同样是回车 = 装;`n` / `no` / `否` = 不装,中文的 `是` / `好` / `要` 也认。
- 不装**不算失败**,只是这一步记成"跳过",汇总行会说清"跳过的都是你自己选的,不影响仪表盘"。
- 装失败了**也不算失败** —— 它只挡抓数据,仪表盘和测试照跑,脚本会记一条跳过继续往下走,
  并告诉你回头单独重试:`npx playwright install chromium`。

除了这两句,它不会背着你下载或改动任何东西。没有 TTY 的环境(比如 CI 里管道调起)
所有提问一律按"不"处理 —— 要在 CI 里装浏览器,得显式加 `--yes`。

### 1.3 跑完之后

最后一行是一句汇总,三种措辞对应三种结局:全绿 / 有跳过 / 有失败(有失败时它会明说
"上面第一条 ✗ 就是死因,后面的步骤没跑")。全绿时下面还会列出接下来能干的事。

退出码:**0** = 没有失败的步骤(有跳过也算 0);**1** = 有步骤失败;
**2** = 你敲了它不认识的参数(见 2.2)。窗口结束时会 `pause` 停住,让你把上面的字读完 ——
不想它停(比如从别的脚本里调),加 `--no-pause`。

### 1.4 什么都不想装,只想看仪表盘

**那就别跑 `setup.bat`,直接双击 `price-range-dashboard.html`。**
(`index.html` 是同一份内容,只是给 GitHub Pages 用的名字。)

用 Chrome 或 Edge 打开,点 **载入演示数据 / Load demo data**,或者把自己的 FactSet 导出拖进去。
不需要 Node、不需要 npm、不需要联网、不需要服务器 —— 交付物是零依赖单文件 HTML,
解析与计算全在浏览器本地完成。

**大多数"新环境"其实只需要这一条。** `setup.bat` 是给要跑测试、改代码、跑回测、抓数据的人用的。

---

## 2. 命令行用法

### 2.1 三条常用的

```
npm run setup                                 # = node tools/setup.mjs,和双击 setup.bat 走的是同一套五步
node tools/setup.mjs --yes --no-browser --skip-test
                                              # 一句不问、不下浏览器、不跑测试:只把依赖装好就收工
npm run setup:selftest                        # = node tools/setup.mjs --selftest,纯函数自检,不下载、不 spawn、不碰真仓库
```

`npm run setup` 要传参数得多一个 `--`(npm 的规矩):`npm run setup -- --no-browser`。
嫌绕就直接敲 `node tools/setup.mjs --no-browser`。

**`npm run setup` 和双击 `setup.bat` 的区别只有一个:** `setup.bat` 会先替你找 / 装 Node,
`npm run setup` 前提是你已经有 Node 和 npm 了。五步内容完全一样。

### 2.2 全部开关(以 `node tools/setup.mjs --help` 打印的为准)

| 开关 | 干嘛 |
|---|---|
| (无参数) | 按步骤准备,要下载的东西会先问一句 |
| `--yes` / `-y` | 所有提问都当"是"(CI 用;**会下 chromium**) |
| `--no-browser` | 不装 chromium(只看仪表盘、只跑测试的话用这个最快);它**压过** `--yes` |
| `--skip-test` | 准备完不跑第 5 步的测试 |
| `--selftest` | 纯函数自检,不下载、不 spawn、不碰真仓库 |
| `--help` / `-h` | 打印用法 |
| `--no-pause` / `--nopause` | 给 `setup.bat` 用的:结束时不 `pause`。`setup.mjs` 认下它但不做事 |

**打错的开关会当场红,不会被静默忽略。** 比如 `--skip-tests`(真名是 `--skip-test`)会得到:

```
不认识这些参数:--skip-tests
  没有静默忽略,是怕你以为它生效了。可用的:--yes / --no-browser / --skip-test / --selftest / --help
```

退出码 2。这是故意的 —— 静默吞掉一个拼错的开关,你会以为自己跳过了测试,然后对着跑起来的测试发懵;
CI 里写错 `--yes` 的拼法则会让脚本卡在提问上直到超时。

`setup.bat` 把它收到的参数**原样透传**给 `setup.mjs`,所以 `setup.bat --no-browser --skip-test`
也是成立的(在命令行里敲,或者做个带参数的快捷方式)。

---

## 3. 要跑回测 / 抓数据 —— 额外一步

### 数据为什么不在仓库里

`Assets/` 下的东西是 **FactSet 导出 —— 授权市场数据**,`.gitignore` 里 `Assets/` 整个目录被挡掉了,
外加任意位置的 `*.xlsx` / `*.xls` / `*.csv` 也一并挡住。

**所以任何一份新克隆一定没有数据。这是设计如此,不是仓库坏了。** 后果:

| 命令 | 没有数据时会怎样 |
|---|---|
| `npm test` | 依赖真实数据的那一段跳过,其余照跑 —— 正常,`setup.bat` 第 5 步也是这个状态 |
| `npm run backtest` | **根本没东西可回放** —— 得先有数据 |
| 打开仪表盘 | 用 **载入演示数据** 照样能看,只是不是你的公司 |

`setup.bat` 的第 3 步体检会把这条报成一句黄字("没有 Assets/charting(新克隆的正常状态)"),
**它不挡事**,不影响准备完成。

### 怎么把数据弄进来

```
npm run fetch                 # 跑一轮 FactSet 抓取
```

Windows 上更省事:双击**仓库根目录**的 **`run-factset.bat`**(等价于 `npm run fetch`,
它会自己 `cd` 进 `fetcher/`,首跑还会在那里把依赖装好)。

**抓数据需要你自己登录 FactSet。**

```
npm run fetch:login           # 弹出浏览器,你手动登录一次,登完关窗口
```

登录状态保存在本机,之后不用再登。**这里绝不自动登录、绝不代填凭据** ——
账号密码任何时候都只经过你自己的手和你自己的浏览器,不进仓库、不进日志、不进这边的会话。

抓完的文件按类型落在 `Assets/estimates|charting|targets|news|options|summary/` 下,
日志在 `Assets/_logs/`。仪表盘用 **Connect folder** 直接指向 `Assets/` 就能整个扫进去。

**抓下来的东西一个字节都不许提交。** 见第 0 节那条 `git status --short | grep Assets`。

---

## 4. 症状 → 原因 → 一条命令

屏幕上的原文照抄进第一列。`setup.bat` / `setup.mjs` 的话在前半张表,通用的在后半张。

### 4.1 双击 `setup.bat` 之后

| 症状(屏幕上的原文) | 原因 | 敲这一条 / 怎么办 |
|---|---|---|
| `[ERROR] Could not switch to the folder this file lives in:` … `A network path (\\server\share) does not work here.` | 仓库放在 UNC 网络路径上,cmd.exe 的 `cd /d` 进不去 | 把仓库整个复制到本地盘(比如 `C:\`)再双击 |
| `Node.js was not found on this machine.` 然后 `Install Node.js LTS now with winget? Type y to install [y/N]` | 这台机器没装 Node,这不是错误,是那两句提问之一 | 敲 `y` 回车 = 用 winget 装;别的(含直接回车)= 不装,仪表盘照看 |
| `winget is not available on this machine (it ships with Windows 11 and recent Windows 10 builds).` | 系统太老 / winget 没装 | 去 <https://nodejs.org/en/download> 手动装 LTS,装完重新双击 `setup.bat` |
| `[ERROR] winget could not install Node.js (exit code …)` | winget 退了非零码,且事后也没在标准目录里找到 node.exe。绝大多数是 UAC 那个框被点掉,或这个账号不许装软件 | 右键 `setup.bat` → "以管理员身份运行";或去 <https://nodejs.org/en/download> 手动装 LTS |
| `Node.js still not visible from this window.` … `close this window, open a new one, and run setup.bat again.` | winget **退 0** 说自己装好了,但装到了脚本没探的地方 —— 这个窗口的 PATH 也还是旧的 | 关掉这个窗口,**新开一个**,再双击 `setup.bat` |
| `[ERROR] Found node.exe but it will not run:` | 找到了 node.exe 但它起不来(装坏了 / 架构不对) | 从 <https://nodejs.org/en/download> 重装 Node.js LTS |
| `[ERROR] tools\setup.mjs is missing next to this file.` | 这份 clone 是残缺的(第 0 节) | 由仓库作者 `git add -A && git commit && git push`;你这边要一份完整的 |
| `Nothing installed (anything other than "y" means no).` | 第一句提问你没敲 `y`(直接回车也算没敲) | 不是错误,退出码 0。要跑测试就再双击一次、这回敲 `y` |
| `[1/5]` 报 `npm install 没成功` 且带 `ENOENT` | 找不到 npm 本身。双击 `setup.bat` 进来的话这条基本不该出现(它交棒前会把 node 目录补进 PATH);如果出现了,多半是你在一个手工开的旧窗口里直接 `npm run setup` | **新开一个**命令行窗口,或直接双击 `setup.bat` |
| `[1/5]` 报 `npm install 说自己成功了,但 … 还是不在 node_modules 里` | npm 缓存坏了(退 0 但包没落地) | `npm cache clean --force` 然后重跑一次准备 |
| `[2/5]` 报 `chromium 没装成` | 下载失败;**这只记跳过,不算失败** | 回头单独重试:`npx playwright install chromium` |
| `[2/5]` 报 `找不到 node_modules/playwright/cli.js` | 依赖那步像是没真装上 | `npm install` 后重跑,或直接 `npx playwright install chromium` |
| `[3/5]` 报 `体检有必修项` | doctor 里有 `✗` | 照 doctor 每条 `✗` 下面那句"怎么修"敲,修完重跑 |
| `[4/5]` 报 `src/ 与交付的 HTML 不一致` | 有人改了 `src/` 没重新构建,或者直接改了产物 HTML | `npm run build`(先确认不是有人手改了两份 HTML) |
| `[5/5]` 报 `测试有红` | 真是测试挂了,不是环境问题 | 照每条 FAIL 打印的实际值查;单独重跑 `npm test` |
| `不认识这些参数:…` | 开关拼错了(比如 `--skip-tests`) | 照它列出来的可用开关改;退出码 2 |
| `准备脚本自己出错了` | 这是 `setup.mjs` 的 bug,不是你机器的问题 | 绕开它:`npm install` 然后 `npm test` |
| 窗口一闪而过,什么都没看清 | 有人给它传了 `--no-pause` | 去掉那个参数,或者先开 `cmd`、`cd` 到仓库再敲 `setup.bat` |

### 4.2 手动敲命令时

| 症状(屏幕上的原文) | 原因 | 敲这一条 |
|---|---|---|
| `npm error code ENOENT ... open 'C:\Users\pinyo\package.json'` | 不在仓库根目录 | `cd <仓库根目录>`,确认能 `dir package.json` |
| `cd` 对了还是上面那条 | `package.json` 没提交(第 0 节) | 由仓库作者 `git add -A && git commit && git push` |
| `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from .../tests/test-app.mjs` | 依赖没装(`Did you mean to import "playwright/index.js"?` 是误导,别理) | `npm install`,或直接双击 `setup.bat` |
| `browserType.launch: Failed to launch chromium because executable doesn't exist at ...` | 浏览器没下 | `npx playwright install chromium` |
| 同上,但你不想再下一份浏览器 | 想复用本机已有的 Chrome | 设 `PLAYWRIGHT_EXECUTABLE_PATH=<chrome 路径>` 再跑 |
| 体检报 `PLAYWRIGHT_EXECUTABLE_PATH 指着一个不存在的路径` | 这个变量一旦有值,测试就**无条件**用它、不回退 | 先清掉:`set PLAYWRIGHT_EXECUTABLE_PATH=`(bash 用 `unset`),再 `npx playwright install chromium` |
| `ENOENT: no such file or directory, scandir '.../Assets/charting'` | 没有授权数据,新克隆的正常状态 | 不用修;要数据就 `npm run fetch`(先 `npm run fetch:login`) |
| `npm run backtest` 说没东西可回放 | 同上,`Assets/` 是空的 | `npm run fetch` |
| `npm test` 第一组就红,说产物与 `src/` 不同步 | 改完 `src/` 忘了构建 | `npm run build` |
| node 太老 / 装依赖时报 engine 不满足 | `playwright ^1.61` 要求 node ≥ 18,18 已 EOL | 升到 LTS 20+(实测只验过 22.x) |
| 说不清哪里不对 | —— | `npm run doctor`,它会逐项告诉你并给出该敲的命令 |

---

## 5. 附录:手动一步步来

**什么时候需要这一节:**

1. `setup.bat` 自己挂了,你要绕开它;
2. 你不在 Windows 上(macOS / Linux 没有 .bat 入口,只有 `npm run setup` 和下面这几条);
3. 你想知道那五步到底在干什么 —— 下面就是它逐条替你敲的东西。

**正常情况下不用读这一节。** 第 1 节那一步就够了。

### 5.1 装 Node.js

```
node -v
npm -v
```

- 实测环境:**node v22.22.2 / npm 10.9.7**。这份文档里的每一条**只在 22.x 上实测过**,
  别的版本没验过,这里不假装验过。
- 下限:`playwright ^1.61` 要求 node ≥ 18,但 **18 已经 EOL**,所以建议直接上 LTS 20 或更新。
- 没装的话去 <https://nodejs.org/en/download> 拿 LTS 安装包;`node -v` 打不出版本号就是没装好 / 没进 PATH。
- 刚装完 Node,**已经开着的命令行窗口不会有新 PATH** —— 关掉,重开一个。

### 5.2 `cd` 到仓库根目录

判据很简单:**这个目录下能看到 `package.json` 和 `setup.bat`**。

```
cd <你的仓库根目录>
dir package.json        # Windows
ls package.json         # macOS / Linux
```

在错的目录下敲 npm 会得到这个(这条是实际踩过的):

```
npm error code ENOENT
npm error syscall open
npm error path C:\Users\pinyo\package.json
npm error errno -4058
npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open 'C:\Users\pinyo\package.json'
```

**修法:先 `cd` 到仓库根目录再敲。** 如果 `cd` 对了还是这个报错,那是第 0 节那个坑 ——
`package.json` 根本没提交上去,你这份 clone 里就没有它。

### 5.3 `npm install`(= `setup.mjs` 的第 1 步)

```
npm install
```

装的是 `package.json` 里声明的两个 devDependencies:`playwright` 和 `xlsx`。
成功时 npm 会打一行 `added N packages in ...`,目录下多出 `node_modules/`。

没装依赖就跑 `npm test`,得到的是这个:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright' imported from .../tests/test-app.mjs
Did you mean to import "playwright/index.js"?
```

最后那句 `Did you mean to import "playwright/index.js"?` 是 node 的好心建议,**纯误导** ——
问题不是 import 路径写错了,是这个包压根没装。**修法:`npm install`。**

### 5.4 `npx playwright install chromium`(= 第 2 步)

```
npx playwright install chromium
```

装的是浏览器本体,和上一步装的 npm 包是两回事 —— 包装好了浏览器仍然可能没下。
实测这一步下下来的是 **Chrome for Testing 149.0.7827.55**,落在:

```
C:\Users\pinyo\AppData\Local\ms-playwright\chromium-1228
```

没下浏览器就跑测试,报错长这样:

```
browserType.launch: Failed to launch chromium because executable doesn't exist at
C:\Users\pinyo\AppData\Local\ms-playwright\chromium-1228\chrome-win\chrome.exe
```

**修法:`npx playwright install chromium`。**

如果你机器上已经有一份能用的 Chromium / Chrome,又不想再下一份,
`tests/test-app.mjs` 支持用环境变量 `PLAYWRIGHT_EXECUTABLE_PATH` 显式指定:

```
set PLAYWRIGHT_EXECUTABLE_PATH=C:\Path\To\chrome.exe        &  npm test   # Windows cmd
$env:PLAYWRIGHT_EXECUTABLE_PATH="C:\Path\To\chrome.exe";      npm test    # PowerShell
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome npm test                       # bash
```

**这个变量一旦有值,测试就无条件用它、不会回退去找别的浏览器。** 指错了路径,
装多少次 chromium 都没用 —— 体检会专门为这种情况报一条黄字。

### 5.5 `npm run doctor`(= 第 3 步)

```
npm run doctor        # = node tools/doctor.mjs
```

体检工具。它逐项检查 **node 版本、依赖装没装、浏览器下没下、授权数据在不在、当前目录对不对、
git 提交状态**,并且**每条问题都配一条能照抄的命令** —— 它存在的意义就是把
"环境没装好"和"代码坏了"分开,免得你拿着一句生 stack trace 去猜该敲什么。

这份文档**不贴它的输出**:输出会随版本变,贴了就会过时。以它自己打印的为准。

`npm test` 会先跑一遍它的 `--preflight`,所以多数时候你不用单独敲 —— 但环境一有可疑,
先手动跑一次 doctor 比直接看测试红更省事。

**体检只诊断,不动手。** 该装的东西由 `tools/setup.mjs` 装 —— 两者分工不合并,
出问题时才分得清是"检查错了"还是"装错了"。

### 5.6 `npm run build:check`(= 第 4 步)

```
npm run build:check   # = node tools/build.mjs --check,只校验不写文件
```

对 `src/` 和两份交付 HTML 是否同步。红了就是有人改了 `src/` 忘了 `npm run build`,
或者反过来直接手改了产物 HTML。

### 5.7 `npm test`(= 第 5 步)

```
npm test
```

无头 Chromium 端到端断言。成功时每组打一行、最后一行是通过总数;任何一条断言挂掉都会
指名道姓地告诉你是哪一组。**条数以它自己打印的为准。**

**没有授权数据时,依赖真实数据的那一段会被跳过**,并且明说跳过了 —— 那不是失败。
新克隆的机器上就是这个状态(见第 3 节)。

改完 `src/` 记得先 `npm run build`:`npm test` 的第一组断言就是"产物与 `src/` 是否同步",
忘了 build 会直接红在那里,不会静默出错。

---

## 6. 只能你自己在终端做的事

1. **把源码提交上去**(第 0 节)—— `git add` / `git commit` / `git push`。这是唯一真正卡住别人的一条,
   而且任何工具都替不了:Cowork 这边不代跑 git 写操作。**现在这条更要紧了:**
   `setup.bat` 和 `tools/setup.mjs` 没进版本库的话,别人 clone 到的就是一份连一键入口都没有的快照。
2. **登录 FactSet** —— `npm run fetch:login`,手动登。凭据不代填。
3. **清 `_to_delete/`** —— 里面是待删的历史残留,忽略清单已经挡着不会进仓库,
   但磁盘上还占着地方,确认没用了自己删。
