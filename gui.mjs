// Simple control panel for bot.mjs:   node gui.mjs   (opens http://127.0.0.1:3777 in your browser)
// Only reachable from this computer. Every request must carry the random token in the page URL.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(DIR, 'config.json');
const CREDS = path.join(DIR, 'credentials.json');
const PORT = Number(process.env.PORT || 3777);
const TOKEN = crypto.randomBytes(16).toString('hex');

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

// ---------- bot process ----------
let bot = null, botMode = '', caffeinate = null;
const lines = [];
const clients = new Set();

function emit(text, kind = 'log') {
  const line = { text, kind };
  lines.push(line);
  if (lines.length > 800) lines.shift();
  for (const res of clients) res.write(`data: ${JSON.stringify(line)}\n\n`);
}
const state = () => ({ running: !!bot, mode: botMode });
const pushState = () => { for (const res of clients) res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`); };

function startBot(mode, extra = []) {
  if (bot) throw new Error(`The bot is already running (${botMode}). Stop it first.`);
  bot = spawn(process.execPath, ['bot.mjs', mode, ...extra], { cwd: DIR, stdio: ['pipe', 'pipe', 'pipe'] });
  botMode = mode + (extra.length ? ' ' + extra.join(' ') : '');
  caffeinate = spawn('caffeinate', ['-i', '-w', String(bot.pid)], { stdio: 'ignore' }); // keep the Mac awake
  emit(`── started: ${botMode} ──`, 'sys');
  for (const stream of [bot.stdout, bot.stderr]) {
    let buf = '';
    stream.on('data', d => {
      buf += d;
      const parts = buf.split('\n'); buf = parts.pop();
      parts.filter(Boolean).forEach(t => emit(t));
    });
  }
  bot.on('exit', code => {
    emit(`── stopped: ${botMode} (exit ${code ?? 'killed'}) ──`, 'sys');
    bot = null; botMode = ''; caffeinate?.kill(); pushState();
  });
  pushState();
}

// ---------- http ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b ? JSON.parse(b) : {})); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(res, 403, { error: 'bad host' });
  if (url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
  if ((req.headers['x-token'] || url.searchParams.get('t')) !== TOKEN) return send(res, 403, { error: 'bad token' });

  try {
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const c = readJson(CREDS, {});
      return send(res, 200, { config: readJson(CONFIG, {}), credsSaved: !!(c.id_card && c.password), state: state() });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const cfg = { ...readJson(CONFIG, {}), ...(await body(req)) };
      fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
      emit('Settings saved.', 'sys');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/creds' && req.method === 'POST') {
      const { id_card = '', password = '' } = await body(req);
      const cur = readJson(CREDS, {});
      fs.writeFileSync(CREDS, JSON.stringify({ id_card: id_card || cur.id_card || '', password: password || cur.password || '' }, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(CREDS, 0o600);
      emit('Login details saved to credentials.json.', 'sys');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/start' && req.method === 'POST') {
      const { mode } = await body(req);
      const modes = { login: ['login'], check: ['check'], dry: ['run', '--dry-run'], run: ['run'] };
      if (!modes[mode]) return send(res, 400, { error: 'unknown mode' });
      startBot(modes[mode][0], modes[mode].slice(1));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      if (bot) { emit('Stopping…', 'sys'); bot.kill('SIGTERM'); }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/finish' && req.method === 'POST') {
      bot?.stdin.write('\n');   // answers the bot's "Press Enter once you are finished" prompt
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log(`Booking bot control panel: ${link}\n(keep this terminal open; Ctrl+C quits)`);
  if (!process.env.NO_OPEN) execFile('open', [link], () => {});
});

process.on('SIGINT', () => { bot?.kill('SIGTERM'); process.exit(0); });

// ---------- page ----------
const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phu Kradueng Booking Bot</title>
<style>
  :root { --bg:#f4f6f5; --card:#fff; --ink:#1d2621; --mute:#66736b; --line:#dfe5e1; --accent:#2f7d4f; --accent-ink:#fff;
          --warn:#b3261e; --logbg:#0f1714; --logink:#cfe9d6; --ok:#7ee2a0; --bad:#ff8a80; --sys:#8fb3ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111614; --card:#18201c; --ink:#e4ece7; --mute:#93a199; --line:#2a352f; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  header { padding:18px 24px 6px; } h1 { margin:0; font-size:20px } header p { margin:4px 0 0; color:var(--mute) }
  main { display:grid; grid-template-columns:360px 1fr; gap:16px; padding:16px 24px 24px; }
  @media (max-width:860px) { main { grid-template-columns:1fr } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:16px }
  .card h2 { margin:0 0 10px; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--mute) }
  label { display:block; font-size:12px; color:var(--mute); margin:8px 0 3px }
  input, select { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font:inherit }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:10px }
  .hint { font-size:12px; color:var(--mute); margin-top:8px }
  .opens { margin-top:10px; padding:8px 10px; border-radius:6px; background:var(--bg); font-size:13px }
  button { font:inherit; padding:8px 12px; border-radius:7px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer }
  button:disabled { opacity:.45; cursor:default }
  button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); font-weight:600 }
  button.danger { color:var(--warn); border-color:var(--warn) }
  .save { margin-top:12px; width:100% }
  .controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center }
  .controls .primary { padding:10px 18px; font-size:15px }
  #status { margin-left:auto; font-size:13px; color:var(--mute) } #status b { color:var(--ink) }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; background:#999; margin-right:6px; vertical-align:middle }
  .dot.on { background:#2fbf63; box-shadow:0 0 0 3px rgba(47,191,99,.25) }
  #log { background:var(--logbg); color:var(--logink); font:12px/1.55 Menlo,Consolas,monospace; border-radius:10px; padding:12px 14px;
         height:calc(100vh - 230px); min-height:320px; overflow:auto; white-space:pre-wrap; word-break:break-word }
  #log .grab { color:var(--ok); font-weight:600 } #log .bad { color:var(--bad); font-weight:600 } #log .sys { color:var(--sys) }
  .banner { display:none; margin-bottom:12px; padding:10px 14px; border-radius:8px; background:#fff3cd; color:#5c4300; border:1px solid #f0d58a; font-weight:600 }
</style></head>
<body>
<header><h1>Phu Kradueng Booking Bot</h1><p>Summit houses (Zone 1, Wang Kwang) · nps.dnp.go.th</p></header>
<main>
  <section>
    <div class="card">
      <h2>Booking</h2>
      <div class="row">
        <div><label>Check-in</label><input type="date" id="check_in"></div>
        <div><label>Check-out</label><input type="date" id="check_out"></div>
      </div>
      <div class="opens" id="opens"></div>
      <label>Houses, in priority order</label><input id="houses" placeholder="111/1, 111/2, 111/3, 111/4">
      <div class="row">
        <div><label>How many houses</label><input type="number" min="1" id="max_houses"></div>
        <div><label>Payment</label><select id="pay_method">
          <option value="bank">Krungthai counter / ATM (by 20:00)</option>
          <option value="office">DNP office (by 16:30)</option></select></div>
      </div>
      <label>Booked for (guest name, optional)</label><input id="book_for" placeholder="Leave blank = account holder">
      <div class="row">
        <div><label>Check every (s) at opening</label><input type="number" min="1" id="poll_every_seconds"></div>
        <div><label>Check every (s) otherwise</label><input type="number" min="1" id="idle_poll_seconds"></div>
      </div>
      <button class="save" id="saveCfg">Save settings</button>
      <div class="hint">Max 3 nights per booking. No refunds after payment.</div>
    </div>
    <div class="card">
      <h2>Login <span id="credState"></span></h2>
      <label>ID card number (เลขบัตรประชาชน)</label><input id="id_card" autocomplete="off">
      <label>Password</label><input type="password" id="password" autocomplete="new-password">
      <button class="save" id="saveCreds">Save login</button>
      <div class="hint">Stored only on this Mac in credentials.json. You still tick the reCAPTCHA at every login.</div>
    </div>
  </section>
  <section>
    <div class="banner" id="banner">Houses are in the cart. Go to the bot's Chrome window, tick the reCAPTCHA and press บันทึก within 10 minutes.</div>
    <div class="card controls">
      <button class="primary" data-mode="run">▶ Start bot</button>
      <button data-mode="check">Check availability</button>
      <button data-mode="dry">Dry run</button>
      <button data-mode="login">Log in</button>
      <button class="danger" id="stop">■ Stop</button>
      <button id="finish" title="Closes the bot's Chrome window after you have saved the booking">Done – close bot window</button>
      <span id="status"></span>
    </div>
    <div id="log"></div>
  </section>
</main>
<script>
const T = new URLSearchParams(location.search).get('t');
const api = (p, data) => fetch(p, { method: data ? 'POST' : 'GET', headers: { 'x-token': T, 'Content-Type': 'application/json' },
  body: data ? JSON.stringify(data) : undefined }).then(r => r.json());
const $ = id => document.getElementById(id);
const fields = ['check_in','check_out','max_houses','pay_method','book_for','poll_every_seconds','idle_poll_seconds'];
const nums = ['max_houses','poll_every_seconds','idle_poll_seconds'];

function showOpens() {
  const ci = $('check_in').value, co = $('check_out').value;
  if (!ci) return $('opens').textContent = '';
  const open = new Date(Date.parse(ci + 'T00:00:00Z') - 59 * 864e5);
  const nights = co ? (Date.parse(co) - Date.parse(ci)) / 864e5 : 0;
  const fmt = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  $('opens').innerHTML = 'Booking opens <b>' + fmt(open) + '</b> (probably 00:00 Bangkok) · ' +
    (nights >= 1 && nights <= 3 ? nights + ' night' + (nights > 1 ? 's' : '') : '<span style="color:var(--warn)">stay must be 1–3 nights</span>');
}
['check_in','check_out'].forEach(id => $(id).addEventListener('input', showOpens));

async function load() {
  const { config: c, credsSaved } = await api('/api/config');
  fields.forEach(f => { if (c[f] !== undefined) $(f).value = c[f]; });
  $('houses').value = (c.houses || []).join(', ');
  $('credState').textContent = credsSaved ? '· saved ✓' : '· not saved';
  showOpens();
}
$('saveCfg').onclick = async () => {
  const cfg = {}; fields.forEach(f => cfg[f] = nums.includes(f) ? Number($(f).value) : $(f).value);
  cfg.houses = $('houses').value.split(/[\\s,]+/).filter(Boolean);
  await api('/api/config', cfg);
};
$('saveCreds').onclick = async () => {
  await api('/api/creds', { id_card: $('id_card').value.trim(), password: $('password').value });
  $('id_card').value = ''; $('password').value = ''; load();
};
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = async () => {
  if (b.dataset.mode === 'run' && !confirm('Start the real bot? It will put houses in your cart when they appear.')) return;
  $('banner').style.display = 'none';
  const r = await api('/api/start', { mode: b.dataset.mode }); if (r.error) alert(r.error);
});
$('stop').onclick = () => api('/api/stop', {});
$('finish').onclick = () => api('/api/finish', {});

const log = $('log');
const es = new EventSource('/events?t=' + T);
es.onmessage = e => {
  const { text, kind } = JSON.parse(e.data);
  const div = document.createElement('div'); div.textContent = text;
  if (kind === 'sys') div.className = 'sys';
  else if (/>>>|would have reserved|In cart/.test(text)) div.className = 'grab';
  else if (/WARNING|LOGGED OUT|error|Error|Nothing grabbed/.test(text)) div.className = 'bad';
  if (/Tick the captcha|tick "I'm not a robot", press/.test(text)) $('banner').style.display = 'block';
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(div); if (atBottom) log.scrollTop = log.scrollHeight;
};
es.addEventListener('state', e => {
  const s = JSON.parse(e.data);
  $('status').innerHTML = '<span class="dot' + (s.running ? ' on' : '') + '"></span>' + (s.running ? 'Running: <b>' + s.mode + '</b>' : 'Idle');
  document.querySelectorAll('[data-mode]').forEach(b => b.disabled = s.running);
  $('stop').disabled = $('finish').disabled = !s.running;
});
load();
</script>
</body></html>`;
