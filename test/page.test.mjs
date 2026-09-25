// Exercises the in-page registration script against mock event pages.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { registerOnPage } from '../extension/lib/page.js';

let browser;
let page;
before(async () => {
  browser = await chromium.launch();
});
after(() => browser && browser.close());

// Load HTML, then run the page script exactly the way chrome.scripting does:
// from its serialized source.
async function run(html, opts = {}) {
  if (page) await page.close();
  page = await browser.newPage();
  await page.setContent(html);
  const src = registerOnPage.toString();
  return page.evaluate(
    ([source, o]) => (0, eval)(`(${source})`)(o),
    [src, { confirmTimeoutMs: 1500, findWaitMs: 1500, ...opts }]
  );
}

const clickedCount = () => page.evaluate(() => window.clicks || 0);

test('clicks RSVP and detects the Cancel RSVP state', async () => {
  const r = await run(`
    <button>Share</button><a href="#">Add to Calendar</a>
    <button id="b" onclick="window.clicks=(window.clicks||0)+1; this.textContent='Cancel RSVP'">RSVP</button>`);
  assert.equal(r.outcome, 'registered');
  assert.equal(await clickedCount(), 1);
});

test('completes a plain confirmation dialog', async () => {
  const r = await run(`
    <button onclick="document.getElementById('m').style.display='block'">Register</button>
    <div id="m" role="dialog" style="display:none">
      <p>Confirm your RSVP?</p>
      <button onclick="document.body.insertAdjacentHTML('beforeend','<p>You\\'re going!</p>')">Confirm RSVP</button>
      <button>Cancel</button>
    </div>`);
  assert.equal(r.outcome, 'registered');
});

test('stops when the dialog has unfilled required fields', async () => {
  const r = await run(`
    <button onclick="document.getElementById('m').style.display='block'">RSVP</button>
    <div id="m" class="modal" style="display:none">
      <form><label for="q">Dietary restrictions</label><input id="q" required>
      <button type="button" onclick="window.submitted=true">Submit</button></form>
    </div>`);
  assert.equal(r.outcome, 'needs_input');
  assert.match(r.detail, /Dietary restrictions/);
  assert.equal(await page.evaluate(() => !!window.submitted), false);
});

test('reports already registered without clicking', async () => {
  const r = await run(`<button onclick="window.clicks=1">Cancel RSVP</button>`);
  assert.equal(r.outcome, 'already');
  assert.equal(await clickedCount(), 0);
});

test('not open yet: text hint', async () => {
  const r = await run(`<p>Registration opens on Friday at 9:00 AM.</p>`);
  assert.equal(r.outcome, 'not_open');
});

test('not open yet: disabled button is not clicked', async () => {
  const r = await run(`<button disabled onclick="window.clicks=1">Register</button>`);
  assert.equal(r.outcome, 'not_open');
  assert.equal(await clickedCount(), 0);
});

test('waits for a button rendered after load', async () => {
  const r = await run(`
    <div id="slot"></div>
    <script>setTimeout(() => { document.getElementById('slot').innerHTML =
      '<button onclick="this.outerHTML=\\'<p>You have successfully registered.</p>\\'">RSVP</button>'; }, 600);</script>`);
  assert.equal(r.outcome, 'registered');
});

test('stops at a visible CAPTCHA and does not click', async () => {
  const r = await run(`
    <iframe src="about:blank#recaptcha" title="reCAPTCHA" width="300" height="80"></iframe>
    <button onclick="window.clicks=1">RSVP</button>`);
  assert.equal(r.outcome, 'captcha');
  assert.equal(await clickedCount(), 0);
});

test('ignores the invisible reCAPTCHA badge', async () => {
  const r = await run(`
    <div class="grecaptcha-badge"><iframe src="about:blank#recaptcha" width="256" height="60"></iframe></div>
    <button onclick="this.textContent='Cancel RSVP'">RSVP</button>`);
  assert.equal(r.outcome, 'registered');
});

test('CAPTCHA appearing after the click hands control back', async () => {
  const r = await run(`
    <button onclick="document.body.insertAdjacentHTML('beforeend','<div class=&quot;h-captcha&quot; style=&quot;width:300px;height:80px&quot;></div>')">RSVP</button>`);
  assert.equal(r.outcome, 'captcha');
});

test('full event: reports it, joins waitlist only when allowed', async () => {
  const html = `<p>This event is full.</p>
    <button onclick="window.clicks=1; document.body.insertAdjacentHTML('beforeend','<p>You are on the waitlist.</p>')">Join Waitlist</button>`;
  let r = await run(html);
  assert.equal(r.outcome, 'full');
  assert.equal(await clickedCount(), 0);
  r = await run(html, { allowWaitlist: true });
  assert.equal(r.outcome, 'waitlisted');
});

test('inspect mode never clicks', async () => {
  const r = await run(`<button onclick="window.clicks=1">RSVP Now!</button>`, { mode: 'inspect' });
  assert.equal(r.outcome, 'ready');
  assert.equal(await clickedCount(), 0);
});

test('success wording already in the description is not mistaken for success', async () => {
  const r = await run(`
    <p>Your registration is confirmed once you receive an email.</p>
    <button onclick="window.clicks=(window.clicks||0)+1">RSVP</button>`);
  assert.equal(r.outcome, 'unconfirmed');
  assert.equal(await clickedCount(), 1);
});

test('custom selector wins over auto-detect', async () => {
  const r = await run(`
    <button onclick="window.wrong=1">RSVP</button>
    <span id="go" style="display:inline-block;width:40px;height:20px"
      onclick="document.body.insertAdjacentHTML('beforeend','<p>RSVP confirmed</p>')">✓</span>`,
    { selector: '#go' });
  assert.equal(r.outcome, 'registered');
  assert.equal(await page.evaluate(() => !!window.wrong), false);
});

test('password field means not logged in', async () => {
  const r = await run(`<form><input type="text"><input type="password"></form><button>RSVP</button>`);
  assert.equal(r.outcome, 'login');
});

test('continue mode submits a follow-up form with no required gaps', async () => {
  const r = await run(`
    <form onsubmit="event.preventDefault(); document.body.innerHTML='<h2>Thank you for registering!</h2>'">
      <input name="notes"><button type="submit">Complete Registration</button>
    </form>`, { mode: 'continue' });
  assert.equal(r.outcome, 'registered');
});

test('verify mode reports success or unconfirmed without clicking', async () => {
  assert.equal((await run(`<p>You're going!</p>`, { mode: 'verify' })).outcome, 'registered');
  assert.equal((await run(`<button onclick="window.clicks=1">RSVP</button>`, { mode: 'verify' })).outcome, 'unconfirmed');
  assert.equal(await clickedCount(), 0);
});
