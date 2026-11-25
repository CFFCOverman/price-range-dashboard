# console · 控制台

> 本文件是 `console/` 的唯一大脑文件。读写的数据位置与字段见 `schema/README.md`。

## L0 · 人 ↔ 系统
你:双击仓库根的 `console.bat`(或 `npm run console`),浏览器打开 `http://127.0.0.1:5179`。
- **价位与估值**:选标的,看压力/支撑价位图、一年前瞻估值的两个锚与交叉核对
- **标的**:增删改,保存到 G 盘 `config/universe.csv`(先自动备份旧清单)
- **运行**:拉取到期项 + 计算、只重算、强制重拉选中标的、登录;每个数据集最后一次成功/失败
- **交接**:最新交接包的编号、变化与各标的摘要;新增读数(新闻条数、修订、目标价、券商变动、空头、修订广度);Research OS 的采集需求单(只读,要不要加采集由你决定)
系统:只监听本机;要拉数据时启动 `collect/run.mjs` 子进程,同一时间只跑一个。

## 文件
| 文件 | 做什么 |
|---|---|
| `server.mjs` | 本机 HTTP 服务与 API(`/api/overview` `universe` `status` `symbol` `handoff` `requests` `run`) |
| `universe.mjs` | 标的清单校验(纯函数) |
| `public/` | 页面:`index.html`、`app.js`、`app.css` |
