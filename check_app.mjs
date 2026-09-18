// check_app.mjs — does the app actually RUN?
//
// 2026-09-18: three separate cuts this session removed a dead component and silently took a neighbouring
// module constant with it. esbuild compiled every time, because a reference to an undefined module-scope
// name is only an error at RUN time, and the published app went blank on load. The editor found it
// before I did, twice.
//
// Compiling is not running. This loads the built page in a real headless browser and fails loudly if a
// reader would see a blank screen.
//
//   node check_app.mjs                 # checks the published site
//   node check_app.mjs dist-web        # checks a local build before deploying
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const arg = process.argv[2];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png' };

let url = 'https://manwhatopps.github.io/geo-terminal-feed/app/';
let server = null;

if (arg) {
  // serve the local build at the same base path the bundle expects
  const root = arg;
  server = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]).replace('/geo-terminal-feed/app', '');
    if (p === '' || p === '/') p = '/index.html';
    try {
      const body = await readFile(join(root, normalize(p)));
      res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(8099, r));
  url = 'http://localhost:8099/geo-terminal-feed/app/';
}

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

console.log('checking ' + url);
const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => {
  errors.push('goto: ' + e.message.split('\n')[0]); return null;
});
await page.waitForTimeout(4000);

// First run shows the disclaimer gate. A reader taps through it; so does this check.
for (const label of ['I UNDERSTAND', 'CONTINUE', 'AGREE', 'ACCEPT', 'ENTER']) {
  const b = page.getByText(label, { exact: false }).first();
  if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); await page.waitForTimeout(3000); break; }
}
await page.waitForTimeout(3000);

// TABS TO VISIT — a refactor that moves components between tabs compiles fine and still crashes the
// tab it broke. Landing on HOME proves nothing about the other four.
const tabs = ['NEWS', 'BOARDS', 'CALLS', 'HISTORY'];
const perTab = [];
for (const t of tabs) {
  const b = page.getByText(t, { exact: true }).last();
  if (!(await b.count().catch(() => 0))) { perTab.push(`${t}: NOT FOUND`); continue; }
  await b.click().catch(() => {});
  await page.waitForTimeout(3500);
  const tt = (await page.evaluate(() => document.body.innerText || '')).trim();
  const tn = await page.evaluate(() => document.querySelectorAll('*').length);
  perTab.push(`${t}: ${tn} nodes, ${tt.length} chars` + (tn < 40 || tt.length < 120 ? '  <-- EMPTY' : ''));
  if (tn < 40 || tt.length < 120) errors.push(`tab ${t} rendered empty`);
}

const text = (await page.evaluate(() => document.body.innerText || '')).trim();
const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
console.log('tabs:'); perTab.forEach((l) => console.log('  ' + l));

console.log(`status ${resp ? resp.status() : '-'} · ${nodes} DOM nodes · ${text.length} chars of text`);
if (text) console.log('first line: ' + text.split('\n').find((l) => l.trim()) );
if (errors.length) {
  console.log('\nERRORS:');
  [...new Set(errors)].slice(0, 10).forEach((e) => console.log('  ' + e));
}

await browser.close();
if (server) server.close();

// A working page renders hundreds of nodes and real text. 13 nodes and no text is the blank screen.
const ok = !errors.length && nodes > 50 && text.length > 200;
console.log('\n' + (ok ? 'RENDERS' : 'BLANK OR BROKEN — do not ship this'));
process.exit(ok ? 0 : 1);
