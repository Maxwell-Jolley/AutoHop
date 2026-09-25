// End-to-end: loads the real extension in Chromium, serves mock Hopkins Groups
// pages from a local HTTPS server, schedules events through the popup UI and
// checks the resulting status.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const HOST = 'https://hopkinsgroups.jhu.edu';
const TERMINAL = ['registered', 'waitlisted', 'failed', 'needs_action', 'notified'];

let context;
let worker;
let popup;
let server;
const pages = new Map(); // path -> handler(hitCount) => { status, headers, body }
const hits = new Map(); // path -> number of requests

// A local HTTPS server stands in for hopkinsgroups.jhu.edu (Chromium maps the
// hostname to it), because Playwright's request interception doesn't cover
// tabs that an extension opens itself.
function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohop-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=hopkinsgroups.jhu.edu',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const srv = https.createServer(
    { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) },
    (req, res) => {
      if (req.url === '/favicon.ico') return res.writeHead(404).end();
      hits.set(req.url, (hits.get(req.url) || 0) + 1);
      const handler = pages.get(req.url);
      if (!handler) return res.writeHead(404).end('not found');
      const { status = 200, headers = {}, body = '' } = handler(hits.get(req.url));
      res.writeHead(status, { 'content-type': 'text/html', ...headers }).end(body);
    }
  );
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

before(async () => {
  server = await startServer();
  const { port } = server.address();
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--host-resolver-rules=MAP hopkinsgroups.jhu.edu:443 127.0.0.1:${port}, MAP * ~NOTFOUND`,
      '--ignore-certificate-errors',
      '--no-proxy-server',
    ],
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
});

after(async () => {
  if (context) await context.close();
  if (server) server.close();
});


async function schedule(pathname, { inSeconds = 6, auto = true, title = pathname } = {}) {
  // Extension-opened tabs take focus; a background tab is throttled.
  await popup.bringToFront();
  const openAt = Date.now() + inSeconds * 1000;
  await popup.setChecked('#auto', auto);
  await popup.fill('#url', HOST + pathname);
  await popup.evaluate((ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    document.getElementById('openAt').value =
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, openAt);
  await popup.fill('#title', title);
  await popup.click('button[type=submit]');
  await popup.waitForSelector(`.item .title:text-is("${title}"), #formError:not([hidden])`);
  const err = await popup.$eval('#formError', (e) => (e.hidden ? '' : e.textContent));
  assert.equal(err, '', 'popup rejected the event');
}

async function waitForStatus(title, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = await worker.evaluate(async () => (await chrome.storage.local.get('events')).events || []);
    const ev = events.find((e) => e.title === title);
    if (ev && TERMINAL.includes(ev.status)) return ev;
    if (Date.now() > deadline) throw new Error(`Timed out; last state: ${JSON.stringify(ev)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('registers at opening time through a confirm dialog', async () => {
  let clickedAt = 0;
  pages.set('/clicked', () => { clickedAt = Date.now(); return { body: 'ok' }; });
  pages.set('/rsvp?id=1', () => ({
    body: `<title>Spring Formal</title>
      <button onclick="fetch('/clicked'); document.getElementById('m').style.display='block'">RSVP</button>
      <div id="m" role="dialog" style="display:none">
        <button onclick="this.parentElement.innerHTML='<p>You\\'re going!</p>'">Confirm RSVP</button>
      </div>`,
  }));
  await schedule('/rsvp?id=1', { title: 'formal' });
  const ev = await waitForStatus('formal');
  assert.equal(ev.status, 'registered', ev.message);
  assert.ok(clickedAt >= ev.openAt, `clicked ${ev.openAt - clickedAt}ms before opening`);
  assert.ok(clickedAt - ev.openAt < 5000, `clicked ${clickedAt - ev.openAt}ms after opening`);
  assert.equal(hits.get('/rsvp?id=1'), 1);
});

test('retries when the button is not there yet, then succeeds', async () => {
  pages.set('/rsvp?id=2', (n) =>
    n < 2
      ? { body: '<p>Registration opens soon.</p>' }
      : { body: `<button onclick="this.outerHTML='<button>Cancel RSVP</button>'">Register</button>` }
  );
  await schedule('/rsvp?id=2', { title: 'retry' });
  const ev = await waitForStatus('retry');
  assert.equal(ev.status, 'registered', ev.message);
  assert.equal(hits.get('/rsvp?id=2'), 2);
});

test('gives up after one attempt plus two retries and falls back to a notification', async () => {
  pages.set('/rsvp?id=3', () => ({ body: '<p>Registration opens soon.</p>' }));
  await schedule('/rsvp?id=3', { title: 'never' });
  const ev = await waitForStatus('never', 45000);
  assert.equal(ev.status, 'failed');
  assert.match(ev.message, /Notification sent/);
  assert.equal(hits.get('/rsvp?id=3'), 3);
});

test('notify-only mode never loads the page', async () => {
  pages.set('/rsvp?id=4', () => ({ body: '<button>RSVP</button>' }));
  await schedule('/rsvp?id=4', { title: 'manual', auto: false });
  const ev = await waitForStatus('manual');
  assert.equal(ev.status, 'notified');
  assert.equal(hits.get('/rsvp?id=4') || 0, 0);
});

test('login redirect is reported instead of clicking', async () => {
  pages.set('/rsvp?id=5', () => ({ status: 302, headers: { location: 'https://login.example.test/sso' }, body: '' }));
  await schedule('/rsvp?id=5', { title: 'loggedout' });
  const ev = await waitForStatus('loggedout');
  assert.equal(ev.status, 'needs_action');
  assert.match(ev.message, /log in/i);
});

test('popup lists events with their status', async () => {
  const badges = await popup.$$eval('.item', (items) =>
    Object.fromEntries(items.map((li) => [li.querySelector('.title').textContent, li.querySelector('.badge').textContent]))
  );
  assert.deepEqual(badges, {
    formal: 'Registered',
    retry: 'Registered',
    never: 'Failed',
    manual: 'Notified',
    loggedout: 'Needs you',
  });
});
