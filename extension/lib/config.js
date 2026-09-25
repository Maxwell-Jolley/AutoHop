// Central tuning knobs. If you change ALLOWED_HOSTS, update
// "host_permissions" in manifest.json to match.

// Sites the extension is allowed to act on.
export const ALLOWED_HOSTS = ['hopkinsgroups.jhu.edu'];

// Open the event page this long before registration opens, to confirm you're
// logged in while there's still time to fix it.
export const PREWARM_LEAD_MS = 2 * 60 * 1000;

// Wake the background worker this long before opening time, then wait
// precisely for the opening moment (chrome.alarms alone is not precise enough).
export const ARM_LEAD_MS = 25 * 1000;

// Small delay after the opening time before the page is reloaded, so we don't
// beat the server's own clock.
export const CLICK_DELAY_MS = 500;

// One attempt plus two short retries (only when the button isn't there yet).
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 3000;

// How long to watch the page for a confirmation after clicking.
export const CONFIRM_TIMEOUT_MS = 12000;

// If the browser was closed at opening time and it's later than this when it
// comes back, don't click — just notify.
export const MISSED_GRACE_MS = 10 * 60 * 1000;

export function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
