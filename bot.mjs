// Phu Kradueng summit-house booking helper for nps.dnp.go.th
//
//   node bot.mjs login   – open the bot's Chrome window so you can log in once
//   node bot.mjs check   – list summit houses free right now for the configured dates
//   node bot.mjs run     – wait for the booking window, grab houses, stop at the reCAPTCHA
//
// The bot never ticks the reCAPTCHA, never presses "บันทึก" (Save) and never pays.
// You do those in the browser window within the ~10 minute cart hold.

import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(process.env.BOT_CONFIG || path.join(DIR, 'config.json'), 'utf8'));
// Login details: credentials.json ({"id_card", "password"}) or env DNP_ID_CARD / DNP_PASSWORD.
const credFile = path.join(DIR, 'credentials.json');
const fileCreds = fs.existsSync(credFile) ? JSON.parse(fs.readFileSync(credFile, 'utf8')) : {};
const creds = {
  id_card: process.env.DNP_ID_CARD || fileCreds.id_card || '',
  password: process.env.DNP_PASSWORD || fileCreds.password || '',
};
const SITE = 'https://nps.dnp.go.th';
const PARK = '62';          // อช.ภูกระดึง
const SUMMIT_ZONE = '114';  // โซน 1 วังกวาง (on top of the mountain)
const API = 'creation/module/booking/booking.inc.php';
const BOOKING_WINDOW_DAYS = 59; // on 13 Oct the latest check-in allowed was 11 Dec

// ---------- time helpers (always Bangkok time, whatever the laptop's zone) ----------
const BKK = 7 * 3600e3;
const bkkNow = () => new Date(Date.now() + BKK);                 // read with getUTC*
const fromBkk = (ymd, hm) => new Date(Date.parse(`${ymd}T${hm}:00Z`) - BKK);
const stamp = () => bkkNow().toISOString().slice(11, 19);
const DRY = process.argv.includes('--dry-run');
const logLines = [];
let panelPage = null;
const log = (...a) => {
  const line = `${stamp()} ${a.join(' ')}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 60) logLines.shift();
  showPanel();
};

// Live log panel drawn in the bot's Chrome window (click it to shrink/expand).
function showPanel() {
  panelPage?.evaluate(({ lines, dry }) => {
    let p = document.getElementById('bot-panel');
    if (!p) {
      p = document.createElement('div');
      p.id = 'bot-panel';
      p.title = 'Click to shrink / expand';
      p.style.cssText = 'position:fixed;top:140px;right:12px;width:440px;max-height:45vh;overflow:auto;' +
        'z-index:2147483647;background:rgba(12,18,24,.93);color:#d6f5d6;font:12px/1.5 Menlo,monospace;' +
        'padding:10px 12px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.45);white-space:pre-wrap;cursor:pointer';
      p.onclick = () => { p.dataset.min = p.dataset.min ? '' : '1'; p.style.maxHeight = p.dataset.min ? '22px' : '45vh'; };
      document.body?.appendChild(p);
    }
    p.textContent = `🤖 BOOKING BOT${dry ? '  (DRY RUN – reserves nothing)' : ''}\n` + lines.join('\n');
    p.scrollTop = p.scrollHeight;
  }, { lines: logLines, dry: DRY }).catch(() => {});
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function alarm(text) {
  execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
  execFile('say', [text], () => {});
}

// ---------- config checks ----------
const nights = (Date.parse(cfg.check_out) - Date.parse(cfg.check_in)) / 864e5;
if (!(nights >= 1 && nights <= 3)) {
  console.error(`check_in → check_out is ${nights} nights. The site allows 1–3 nights per booking.`);
  process.exit(1);
}
const openDate = cfg.open_date === 'auto' ? addDays(cfg.check_in, -BOOKING_WINDOW_DAYS) : cfg.open_date;

// "ภูกระดึง 111/1 (หยาดน้ำค้าง)" -> "111/1"
const houseNo = h => (h.name_th || h.home_name || '').replace(/^ภูกระดึง\s*/, '').split(/\s|\(/)[0];
const wantRank = h => {
  const i = cfg.houses.findIndex(w => w === houseNo(h) || w === h.name_th);
  return i === -1 ? (cfg.accept_any_summit_house ? 1000 - Number(h.person || 0) : -1) : i;
};

// ---------- browser ----------
const profile = process.argv[2] === 'watch' ? '.chrome-profile-watch' : '.chrome-profile';
const ctx = await chromium.launchPersistentContext(path.join(DIR, profile), {
  channel: 'chrome', headless: false, viewport: null,
});
const page = ctx.pages()[0] || await ctx.newPage();
panelPage = page;
page.on('load', showPanel);   // redraw the log panel after every page load
page.on('dialog', d => d.accept().catch(() => {}));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Closes the announcement popup (and the first-visit popup) and stops them reopening on this page.
async function dismissPopups() {
  await page.waitForFunction(() => window.$ && window.$.fn && window.$.fn.modal, null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => {
    const ids = '#announcementModal, #modal_firsttime';
    $(document).on('show.bs.modal', ids, e => e.preventDefault());
    $(ids).modal('hide');
    $('.modal-backdrop').remove();
    $('body').removeClass('modal-open');
  }).catch(() => {});
}

// The site sends an incomplete certificate chain, so Chrome sometimes fails with ERR_CERT_AUTHORITY_INVALID
// (or the network drops for a moment). Retry those instead of crashing.
async function gotoRetry(url, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await page.goto(url, { waitUntil: 'domcontentloaded' }); }
    catch (e) {
      if (i >= tries || !/ERR_CERT_|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_|ERR_TIMED_OUT/.test(e.message)) throw e;
      log(`  page load failed (${e.message.match(/net::\S+/)?.[0] || 'error'}) – retrying in 3 s (${i}/${tries - 1})`);
      await sleep(3000);
    }
  }
}

async function openReservation() {
  await gotoRetry(`${SITE}/reservation.php`);
  await page.waitForFunction(() => window.$ && window.$.ajax, null, { timeout: 30000 });
  await dismissPopups();
}

async function loggedIn() {
  // Logged out, the #menu_member toggle reads "เข้าสู่ระบบ"; logged in, it shows the member's name.
  return page.evaluate(() => {
    const t = document.querySelector('#menu_member > a.dropdown-toggle');
    return !!t && !/เข้าสู่ระบบ/.test(t.getAttribute('title') + t.innerText);
  });
}

// Fills the login form from credentials, then waits for you to tick the reCAPTCHA
// (the site keeps the login button disabled until you do) and presses login.
async function ensureLoggedIn() {
  if (await loggedIn()) return true;
  await gotoRetry(`${SITE}/member.php`);
  await dismissPopups();
  if (creds.id_card) await page.fill('#user_idcard', creds.id_card);
  if (creds.password) await page.fill('#user_pass', creds.password);
  alarm('Booking bot needs you to log in. Tick the captcha.');
  log(creds.id_card && creds.password
    ? '>>> LOGIN: tick "I\'m not a robot" in the Chrome window – the bot presses login for you. <<<'
    : '>>> LOGIN: credentials.json is empty – log in by hand in the Chrome window. <<<');
  try {
    if (creds.id_card && creds.password) {
      await page.waitForSelector('#submit:not([disabled])', { timeout: 5 * 60e3 });
      await page.click('#submit');
    }
    await page.waitForFunction(() => {
      const t = document.querySelector('#menu_member > a.dropdown-toggle');
      return t && !/เข้าสู่ระบบ/.test(t.getAttribute('title') + t.innerText);
    }, null, { timeout: 5 * 60e3 });
  } catch { log('Login not completed within 5 minutes.'); }
  await openReservation();
  const ok = await loggedIn();
  log(ok ? 'Logged in.' : 'Still logged out.');
  return ok;
}

async function search() {
  return page.evaluate(async ({ API, PARK, SUMMIT_ZONE, ds, de }) => {
    const r = await $.ajax({
      url: `${API}?mode=Search&${Date.now()}`, type: 'POST', dataType: 'json',
      data: { branch: [PARK], zone: [SUMMIT_ZONE], option: 'home', date_start: ds, date_stop: de, check_oneway: 'N' },
    });
    return (r.home || []).map(h => ({
      code: h.code, branch_code: h.branch_code, name_th: h.name_th, person: h.person,
      date_start: h.date_start, date_stop: h.date_stop, total: h.total,
    }));
  }, { API, PARK, SUMMIT_ZONE, ds: cfg.check_in, de: cfg.check_out });
}

// The site's own latest allowed check-in date (what it shows as "ไม่เกินวันที่ dd/mm/yyyy").
// Search happily lists houses for dates that are not bookable yet, so this is the real "open" signal.
async function latestBookable() {
  const d = await page.evaluate(async ({ API, PARK }) => (await $.ajax({
    url: `${API}?mode=BranchZone&${Date.now()}`, type: 'GET', dataType: 'json', data: { branch_code: PARK },
  })).datelimit, { API, PARK });
  const [dd, mm, yyyy] = String(d).split('/');
  return `${yyyy}-${mm}-${dd}`;
}

// Same request the red "จอง" button sends (me.Select.LoadHome). Puts the house in the cart.
async function addToCart(h) {
  return page.evaluate(async ({ API, h }) => {
    const r = await $.ajax({
      url: `${API}?mode=Select&${Date.now()}`, type: 'POST', dataType: 'json',
      data: { option: 'home', code: h.code, branch_code: h.branch_code, date_start: h.date_start, date_stop: h.date_stop },
    });
    return r.success;
  }, { API, h });
}

async function goToPayment() {
  // Show the cart first (it lists each house, dates and price), then move on to the payment form.
  await gotoRetry(`${SITE}/cart.php`);
  await dismissPopups();
  log('Cart page: check the houses and dates listed here. Opening the payment form in 4 s…');
  await sleep(4000);
  await gotoRetry(`${SITE}/payment.php`);
  await dismissPopups();
  await page.evaluate(({ bookFor, pay }) => {
    if (bookFor) { const b = document.getElementById('book_name'); if (b) b.value = bookFor; }
    const radio = document.getElementById(pay === 'office' ? 'pay_method1' : 'pay_method2');
    if (radio) radio.click();
    document.querySelector('.g-recaptcha, iframe[src*=recaptcha]')?.scrollIntoView({ block: 'center' });
  }, { bookFor: cfg.book_for, pay: cfg.pay_method });
}

function printHouses(list) {
  if (!list.length) return log('  (no summit houses free for these dates)');
  for (const h of list) {
    const r = wantRank(h);
    log(`  ${r >= 0 && r < 1000 ? '★' : ' '} ${h.name_th.padEnd(32)} ${String(h.person).padStart(2)} ppl  ${h.total} THB`);
  }
}

// ---------- modes ----------
const mode = process.argv[2] || 'run';
log(`Stay ${cfg.check_in} → ${cfg.check_out} (${nights} night${nights > 1 ? 's' : ''}). Booking opens ${openDate}.`);

if (mode === 'login') {
  await openReservation();
  if (await ensureLoggedIn()) log('Session saved in .chrome-profile/');
  await ctx.close(); process.exit(0);
}

await openReservation();
if (mode === 'run' && !DRY) await ensureLoggedIn();
else if (mode === 'check' && !await loggedIn()) log('WARNING: this window does not look logged in. Run "node bot.mjs login" first.');

if (mode === 'check') {
  const limit = await latestBookable();
  log(`Latest bookable check-in today: ${limit} → ${cfg.check_in} is ${limit >= cfg.check_in ? 'OPEN' : 'NOT open yet (houses below are not bookable yet)'}`);
  log('Summit houses free right now (★ = on your list):');
  printHouses(await search());
  await ctx.close(); process.exit(0);
}

// Read-only: log how many summit houses are free for check-in DATE around each opening time,
// to learn when a new date goes on sale.   node bot.mjs watch 2026-12-12
if (mode === 'watch') {
  const day = process.argv[3];
  const nextDay = addDays(day, 1);
  const openOn = addDays(day, -BOOKING_WINDOW_DAYS);
  cfg.check_in = day; cfg.check_out = nextDay;
  for (const t of ['00:00', '09:00']) {
    const at = +fromBkk(openOn, t), from = at - 3 * 60e3, to = at + 12 * 60e3;
    if (to < Date.now()) continue;
    log(`WATCHER (read-only, books nothing): checks ${day} every 15 s from ${openOn} ${t} −3 to +12 min`);
    while (Date.now() < from) {
      const mins = Math.round((from - Date.now()) / 60e3);
      log(`  waiting – checking starts in ${Math.floor(mins / 60)}h ${mins % 60}m`);
      await sleep(Math.min(from - Date.now(), 10 * 60e3));
      await openReservation();
    }
    while (Date.now() < to) {
      const free = await search().catch(e => (log('error', e.message), null));
      const limit = await latestBookable().catch(() => '?');
      if (free) log(`  ${day}: site limit ${limit} (${limit >= day ? 'OPEN' : 'not open'}), ${free.length} listed free  ${free.map(houseNo).join(' ')}`);
      await sleep(15000);
    }
  }
  await ctx.close(); process.exit(0);
}

// mode === 'run': keep checking from launch until every wanted house is in the cart (or give_up_at).
// Fast polling around the opening times, slow polling in between; session refreshed every 10 min.
const hotTimes = cfg.open_times.map(t => +fromBkk(openDate, t));
const isHot = now => hotTimes.some(at =>
  now >= at - cfg.poll_from_minutes_before * 60e3 && now <= at + cfg.poll_for_minutes_after * 60e3);
const giveUp = Math.max(+fromBkk(openDate, cfg.give_up_at), Date.now() + 20 * 60e3);
const hhmm = ms => new Date(ms + BKK).toISOString().slice(11, 16);

const grabbed = [];
// Search is slow (6–8 s) but lists house IDs even before the date opens, so learn them now
// and fire the reserve requests the moment the date opens, without waiting for a search.
let known = [];
try { known = (await search()).filter(h => wantRank(h) >= 0).sort((a, b) => wantRank(a) - wantRank(b)); } catch {}
log(`Pre-loaded ${known.length} house IDs: ${known.map(h => houseNo(h) + '=#' + h.code).join(', ') || '(none – will search after opening)'}`);

async function grab(list) {
  const fresh = list.filter(h => !grabbed.some(g => g.code === h.code)).slice(0, cfg.max_houses - grabbed.length);
  const results = await Promise.all(fresh.map(h =>
    DRY ? 'COMPLETE (dry run – not reserved)' : addToCart(h).catch(e => 'ERROR ' + e.message)));
  fresh.forEach((h, i) => {
    log(`  >>> ${h.name_th}: ${results[i]}`);
    if (results[i].startsWith('COMPLETE')) { grabbed.push(h); firstGrabAt ||= Date.now(); }
  });
  if (results.includes('LOGIN')) { alarm('Booking bot is logged out'); log('LOGGED OUT – log in in the window now!'); await ensureLoggedIn(); }
}

let firstGrabAt = 0, lastRefresh = Date.now(), polls = 0, lastFree = -1, isOpen = false, lastLimit = '';
const done = () => grabbed.length >= cfg.max_houses ||
  (firstGrabAt && Date.now() - firstGrabAt > cfg.keep_grabbing_seconds * 1000);

log(`Watching for ${cfg.houses.join(', ')} (need ${cfg.max_houses}) until ${openDate} ${hhmm(giveUp)} Bangkok.`);
log(`Every ${cfg.poll_every_seconds}s around ${cfg.open_times.join(' & ')} on ${openDate}, every ${cfg.idle_poll_seconds}s otherwise.` +
  (DRY ? '  [DRY RUN – nothing will be reserved]' : ''));

while (!done() && Date.now() < giveUp) {
  if (Date.now() - lastRefresh > 10 * 60e3 && !isHot(Date.now())) {   // keep-alive, never during a hot window
    await openReservation(); if (!DRY) await ensureLoggedIn(); lastRefresh = Date.now(); log('  session refreshed');
  }
  if (!isOpen) {
    let limit = '';
    try { limit = await latestBookable(); } catch (e) { log('  date check error:', e.message); await sleep(3000); continue; }
    if (limit >= cfg.check_in) {
      isOpen = true;
      log(`>>> ${cfg.check_in} is now bookable (site limit ${limit}) – reserving!`);
      if (known.length) await grab(known);
      if (done()) break;
    } else {
      if (limit !== lastLimit || ++polls % 60 === 0) log(`  not open yet – latest bookable check-in is ${limit}`);
      lastLimit = limit;
      await sleep((isHot(Date.now()) ? cfg.poll_every_seconds : cfg.idle_poll_seconds) * 1000);
      continue;
    }
  }
  let free = [];
  try { free = await search(); polls++; } catch (e) { log('  search error:', e.message); await sleep(3000); continue; }
  const targets = free.filter(h => wantRank(h) >= 0 && !grabbed.some(g => g.code === h.code))
                      .sort((a, b) => wantRank(a) - wantRank(b));
  if (free.length !== lastFree || targets.length || polls % 30 === 0)
    log(`  poll ${polls}: ${free.length} summit houses free [${free.map(houseNo).join(' ')}], ${targets.length} wanted`);
  lastFree = free.length;
  if (targets.length) await grab(targets);
  const fast = isHot(Date.now()) || firstGrabAt;
  await sleep((fast ? cfg.poll_every_seconds : cfg.idle_poll_seconds) * 1000);
}

if (DRY) {
  log(grabbed.length ? `DRY RUN would have reserved: ${grabbed.map(h => h.name_th).join(', ')}` : 'DRY RUN: nothing matched.');
  await sleep(1000);
  await page.screenshot({ path: path.join(DIR, 'dry-run.png') });
  log('Screenshot of the bot window saved to dry-run.png');
  await ctx.close(); process.exit(0);
}

if (!grabbed.length) {
  log('Nothing grabbed. Run "node bot.mjs check" to see what is still free.');
  alarm('Booking bot finished without getting a house');
} else {
  log(`In cart: ${grabbed.map(h => h.name_th).join(', ')}`);
  await goToPayment();
  alarm('Houses are in the cart. Tick the captcha and press save now.');
  log('>>> In the Chrome window: check the details, tick "I\'m not a robot", press บันทึก. The hold lasts ~10 minutes. <<<');
}
await rl.question('Press Enter here once you are finished to close the bot window… ');
await ctx.close();
process.exit(0);
