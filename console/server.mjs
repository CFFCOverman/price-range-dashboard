#!/usr/bin/env node
/**
 * 控制台(本机网页)。只监听 127.0.0.1。
 *   node console/server.mjs   → 浏览器打开 http://127.0.0.1:5179
 * 读写的东西都在 G 盘(schema/README.md):config/universe.csv、_state/、derived/、handoff/;只读 config/os-requests-*.json(Research OS 写的采集需求单)。
 * 不碰 FactSet:要拉数据时启动 collect/run.mjs 子进程,同一时间只跑一个。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadParams, loadUniverse, ensureUniverse, UNIVERSE_FILE, STATE_DIR, DERIVED_DIR, HANDOFF_DIR, OUT_DIR, ROOT, LIVE_CONFIG_DIR } from '../collect/lib/config.mjs';
import { toCsv, atomicWrite, loadState } from '../collect/lib/store.mjs';
import { validateUniverse, UNIVERSE_COLS } from './universe.mjs';

const PORT = Number(process.env.PRD_CONSOLE_PORT || 5179);
const URL_HOME = `http://127.0.0.1:${PORT}`;
/** 服务起来后才开浏览器(之前 bat 先开浏览器、服务还没监听 → 拒绝连接);重启时不重复开 */
function openBrowser() {
  if (process.env.PRD_CONSOLE_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL_HOME]] : process.platform === 'darwin' ? ['open', [URL_HOME]] : ['xdg-open', [URL_HOME]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
}
/* 任何漏网的异常只记日志,不让服务退出(服务一退,刷新就是「拒绝连接」) */
process.on('uncaughtException', e => console.error('[控制台] 未捕获异常:', e?.stack || e));
process.on('unhandledRejection', e => console.error('[控制台] 未处理的 Promise 拒绝:', e?.stack || e));
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/* ---------- 运行子进程(同一时间一个) ---------- */
let job = null;   // {id, cmd, started_at, finished_at, code, log[]}
function startJob(steps) {
  if (job && job.code === undefined) throw new Error('已有任务在跑,等它结束再启动');
  job = { id: Date.now().toString(36), cmd: steps.map(s => s.join(' ')).join(' && '), started_at: new Date().toISOString(), log: [] };
  const run = (i) => {
    if (i >= steps.length) { job.code = 0; job.finished_at = new Date().toISOString(); return; }
    const p = spawn(process.execPath, steps[i], { cwd: ROOT, env: process.env });
    p.on('error', e => { job.log.push(`启动失败:${e.message}`); job.code = 1; job.finished_at = new Date().toISOString(); });
    const push = d => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) job.log.push(l); if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000); };
    p.stdout.on('data', push); p.stderr.on('data', push);
    p.on('close', code => { job.log.push(`— ${steps[i].join(' ')} 结束,退出码 ${code}`); if (code && i < steps.length - 1 && steps[i][0].includes('collect')) { /* 拉取有失败仍然继续计算 */ } run(i + 1); });
  };
  run(0);
  return job;
}

/* ---------- 路由 ---------- */
const routes = {
  'GET /api/overview': () => {
    const params = loadParams();
    return { out_dir: OUT_DIR, universe_file: UNIVERSE_FILE, kinds: Object.keys(params.scope), datasets: Object.keys(params.datasets),
      cadence: Object.fromEntries(Object.entries(params.datasets).map(([k, v]) => [k, v.cadence + (v.manual ? '(手动)' : '')])) };
  },
  'GET /api/universe': () => ({ cols: UNIVERSE_COLS, rows: loadUniverse() }),
  'PUT /api/universe': (body) => {
    const params = loadParams();
    const { rows, errors } = validateUniverse(body.rows || [], Object.keys(params.scope));
    if (errors.length) return { status: 400, body: { errors } };
    ensureUniverse();
    const hist = path.join(STATE_DIR, 'universe-history');
    fs.mkdirSync(hist, { recursive: true });
    fs.copyFileSync(UNIVERSE_FILE, path.join(hist, `${new Date().toISOString().replace(/[:.]/g, '-')}.csv`));
    const comments = fs.readFileSync(UNIVERSE_FILE, 'utf8').split(/\r?\n/).filter(l => l.startsWith('#'));
    atomicWrite(UNIVERSE_FILE, toCsv(UNIVERSE_COLS, rows) + (comments.length ? comments.join('\n') + '\n' : ''));
    return { saved: rows.length };
  },
  'GET /api/status': () => {
    const state = loadState(STATE_DIR);
    return { state, last_run: readJson(path.join(STATE_DIR, 'last-run.json')) };
  },
  'GET /api/handoff': () => readJson(path.join(HANDOFF_DIR, 'latest.json')),
  'GET /api/requests': () => {
    let files = []; try { files = fs.readdirSync(LIVE_CONFIG_DIR).filter(f => /^os-requests-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
    const f = files.at(-1);
    return f ? { file: f, ...readJson(path.join(LIVE_CONFIG_DIR, f)) } : null;
  },
  'GET /api/symbol': (_, q) => {
    const s = String(q.get('s') || '').toUpperCase();
    return { levels: readJson(path.join(DERIVED_DIR, 'levels', `${s}.json`)), valuation: readJson(path.join(DERIVED_DIR, 'valuation', `${s}.json`)) };
  },
  'POST /api/run': (body) => {
    const steps = [];
    const sym = body.symbols?.length ? [`--symbols=${body.symbols.join(',')}`] : [];
    if (body.kind === 'collect' || body.kind === 'all') steps.push(['collect/run.mjs', ...(body.force ? ['--force'] : []), ...(body.only ? [`--only=${body.only}`] : []), ...sym]);
    if (body.kind === 'process' || body.kind === 'all') steps.push(['process/run.mjs']);
    if (body.kind === 'login') steps.push(['collect/login.mjs']);
    if (!steps.length) return { status: 400, body: { error: 'kind 只能是 collect / process / all / login' } };
    const j = startJob(steps);
    return { id: j.id, cmd: j.cmd };
  },
  'GET /api/run': () => job ? { ...job, running: job.code === undefined } : { running: false },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (status, obj, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(obj) : obj); };
  try {
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      let body = {};
      if (req.method !== 'GET') { let raw = ''; for await (const c of req) raw += c; body = raw ? JSON.parse(raw) : {}; }
      const out = await routes[key](body, url.searchParams);
      return out && out.status ? send(out.status, out.body) : send(200, out ?? null);
    }
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) return send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
    send(404, { error: 'not found' });
  } catch (e) { if (!res.headersSent) send(500, { error: String(e.message || e) }); else res.end(); }
});
server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`端口 ${PORT} 已被占用:控制台可能已经开着,直接打开 ${URL_HOME}`); openBrowser(); setTimeout(() => process.exit(0), 500); }
  else { console.error('[控制台] 服务出错:', e); process.exit(1); }
});
server.listen(PORT, '127.0.0.1', () => { console.log(`控制台:${URL_HOME}  (数据目录 ${OUT_DIR})`); openBrowser(); });
