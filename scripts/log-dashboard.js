#!/usr/bin/env node
/* eslint-disable no-console */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const ROOT = path.resolve(__dirname, '..');
const MODE = process.argv[2] || process.env.AEGIS_DASHBOARD_MODE || 'docker';
const PORT = Number(process.env.AEGIS_LOG_DASHBOARD_PORT || process.env.AEGIS_DASHBOARD_PORT || 4010);
const COMPOSE_FILE = process.env.AEGIS_COMPOSE_FILE || 'docker-compose.all.yml';
const LOCAL_LOG_DIR = process.env.AEGIS_LOG_DIR || path.join(ROOT, '.aegis', 'logs');
const MAX_LINES_PER_SERVICE = Number(process.env.AEGIS_DASHBOARD_MAX_LINES || 450);
const HEALTH_PORTS = {
  gateway: 4000,
  'user-management': 4001,
  expense: 4002,
  payroll: 4003,
  reporting: 4004,
  workflow: 4005,
  notification: 4006,
  invoice: 4007,
};
const SERVICES = [
  'gateway',
  'user-management',
  'expense',
  'payroll',
  'reporting',
  'workflow',
  'workflow-worker',
  'notification',
  'notification-worker',
  'invoice',
  'postgres',
  'redis',
  'kafka',
];

const clients = new Set();
const state = {
  mode: MODE,
  startedAt: new Date().toISOString(),
  services: Object.fromEntries(SERVICES.map((svc) => [svc, emptyStats(svc)])),
  lines: Object.fromEntries(SERVICES.map((svc) => [svc, []])),
  health: Object.fromEntries(Object.keys(HEALTH_PORTS).map((svc) => [svc, { status: 'unknown' }])),
};
let logProcess;
let healthTimer;
let statsTimer;

function emptyStats(service) {
  return {
    service,
    lines: 0,
    errors: 0,
    warns: 0,
    requests: 0,
    status2xx: 0,
    status4xx: 0,
    status5xx: 0,
    lastSeen: null,
    lastLevel: 'info',
    durations: [],
  };
}

function ensureService(service) {
  const svc = normalizeService(service);
  if (!state.services[svc]) state.services[svc] = emptyStats(svc);
  if (!state.lines[svc]) state.lines[svc] = [];
  return svc;
}

function normalizeService(value) {
  let svc = String(value || 'unknown').trim();
  svc = svc.replace(/^aegis[-_]/, '');
  svc = svc.replace(/[-_]1$/, '');
  svc = svc.replace(/^aegis_/, '');
  return svc || 'unknown';
}

function detectComposeCommand() {
  if (process.env.AEGIS_COMPOSE_CMD) return process.env.AEGIS_COMPOSE_CMD.split(/\s+/);
  const plugin = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  if (plugin.status === 0) return ['docker', 'compose'];
  return ['docker-compose'];
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function emit(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

function pushLine(service, rawLine) {
  const svc = ensureService(service);
  const parsed = parseLog(rawLine);
  const entry = {
    service: svc,
    ts: parsed.ts || new Date().toISOString(),
    level: parsed.level,
    message: parsed.message,
    raw: rawLine,
    method: parsed.method,
    status: parsed.status,
    durationMs: parsed.durationMs,
    path: parsed.path,
  };

  const lines = state.lines[svc];
  lines.push(entry);
  if (lines.length > MAX_LINES_PER_SERVICE) lines.splice(0, lines.length - MAX_LINES_PER_SERVICE);

  const stats = state.services[svc];
  stats.lines += 1;
  stats.lastSeen = entry.ts;
  stats.lastLevel = entry.level;
  if (entry.level === 'error') stats.errors += 1;
  if (entry.level === 'warn') stats.warns += 1;
  if (typeof entry.status === 'number') {
    stats.requests += 1;
    if (entry.status >= 500) stats.status5xx += 1;
    else if (entry.status >= 400) stats.status4xx += 1;
    else if (entry.status >= 200) stats.status2xx += 1;
  }
  if (typeof entry.durationMs === 'number') {
    stats.durations.push(entry.durationMs);
    if (stats.durations.length > 250) stats.durations.shift();
  }

  emit('log', entry);
}

function parseLog(rawLine) {
  let line = rawLine.trim();
  const parsed = {
    level: /error|fatal/i.test(line) ? 'error' : /warn/i.test(line) ? 'warn' : 'info',
    message: line,
  };

  const jsonStart = line.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const obj = JSON.parse(line.slice(jsonStart));
      const level = obj.level;
      if (level === 50 || level === 60 || /error|fatal/i.test(String(level))) parsed.level = 'error';
      else if (level === 40 || /warn/i.test(String(level))) parsed.level = 'warn';
      else parsed.level = 'info';
      parsed.ts = obj.timestamp || (typeof obj.time === 'number' ? new Date(obj.time).toISOString() : undefined);
      parsed.method = typeof obj.method === 'string' ? obj.method : undefined;
      parsed.status = typeof obj.status === 'number' ? obj.status : undefined;
      parsed.durationMs = typeof obj.durationMs === 'number' ? obj.durationMs : undefined;
      parsed.path = typeof obj.path === 'string' ? obj.path : undefined;
      parsed.message = formatStructuredMessage(obj, parsed, line);
      return parsed;
    } catch {
      // fall through to text parsing
    }
  }

  const status = line.match(/\bstatus[=: ]+(\d{3})\b/i) || line.match(/\bHTTP[ /](\d{3})\b/i);
  if (status) parsed.status = Number(status[1]);
  const duration = line.match(/\bdurationMs[=: ]+(\d+(?:\.\d+)?)\b/i) || line.match(/\b(\d+(?:\.\d+)?)ms\b/i);
  if (duration) parsed.durationMs = Number(duration[1]);
  return parsed;
}

function formatStructuredMessage(obj, parsed, fallback) {
  const message = obj.msg || obj.message;
  if (message === 'request' && parsed.method && parsed.path) {
    const status = typeof parsed.status === 'number' ? ` -> ${parsed.status}` : '';
    const duration = typeof parsed.durationMs === 'number' ? ` ${parsed.durationMs}ms` : '';
    return `${parsed.method} ${parsed.path}${status}${duration}`;
  }
  if (message && typeof parsed.status === 'number' && parsed.path) {
    const duration = typeof parsed.durationMs === 'number' ? ` ${parsed.durationMs}ms` : '';
    return `${message} ${parsed.path} -> ${parsed.status}${duration}`;
  }
  return message || fallback;
}

function consumeChunk(decoder, serviceHint, chunk, carryRef) {
  const text = decoder.write(chunk);
  const combined = carryRef.value + text;
  const parts = combined.split(/\r?\n/);
  carryRef.value = parts.pop() || '';
  for (const part of parts) {
    if (!part.trim()) continue;
    const { service, line } = splitComposeLine(part, serviceHint);
    pushLine(service, line);
  }
}

function splitComposeLine(line, fallbackService) {
  const match = line.match(/^([^|]+?)\s+\|\s?(.*)$/);
  if (!match) return { service: fallbackService || 'unknown', line };
  return { service: normalizeService(match[1]), line: match[2] };
}

function startDockerLogs() {
  const compose = detectComposeCommand();
  const args = [...compose.slice(1), '-f', COMPOSE_FILE, 'logs', '-f', '--tail=120'];
  logProcess = spawn(compose[0], args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = new StringDecoder('utf8');
  const err = new StringDecoder('utf8');
  const outCarry = { value: '' };
  const errCarry = { value: '' };
  logProcess.stdout.on('data', (chunk) => consumeChunk(out, 'compose', chunk, outCarry));
  logProcess.stderr.on('data', (chunk) => consumeChunk(err, 'dashboard', chunk, errCarry));
  logProcess.on('exit', (code) => {
    pushLine('dashboard', `docker compose logs exited with code ${code}`);
  });
}

function startLocalLogs() {
  fs.mkdirSync(LOCAL_LOG_DIR, { recursive: true });
  for (const service of SERVICES) {
    const file = path.join(LOCAL_LOG_DIR, `${service}.log`);
    fs.closeSync(fs.openSync(file, 'a'));
    const tail = spawn('tail', ['-F', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    const carry = { value: '' };
    tail.stdout.on('data', (chunk) => consumeChunk(decoder, service, chunk, carry));
    tail.stderr.on('data', (chunk) => consumeChunk(decoder, 'dashboard', chunk, carry));
  }
}

function summarizeStats() {
  const services = {};
  for (const [service, stats] of Object.entries(state.services)) {
    const durations = [...stats.durations].sort((a, b) => a - b);
    const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null;
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
    services[service] = { ...stats, durations: undefined, avgDurationMs: avg, p95DurationMs: p95 };
  }
  return { mode: state.mode, startedAt: state.startedAt, services, health: state.health };
}

function pollHealth() {
  for (const [service, port] of Object.entries(HEALTH_PORTS)) {
    const started = Date.now();
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1800 }, (res) => {
      res.resume();
      state.health[service] = {
        status: res.statusCode >= 200 && res.statusCode < 300 ? 'ok' : 'bad',
        code: res.statusCode,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      state.health[service] = {
        status: 'down',
        error: err.message,
        checkedAt: new Date().toISOString(),
      };
    });
  }
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Aegis Live Logs</title>
  <style>
    :root { color-scheme: dark; --bg:#080b10; --panel:#111723; --panel2:#151d2b; --line:#263244; --text:#e8edf6; --muted:#95a3b8; --ok:#3ddc97; --warn:#ffd166; --err:#ff6b6b; --accent:#6ea8fe; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { height: 58px; display:flex; align-items:center; justify-content:space-between; padding:0 18px; border-bottom:1px solid var(--line); background:#0d121b; position:sticky; top:0; z-index:5; }
    h1 { font-size: 17px; margin:0; font-weight:700; }
    .sub { color: var(--muted); font-size: 12px; }
    .tabs { display:flex; gap:8px; align-items:center; }
    button, select { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:7px; padding:8px 10px; cursor:pointer; }
    button.active { border-color: var(--accent); color:#fff; box-shadow: inset 0 0 0 1px rgba(110,168,254,.25); }
    main { padding:14px; }
    .toolbar { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
    .grid { display:grid; grid-template-columns: repeat(3, minmax(280px, 1fr)); gap:12px; align-items:start; }
    @media (max-width: 1120px) { .grid { grid-template-columns: repeat(2, minmax(260px, 1fr)); } }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } header { height:auto; padding:12px; gap:10px; align-items:flex-start; flex-direction:column; } }
    .panel { border:1px solid var(--line); border-radius:8px; background:var(--panel); min-height:260px; overflow:hidden; }
    .panel-head { height:40px; display:flex; align-items:center; justify-content:space-between; padding:0 10px; border-bottom:1px solid var(--line); background:#121927; }
    .name { font-weight:700; }
    .badges { display:flex; gap:6px; align-items:center; }
    .badge { font-size:11px; padding:2px 6px; border-radius:999px; background:#202a3a; color:var(--muted); border:1px solid var(--line); }
    .badge.ok { color:#04130d; background:var(--ok); border-color:var(--ok); }
    .badge.warn { color:#1f1600; background:var(--warn); border-color:var(--warn); }
    .badge.err { color:#250606; background:var(--err); border-color:var(--err); }
    .log { height:300px; overflow:auto; padding:8px 10px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .line { padding:2px 0; border-bottom:1px solid rgba(255,255,255,.03); color:#cfdae9; }
    .line .ts { color:#718098; margin-right:7px; }
    .line.error { color:#ffd0d0; }
    .line.warn { color:#ffe6a3; }
    .cards { display:grid; grid-template-columns: repeat(4, minmax(160px,1fr)); gap:12px; margin-bottom:14px; }
    @media (max-width: 900px) { .cards { grid-template-columns: repeat(2, minmax(150px,1fr)); } }
    .card { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:12px; }
    .metric { font-size:25px; font-weight:800; margin-top:4px; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); }
    th { color:var(--muted); font-weight:600; background:#121927; }
    .hidden { display:none; }
  </style>
</head>
<body>
  <header>
    <div><h1>Aegis Live Logs & Analytics</h1><div class="sub" id="subtitle">connecting…</div></div>
    <div class="tabs"><button id="tabLogs" class="active">Logs</button><button id="tabAnalytics">Analytics</button></div>
  </header>
  <main>
    <section id="logsView">
      <div class="toolbar"><span class="sub">Layout</span><select id="serviceFilter"><option value="all">All services</option></select><button id="clearBtn">Clear visible logs</button></div>
      <div class="grid" id="grid"></div>
    </section>
    <section id="analyticsView" class="hidden">
      <div class="cards">
        <div class="card"><div class="sub">Services Healthy</div><div class="metric" id="healthyMetric">-</div></div>
        <div class="card"><div class="sub">Log Lines</div><div class="metric" id="linesMetric">-</div></div>
        <div class="card"><div class="sub">Errors</div><div class="metric" id="errorsMetric">-</div></div>
        <div class="card"><div class="sub">Requests</div><div class="metric" id="requestsMetric">-</div></div>
      </div>
      <table><thead><tr><th>Service</th><th>Health</th><th>Lines</th><th>Errors</th><th>Warnings</th><th>Requests</th><th>2xx</th><th>4xx</th><th>5xx</th><th>Avg</th><th>P95</th><th>Last seen</th></tr></thead><tbody id="statsRows"></tbody></table>
    </section>
  </main>
  <script>
    const services = ${JSON.stringify(SERVICES)};
    const panels = new Map();
    let latestStats = null;
    const subtitle = document.getElementById('subtitle');
    const grid = document.getElementById('grid');
    const filter = document.getElementById('serviceFilter');

    for (const svc of services) {
      const opt = document.createElement('option'); opt.value = svc; opt.textContent = svc; filter.appendChild(opt);
      const panel = document.createElement('article'); panel.className = 'panel'; panel.dataset.service = svc;
      panel.innerHTML = '<div class="panel-head"><span class="name"></span><span class="badges"><span class="badge health">unknown</span><span class="badge errc">0 err</span></span></div><div class="log"></div>';
      panel.querySelector('.name').textContent = svc;
      grid.appendChild(panel);
      panels.set(svc, { panel, log: panel.querySelector('.log'), health: panel.querySelector('.health'), errc: panel.querySelector('.errc') });
    }

    filter.addEventListener('change', () => {
      for (const [svc, refs] of panels) refs.panel.style.display = filter.value === 'all' || filter.value === svc ? '' : 'none';
    });
    document.getElementById('clearBtn').addEventListener('click', () => {
      for (const refs of panels.values()) refs.log.textContent = '';
    });
    document.getElementById('tabLogs').onclick = () => showTab('logs');
    document.getElementById('tabAnalytics').onclick = () => showTab('analytics');
    function showTab(tab) {
      document.getElementById('logsView').classList.toggle('hidden', tab !== 'logs');
      document.getElementById('analyticsView').classList.toggle('hidden', tab !== 'analytics');
      document.getElementById('tabLogs').classList.toggle('active', tab === 'logs');
      document.getElementById('tabAnalytics').classList.toggle('active', tab === 'analytics');
    }
    function addLine(entry) {
      if (!panels.has(entry.service)) return;
      const refs = panels.get(entry.service);
      const row = document.createElement('div');
      row.className = 'line ' + entry.level;
      const ts = (entry.ts || '').replace('T',' ').replace('Z','');
      row.innerHTML = '<span class="ts"></span><span></span>';
      row.children[0].textContent = ts.slice(11, 23);
      row.children[1].textContent = entry.message || entry.raw;
      refs.log.appendChild(row);
      while (refs.log.childElementCount > 450) refs.log.removeChild(refs.log.firstChild);
      refs.log.scrollTop = refs.log.scrollHeight;
    }
    function setBadge(el, status) {
      el.textContent = status;
      el.className = 'badge health ' + (status === 'ok' ? 'ok' : status === 'unknown' ? '' : 'err');
    }
    function renderStats(snapshot) {
      latestStats = snapshot;
      subtitle.textContent = 'mode: ' + snapshot.mode + ' · started ' + new Date(snapshot.startedAt).toLocaleTimeString();
      let lines = 0, errors = 0, requests = 0, healthy = 0, healthTotal = 0;
      const rows = [];
      for (const svc of Object.keys(snapshot.services).sort()) {
        const s = snapshot.services[svc], h = snapshot.health[svc];
        lines += s.lines || 0; errors += s.errors || 0; requests += s.requests || 0;
        if (h) { healthTotal += 1; if (h.status === 'ok') healthy += 1; }
        if (panels.has(svc)) {
          panels.get(svc).errc.textContent = (s.errors || 0) + ' err';
          panels.get(svc).errc.className = 'badge errc ' + (s.errors ? 'err' : '');
          setBadge(panels.get(svc).health, h ? h.status : 'logs');
        }
        rows.push('<tr><td>' + svc + '</td><td>' + (h ? h.status : 'logs') + '</td><td>' + s.lines + '</td><td>' + s.errors + '</td><td>' + s.warns + '</td><td>' + s.requests + '</td><td>' + s.status2xx + '</td><td>' + s.status4xx + '</td><td>' + s.status5xx + '</td><td>' + (s.avgDurationMs ?? '-') + '</td><td>' + (s.p95DurationMs ?? '-') + '</td><td>' + (s.lastSeen ? new Date(s.lastSeen).toLocaleTimeString() : '-') + '</td></tr>');
      }
      document.getElementById('healthyMetric').textContent = healthy + '/' + healthTotal;
      document.getElementById('linesMetric').textContent = lines;
      document.getElementById('errorsMetric').textContent = errors;
      document.getElementById('requestsMetric').textContent = requests;
      document.getElementById('statsRows').innerHTML = rows.join('');
    }
    fetch('/snapshot').then(r => r.json()).then(s => {
      for (const [svc, lines] of Object.entries(s.lines)) for (const line of lines) addLine(line);
      renderStats(s.stats);
    });
    const events = new EventSource('/events');
    events.addEventListener('log', e => addLine(JSON.parse(e.data)));
    events.addEventListener('stats', e => renderStats(JSON.parse(e.data)));
    events.onerror = () => { subtitle.textContent = 'connection lost; retrying…'; };
  </script>
</body>
</html>`;
}

function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', renderHtml());
  if (url.pathname === '/snapshot') {
    return send(res, 200, 'application/json', JSON.stringify({ stats: summarizeStats(), lines: state.lines }));
  }
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`event: stats\ndata: ${JSON.stringify(summarizeStats())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/stats') return send(res, 200, 'application/json', JSON.stringify(summarizeStats()));
  return send(res, 404, 'text/plain', 'not found');
}

function shutdown() {
  if (healthTimer) clearInterval(healthTimer);
  if (statsTimer) clearInterval(statsTimer);
  if (logProcess) logProcess.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (MODE === 'local') startLocalLogs();
else startDockerLogs();
pollHealth();
healthTimer = setInterval(pollHealth, 4000);
statsTimer = setInterval(() => emit('stats', summarizeStats()), 1500);

http.createServer(handle).listen(PORT, '127.0.0.1', () => {
  console.log(`Aegis log dashboard listening on http://127.0.0.1:${PORT} (${MODE})`);
});
