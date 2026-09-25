import {
  ARM_LEAD_MS,
  CLICK_DELAY_MS,
  CONFIRM_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MISSED_GRACE_MS,
  PREWARM_LEAD_MS,
  RETRY_DELAY_MS,
  isAllowedUrl,
} from './lib/config.js';
import { registerOnPage } from './lib/page.js';

// Event record (chrome.storage.local "events"):
//   { id, url, title, openAt, auto, selector, allowWaitlist,
//     status, message, updatedAt, tabId, lastCheck }
// status: scheduled | running | registered | waitlisted | notified |
//         needs_action | failed | missed

const ICON = 'icons/icon128.png';
// Only retry when nothing was clicked: button missing/disabled, or the page failed to load.
const RETRYABLE = new Set(['not_found', 'not_open', 'error']);
const running = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- storage ----------

let queue = Promise.resolve();
// Serialize read-modify-write cycles so concurrent updates don't clobber each other.
function withEvents(fn) {
  const next = queue.then(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    const result = await fn(events);
    await chrome.storage.local.set({ events });
    return result;
  });
  queue = next.catch(() => {});
  return next;
}

async function getEvents() {
  const { events = [] } = await chrome.storage.local.get('events');
  return events;
}

async function getEvent(id) {
  return (await getEvents()).find((e) => e.id === id) || null;
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { autoMode: true, ...settings };
}

function updateEvent(id, patch) {
  return withEvents((events) => {
    const ev = events.find((e) => e.id === id);
    if (ev) Object.assign(ev, patch, { updatedAt: Date.now() });
    return ev ? { ...ev } : null;
  });
}

// ---------- keep the service worker alive during timed work ----------

let keepAliveRefs = 0;
let keepAliveTimer = null;
function holdAlive() {
  if (keepAliveRefs++ === 0) {
    // Any extension API call resets the worker's 30s idle timer.
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  }
  return () => {
    if (--keepAliveRefs === 0) clearInterval(keepAliveTimer);
  };
}

// ---------- scheduling ----------

async function schedule(ev) {
  await chrome.alarms.clear(`prewarm:${ev.id}`);
  await chrome.alarms.clear(`arm:${ev.id}`);
  if (ev.status !== 'scheduled') return;

  const now = Date.now();
  if (ev.openAt - PREWARM_LEAD_MS > now + 1000) {
    chrome.alarms.create(`prewarm:${ev.id}`, { when: ev.openAt - PREWARM_LEAD_MS });
  }
  const armAt = ev.openAt - ARM_LEAD_MS;
  if (armAt > now + 1000) {
    chrome.alarms.create(`arm:${ev.id}`, { when: armAt });
  } else {
    armAndRun(ev.id);
  }
}

// Wait for the exact opening moment, then run the attempt.
async function armAndRun(id) {
  const ev = await getEvent(id);
  if (!ev || ev.status !== 'scheduled') return;
  const release = holdAlive();
  try {
    const wait = ev.openAt + CLICK_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    await runAttempt(id);
  } finally {
    release();
  }
}

async function resync() {
  const now = Date.now();
  const events = await getEvents();
  for (const ev of events) {
    if (ev.status === 'running' && !running.has(ev.id)) {
      await updateEvent(ev.id, {
        status: 'needs_action',
        message: 'Attempt was interrupted (browser closed?). Check the event page.',
      });
      continue;
    }
    if (ev.status !== 'scheduled') continue;
    if (ev.openAt + MISSED_GRACE_MS < now) {
      await updateEvent(ev.id, {
        status: 'missed',
        message: 'Chrome was not running when registration opened.',
      });
      notify(ev, 'Missed registration time', 'Chrome was closed when registration opened. Click to open the event.', true);
    } else {
      await schedule(ev);
    }
  }
  await refreshBadge();
}

async function refreshBadge() {
  const events = await getEvents();
  const pending = events.filter((e) => e.status === 'scheduled').length;
  const attention = events.some((e) => e.status === 'needs_action');
  await chrome.action.setBadgeText({ text: attention ? '!' : pending ? String(pending) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: attention ? '#c2410c' : '#1d4ed8' });
}

// ---------- tabs ----------

function waitForLoad(tabId, trigger, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      err ? reject(err) : resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(new Error('The event tab was closed.'));
    };
    const timer = setTimeout(() => finish(new Error('The event page took too long to load.')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    Promise.resolve(trigger ? trigger() : null)
      .then(async () => {
        if (!trigger) {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') finish();
        }
      })
      .catch(finish);
  });
}

async function tabAlive(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

// Open (or reuse) the event's tab and load a fresh copy of the page.
async function loadEventTab(ev, { active }) {
  const existing = await tabAlive(ev.tabId);
  if (existing) {
    if (active) {
      await chrome.tabs.update(existing.id, { active: true });
    }
    await waitForLoad(existing.id, () =>
      existing.url === ev.url ? chrome.tabs.reload(existing.id) : chrome.tabs.update(existing.id, { url: ev.url })
    );
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: ev.url, active });
  await updateEvent(ev.id, { tabId: tab.id });
  ev.tabId = tab.id;
  await waitForLoad(tab.id);
  return tab.id;
}

// Chrome reports the URL as the title for pages without one; ignore that.
function pageTitle(tab) {
  if (!tab || !tab.title) return '';
  return tab.url && tab.url.includes(tab.title) ? '' : tab.title.trim();
}

async function focusTab(tabId) {
  const tab = await tabAlive(tabId);
  if (!tab) return false;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return true;
}

// tab.url is only visible to us on hosts we have permission for, so an
// undefined URL also means "redirected somewhere else" (e.g. the SSO login).
async function onEventHost(tabId) {
  const tab = await tabAlive(tabId);
  return !!(tab && tab.url && isAllowedUrl(tab.url));
}

// Run the page script, treating a navigation mid-run as its own outcome.
async function inject(tabId, ev, mode) {
  let onUpdated;
  const navigated = new Promise((resolve) => {
    onUpdated = (id, info) => {
      if (id === tabId && info.status === 'loading') resolve({ outcome: 'navigated' });
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  const run = chrome.scripting
    .executeScript({
      target: { tabId },
      func: registerOnPage,
      args: [
        {
          mode,
          selector: ev.selector || '',
          allowWaitlist: !!ev.allowWaitlist,
          confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
        },
      ],
    })
    .then(([res]) => (res && res.result) || { outcome: 'navigated' })
    .catch((e) => {
      if (/error page/i.test(e.message)) return { outcome: 'error', detail: 'The event page failed to load.' };
      if (/removed|unload|navigat/i.test(e.message)) return { outcome: 'navigated' };
      return { outcome: 'error', detail: e.message };
    });
  try {
    return await Promise.race([run, navigated]);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

// One registration attempt: click, then follow up to two page navigations
// (e.g. RSVP -> registration confirmation page).
async function drive(tabId, ev) {
  if (!(await onEventHost(tabId))) {
    return { outcome: 'login', detail: 'Redirected away from Hopkins Groups — you may need to log in.' };
  }
  let result = await inject(tabId, ev, 'register');
  for (let hop = 0; result.outcome === 'navigated' && hop < 3; hop++) {
    await waitForLoad(tabId);
    if (!(await onEventHost(tabId))) {
      return { outcome: 'login', detail: 'Redirected away from Hopkins Groups — you may need to log in.' };
    }
    result = await inject(tabId, ev, hop < 2 ? 'continue' : 'verify');
  }
  if (result.outcome === 'navigated') {
    return { outcome: 'unconfirmed', detail: 'The page kept navigating; check it yourself.' };
  }
  return result;
}

// ---------- the attempt ----------

async function runAttempt(id) {
  if (running.has(id)) return;
  running.add(id);
  const release = holdAlive();
  let ev = await getEvent(id);
  try {
    if (!ev) return;
    const { autoMode } = await getSettings();
    if (!autoMode || !ev.auto) {
      await updateEvent(id, { status: 'notified', message: 'Registration is open — notification sent.' });
      notify(ev, 'Registration is open now', 'Click to open the event and register.', true);
      return;
    }

    ev = await updateEvent(id, { status: 'running', message: 'Opening event page…' });
    let tabId = null;
    let result = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await updateEvent(id, { message: `Attempt ${attempt} of ${MAX_ATTEMPTS}…` });
      try {
        tabId = await loadEventTab(ev, { active: true });
        ev.tabId = tabId;
        result = await drive(tabId, ev);
      } catch (e) {
        result = { outcome: 'error', detail: e.message };
      }
      if (!RETRYABLE.has(result.outcome) || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_DELAY_MS);
    }
    await finish(ev, tabId, result);
  } catch (e) {
    if (ev) await finish(ev, ev.tabId, { outcome: 'error', detail: e.message });
  } finally {
    running.delete(id);
    release();
    await refreshBadge();
  }
}

async function finish(ev, tabId, result) {
  const { outcome, detail = '' } = result || {};
  const title = ev.title || 'Hopkins Groups event';
  const done = (status, message) => updateEvent(ev.id, { status, message });

  switch (outcome) {
    case 'registered':
      await done('registered', `Registered. ${detail}`.trim());
      notify(ev, 'Registered ✓', `You're registered for ${title}.`);
      break;
    case 'already':
      await done('registered', 'You were already registered.');
      notify(ev, 'Already registered', `You're already registered for ${title}.`);
      break;
    case 'waitlisted':
      await done('waitlisted', detail || 'On the waitlist.');
      notify(ev, 'Added to waitlist', `${title}: ${detail}`);
      break;
    case 'captcha':
    case 'needs_input':
    case 'unconfirmed':
    case 'login': {
      await done('needs_action', detail);
      if (outcome !== 'login') await focusTab(tabId);
      const heading = {
        captcha: 'CAPTCHA — finish it yourself',
        needs_input: 'Registration needs your input',
        unconfirmed: 'Please check your registration',
        login: 'Log in to Hopkins Groups',
      }[outcome];
      notify(ev, heading, `${title}: ${detail}`, true);
      break;
    }
    case 'full':
      await done('failed', detail);
      notify(ev, 'Event is full', `${title}: ${detail} Click to open it.`, true);
      break;
    default:
      // not_found, not_open, error: fall back to a notification with the link.
      await done('failed', `${detail || 'Auto-registration failed.'} Notification sent.`);
      notify(ev, 'Register manually', `${title}: ${detail || 'Auto-click failed.'} Click to open the event.`, true);
  }
}

// Opens the page ahead of time and checks that you're logged in.
async function prewarm(id) {
  const ev = await getEvent(id);
  if (!ev || ev.status !== 'scheduled') return;
  const { autoMode } = await getSettings();
  if (!autoMode || !ev.auto) return;
  const release = holdAlive();
  try {
    const tabId = await loadEventTab(ev, { active: false });
    const tab = await tabAlive(tabId);
    const patch = {};
    if (!ev.title && pageTitle(tab)) patch.title = pageTitle(tab);
    let result;
    if (!(await onEventHost(tabId))) {
      result = { outcome: 'login', detail: 'Redirected away from Hopkins Groups.' };
    } else {
      result = await inject(tabId, ev, 'inspect');
    }
    patch.lastCheck = { at: Date.now(), ...result };
    if (result.outcome === 'login') {
      patch.message = 'Not logged in! Log in before registration opens.';
      notify(ev, 'Log in to Hopkins Groups now', `Registration for ${ev.title || 'your event'} opens in 2 minutes.`, true);
    } else if (result.outcome === 'already') {
      patch.message = 'Already registered — nothing to do.';
      patch.status = 'registered';
      await chrome.alarms.clear(`arm:${id}`);
    } else {
      patch.message = 'Page loaded and logged in. Waiting for opening time.';
    }
    await updateEvent(id, patch);
  } catch (e) {
    await updateEvent(id, { message: `Pre-check failed: ${e.message}` });
  } finally {
    release();
    await refreshBadge();
  }
}

// "Test" button: open the page and report what we'd click, without clicking.
async function inspectNow(id) {
  const ev = await getEvent(id);
  if (!ev) return;
  const tabId = await loadEventTab(ev, { active: true });
  const tab = await tabAlive(tabId);
  const result = (await onEventHost(tabId))
    ? await inject(tabId, ev, 'inspect')
    : { outcome: 'login', detail: 'Redirected away from Hopkins Groups — you may need to log in.' };
  const patch = { lastCheck: { at: Date.now(), ...result } };
  if (!ev.title && pageTitle(tab)) patch.title = pageTitle(tab);
  await updateEvent(id, patch);
  return result;
}

// ---------- notifications ----------

function notify(ev, title, message, sticky = false) {
  chrome.notifications.create(`autohop|${ev.id}|${Date.now()}`, {
    type: 'basic',
    iconUrl: ICON,
    title,
    message,
    contextMessage: 'AutoHop',
    priority: 2,
    requireInteraction: sticky,
  }).catch((e) => console.warn('Notification failed:', e.message));
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const [prefix, id] = notificationId.split('|');
  if (prefix !== 'autohop') return;
  chrome.notifications.clear(notificationId);
  const ev = await getEvent(id);
  if (!ev) return;
  if (!(await focusTab(ev.tabId))) {
    const tab = await chrome.tabs.create({ url: ev.url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
});

// ---------- wiring ----------

chrome.alarms.onAlarm.addListener((alarm) => {
  const [kind, id] = alarm.name.split(':');
  if (kind === 'prewarm') prewarm(id);
  else if (kind === 'arm') armAndRun(id);
});

chrome.runtime.onStartup.addListener(resync);
chrome.runtime.onInstalled.addListener(resync);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension pages (the popup).
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(msg)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'add': {
      const { url, openAt, title = '', auto = true, selector = '', allowWaitlist = false } = msg.event;
      if (!isAllowedUrl(url)) throw new Error('URL must be an https://hopkinsgroups.jhu.edu event page.');
      if (!Number.isFinite(openAt)) throw new Error('Invalid opening time.');
      if (openAt < Date.now() - 1000) throw new Error('That time is in the past.');
      const ev = {
        id: crypto.randomUUID(),
        url,
        title: title.trim(),
        openAt,
        auto: !!auto,
        selector: selector.trim(),
        allowWaitlist: !!allowWaitlist,
        status: 'scheduled',
        message: 'Scheduled.',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tabId: null,
      };
      await withEvents((events) => events.push(ev));
      await schedule(ev);
      await refreshBadge();
      return { id: ev.id };
    }
    case 'remove': {
      await chrome.alarms.clear(`prewarm:${msg.id}`);
      await chrome.alarms.clear(`arm:${msg.id}`);
      await withEvents((events) => {
        const i = events.findIndex((e) => e.id === msg.id);
        if (i !== -1) events.splice(i, 1);
      });
      await refreshBadge();
      return {};
    }
    case 'setAuto': {
      await updateEvent(msg.id, { auto: !!msg.auto });
      return {};
    }
    case 'reschedule': {
      const ev = await updateEvent(msg.id, { status: 'scheduled', message: 'Rescheduled.' });
      if (!ev) throw new Error('Event not found.');
      if (ev.openAt < Date.now()) throw new Error('Opening time has passed — use “Run now”.');
      await schedule(ev);
      await refreshBadge();
      return {};
    }
    case 'runNow': {
      await chrome.alarms.clear(`prewarm:${msg.id}`);
      await chrome.alarms.clear(`arm:${msg.id}`);
      runAttempt(msg.id);
      return {};
    }
    case 'inspect':
      return { result: await inspectNow(msg.id) };
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}
