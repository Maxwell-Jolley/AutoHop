import { isAllowedUrl } from '../lib/config.js';

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = {
  scheduled: 'Scheduled',
  running: 'Registering…',
  registered: 'Registered',
  waitlisted: 'Waitlisted',
  notified: 'Notified',
  needs_action: 'Needs you',
  failed: 'Failed',
  missed: 'Missed',
};
const CHECK_LABEL = {
  ready: 'Button found',
  already: 'Already registered',
  waitlisted: 'On waitlist',
  login: 'Not logged in',
  captcha: 'CAPTCHA shown',
  not_open: 'Not open yet',
  not_found: 'No button found',
  full: 'Full',
  error: 'Error',
};

function send(msg) {
  return chrome.runtime.sendMessage(msg).then((res) => {
    if (!res || !res.ok) throw new Error((res && res.error) || 'No response from background.');
    return res;
  });
}

function relative(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = d ? [`${d}d`, `${h}h`] : h ? [`${h}h`, `${m}m`] : m ? [`${m}m`, `${sec}s`] : [`${sec}s`];
  return ms >= 0 ? `in ${parts.join(' ')}` : `${parts.join(' ')} ago`;
}

function whenText(ev) {
  const abs = new Date(ev.openAt).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  });
  return `Opens ${abs} (${relative(ev.openAt - Date.now())})`;
}

// ---------- list ----------

let events = [];
const prefill = { url: '', title: '' };

function render() {
  const list = $('list');
  list.replaceChildren();
  $('empty').hidden = events.length > 0;
  const sorted = [...events].sort((a, b) => a.openAt - b.openAt);
  for (const ev of sorted) {
    const li = $('itemTpl').content.firstElementChild.cloneNode(true);
    li.dataset.id = ev.id;
    const title = li.querySelector('.title');
    title.textContent = ev.title || ev.url;
    title.href = ev.url;
    title.title = ev.url;
    const badge = li.querySelector('.badge');
    badge.textContent = STATUS_LABEL[ev.status] || ev.status;
    badge.className = `badge ${ev.status}`;
    li.querySelector('.when').textContent = whenText(ev);
    li.querySelector('.message').textContent = ev.message || '';
    if (ev.lastCheck) {
      const t = new Date(ev.lastCheck.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      li.querySelector('.check-result').textContent =
        `Last check ${t}: ${CHECK_LABEL[ev.lastCheck.outcome] || ev.lastCheck.outcome} — ${ev.lastCheck.detail || ''}`;
    }
    const auto = li.querySelector('.itemAuto');
    auto.checked = !!ev.auto;
    auto.addEventListener('change', () => send({ type: 'setAuto', id: ev.id, auto: auto.checked }));

    const isRunning = ev.status === 'running';
    const future = ev.openAt > Date.now();
    li.querySelector('[data-act=runNow]').hidden = isRunning;
    li.querySelector('[data-act=inspect]').hidden = isRunning;
    li.querySelector('[data-act=reschedule]').hidden = isRunning || ev.status === 'scheduled' || !future;
    list.append(li);
  }
}

$('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const act = btn.dataset.act;
  if (act === 'remove' && !confirm('Remove this event?')) return;
  if (act === 'runNow' && !confirm('Open the event and try to register right now?')) return;
  btn.disabled = true;
  try {
    await send({ type: act, id });
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Keep countdowns fresh without rebuilding the list.
setInterval(() => {
  for (const li of document.querySelectorAll('.item')) {
    const ev = events.find((x) => x.id === li.dataset.id);
    if (ev) li.querySelector('.when').textContent = whenText(ev);
  }
}, 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.events) {
    events = changes.events.newValue || [];
    render();
  }
  if (changes.settings) $('autoMode').checked = (changes.settings.newValue || {}).autoMode !== false;
});

// ---------- form ----------

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('formError');
  err.hidden = true;
  const url = $('url').value.trim();
  const openAt = new Date($('openAt').value).getTime();
  try {
    if (!isAllowedUrl(url)) throw new Error('Use a Hopkins Groups event URL, like https://jhu.campusgroups.com/nrp/rsvp_boot?id=…');
    if (!Number.isFinite(openAt)) throw new Error('Pick the date and time registration opens.');
    if (openAt <= Date.now()) throw new Error('That time has already passed.');
    await send({
      type: 'add',
      event: {
        url,
        openAt,
        title: $('title').value || (url === prefill.url ? prefill.title : ''),
        auto: $('auto').checked,
        selector: $('selector').value,
        allowWaitlist: $('allowWaitlist').checked,
      },
    });
    $('addForm').reset();
    $('auto').checked = true;
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('autoMode').addEventListener('change', async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, autoMode: $('autoMode').checked } });
});

// ---------- init ----------

(async () => {
  const { events: stored = [], settings = {} } = await chrome.storage.local.get(['events', 'settings']);
  events = stored;
  $('autoMode').checked = settings.autoMode !== false;
  render();

  // Prefill the URL if the current tab is a Hopkins Groups page.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && isAllowedUrl(tab.url)) {
    $('url').value = prefill.url = tab.url;
    if (tab.title) $('title').placeholder = prefill.title = tab.title;
  }
})();
