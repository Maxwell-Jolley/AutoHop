// Runs inside the Hopkins Groups event page via chrome.scripting.executeScript.
//
// It is serialized with Function.prototype.toString, so it must be fully
// self-contained: no imports, no references to anything outside its body.
//
// Modes:
//   inspect  – report the page state, never click anything
//   register – click the RSVP/Register button once, then a plain confirm step
//              (e.g. a "Confirm RSVP" dialog) if it has no unfilled required fields
//   continue – after the click navigated to a new page: complete a plain
//              confirm/submit step only
//   verify   – report whether registration succeeded, never click anything
//
// Returns { outcome, detail, clicked } where outcome is one of:
//   registered, waitlisted, already, ready, captcha, login, needs_input,
//   not_open, not_found, full, unconfirmed
export async function registerOnPage(opts) {
  const {
    mode = 'register',
    selector = '',
    allowWaitlist = false,
    findWaitMs = 5000,
    confirmTimeoutMs = 12000,
  } = opts || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) =>
    String(s || '')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  // Label with icons/punctuation stripped, for exact-ish matching.
  const cleanLabel = (s) => norm(norm(s).replace(/[^\p{L}\p{N}' -]+/gu, ' '));

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isDisabled = (el) =>
    !!el.disabled ||
    el.getAttribute('aria-disabled') === 'true' ||
    (el.classList && el.classList.contains('disabled'));
  const labelOf = (el) =>
    cleanLabel(
      el.innerText ||
        el.value ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
    );

  const CLICKABLE = 'button, a, input[type=submit], input[type=button], [role=button]';

  const PRIMARY = [
    /^rsvp( now| here| for (this )?event| to (this )?event)?$/i,
    /^register( now| here| for (this )?event)?$/i,
    /^sign ?up( now| here)?$/i,
    /^(get|reserve|claim|request) (a |my |your )?(free )?(tickets?|spots?|seats?)$/i,
    /^attend( event)?$/i,
    /^i'?m going$/i,
  ];
  const WAITLIST = [/^(join|add me to) (the )?wait ?list$/i];
  const CONFIRM = [
    /^(confirm|submit|complete|finish)( my)?( rsvp| registration| order)?$/i,
    /^rsvp$/i,
    /^register( now)?$/i,
    /^continue$/i,
    /^yes( rsvp| register)?$/i,
    /^(get|reserve|claim) (my )?(tickets?|spots?|seats?)$/i,
  ];
  const EXCLUDE =
    /cancel|not going|un-?register|decline|can'?t (go|attend)|remove|withdraw|leave|share|calendar|log ?in|sign ?in|log ?out|sign ?out/i;
  const CANCEL_BTN = /^(cancel( my)? (rsvp|registration)|un-?register)$/i;

  const SUCCESS_TEXT = [
    /you'?(re| are) (now )?(going|registered|attending|rsvp'?d|signed up)[^.\n]{0,60}/i,
    /you'?(ve| have) (successfully )?(registered|rsvp'?d|signed up)[^.\n]{0,60}/i,
    /(your )?(registration|rsvp) (is |was |has been )?(complete|completed|confirmed|successful|received|submitted|saved)[^.\n]{0,40}/i,
    /successfully (registered|rsvp'?d|signed up)[^.\n]{0,60}/i,
    /thanks? (you )?for (registering|your rsvp|signing up|rsvp'?ing)[^.\n]{0,40}/i,
  ];
  const WAITLIST_TEXT = [
    /you'?(re| are) (now )?on the wait ?list/i,
    /(added|moved) (you )?to (the )?wait ?list/i,
  ];
  const FULL_TEXT =
    /(event|registration|rsvp) (is )?(full|closed)|sold out|no (spots|seats|tickets|space) (left|remaining|available)|at (full )?capacity/i;
  const NOT_OPEN_TEXT =
    /(registration|rsvp|tickets?) (opens|will open|is not (yet )?open|not yet available|available (on|at|starting))/i;

  const pageText = () => norm(document.body ? document.body.innerText : '');

  const visibleClickables = (root = document) =>
    [...root.querySelectorAll(CLICKABLE)].filter(isVisible);

  const findByPatterns = (patterns, root = document) => {
    let best = null;
    let bestRank = Infinity;
    for (const el of visibleClickables(root)) {
      const label = labelOf(el);
      if (!label || label.length > 40 || EXCLUDE.test(label)) continue;
      const rank = patterns.findIndex((re) => re.test(label));
      if (rank !== -1 && rank < bestRank) {
        best = el;
        bestRank = rank;
      }
    }
    return best;
  };

  const captchaVisible = () => {
    if (/just a moment|attention required|verify you are human/i.test(document.title)) return true;
    const nodes = document.querySelectorAll(
      [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="turnstile"]',
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[title*="captcha" i]',
        '.g-recaptcha',
        '.h-captcha',
        '.cf-turnstile',
      ].join(',')
    );
    return [...nodes].some(
      (n) =>
        isVisible(n) &&
        !/size=invisible/.test(n.getAttribute('src') || '') &&
        n.getAttribute('data-size') !== 'invisible' &&
        !n.closest('.grecaptcha-badge')
    );
  };

  const loginFormVisible = () =>
    /\/(login|signin|sso|saml)/i.test(location.pathname) ||
    [...document.querySelectorAll('input[type=password]')].some(isVisible);

  // Everything on the page right now that says "you're registered".
  const successSignals = () => {
    const out = [];
    const text = pageText();
    for (const re of SUCCESS_TEXT) {
      const m = text.match(re);
      if (m) out.push('text:' + m[0].toLowerCase());
    }
    for (const el of visibleClickables()) {
      const label = labelOf(el);
      if (CANCEL_BTN.test(label)) out.push('button:' + label.toLowerCase());
    }
    return out;
  };
  const waitlistSignal = () => WAITLIST_TEXT.some((re) => re.test(pageText()));

  const emptyRequiredFields = (root) =>
    [...root.querySelectorAll('input, select, textarea')].filter((el) => {
      if (el.disabled || el.type === 'hidden') return false;
      if (!(el.required || el.getAttribute('aria-required') === 'true')) return false;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (!el.name) return !el.checked;
        return !root.querySelector(`input[name="${CSS.escape(el.name)}"]:checked`);
      }
      return !isVisible(el) ? false : !norm(el.value);
    });

  // A plain confirmation step: a visible dialog (or, after navigating, a form)
  // with a Confirm/Submit/RSVP button.
  const findConfirmStep = (includeForms) => {
    const containers = [
      ...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], .modal'),
    ].filter(isVisible);
    if (includeForms) containers.push(...[...document.querySelectorAll('form')].filter(isVisible));
    for (const c of containers) {
      const btn = findByPatterns(CONFIRM, c);
      if (btn && !isDisabled(btn)) {
        const scope = btn.closest('form') || c;
        return { button: btn, missing: emptyRequiredFields(scope) };
      }
    }
    return null;
  };

  const click = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  };

  const describeMissing = (fields) =>
    fields
      .slice(0, 3)
      .map((f) => {
        const lbl = f.labels && f.labels[0] ? norm(f.labels[0].innerText) : '';
        return lbl || f.name || f.placeholder || f.type;
      })
      .join(', ');

  // After clicking: watch for success, a CAPTCHA, or a plain confirm step.
  const watchAfterClick = async (baseline, allowConfirm, includeForms) => {
    let confirmed = !allowConfirm;
    const deadline = Date.now() + confirmTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(250);
      if (captchaVisible()) {
        return { outcome: 'captcha', detail: 'A CAPTCHA appeared — please complete it yourself.', clicked: true };
      }
      if (waitlistSignal()) return { outcome: 'waitlisted', detail: 'Added to the waitlist.', clicked: true };
      const fresh = successSignals().filter((s) => !baseline.includes(s));
      if (fresh.length) {
        return { outcome: 'registered', detail: fresh[0].replace(/^\w+:/, ''), clicked: true };
      }
      if (!confirmed) {
        const step = findConfirmStep(includeForms);
        if (step) {
          if (step.missing.length) {
            return {
              outcome: 'needs_input',
              detail: 'Registration form needs your input: ' + describeMissing(step.missing),
              clicked: true,
            };
          }
          confirmed = true;
          click(step.button);
        }
      }
    }
    return { outcome: 'unconfirmed', detail: 'Clicked, but no confirmation appeared.', clicked: true };
  };

  // ---- checks that apply to every mode ----
  if (captchaVisible()) return { outcome: 'captcha', detail: 'The page is showing a CAPTCHA.', clicked: false };
  if (loginFormVisible()) return { outcome: 'login', detail: 'You are not logged in to Hopkins Groups.', clicked: false };

  if (mode === 'verify') {
    if (waitlistSignal()) return { outcome: 'waitlisted', detail: 'On the waitlist.', clicked: false };
    const s = successSignals();
    if (s.length) return { outcome: 'registered', detail: s[0].replace(/^\w+:/, ''), clicked: false };
    return { outcome: 'unconfirmed', detail: 'Could not find a confirmation on the page.', clicked: false };
  }

  if (mode === 'continue') {
    if (waitlistSignal()) return { outcome: 'waitlisted', detail: 'Added to the waitlist.', clicked: false };
    const s = successSignals();
    if (s.length) return { outcome: 'registered', detail: s[0].replace(/^\w+:/, ''), clicked: false };
    const step = findConfirmStep(true);
    if (!step) return { outcome: 'unconfirmed', detail: 'Clicked, but no confirmation appeared.', clicked: false };
    if (step.missing.length) {
      return {
        outcome: 'needs_input',
        detail: 'Registration form needs your input: ' + describeMissing(step.missing),
        clicked: false,
      };
    }
    const baseline = successSignals();
    click(step.button);
    return watchAfterClick(baseline, false, true);
  }

  // ---- inspect / register ----
  const hasCancelButton = () => visibleClickables().some((el) => CANCEL_BTN.test(labelOf(el)));

  const findTarget = () => {
    if (selector) {
      const el = document.querySelector(selector);
      return el && isVisible(el) ? el : null;
    }
    return findByPatterns(PRIMARY);
  };

  // The RSVP button may be rendered by script after the page's load event.
  let target = findTarget();
  const findDeadline = Date.now() + (mode === 'register' ? findWaitMs : 1500);
  while (!target && !hasCancelButton() && Date.now() < findDeadline) {
    await sleep(250);
    target = findTarget();
  }

  if (waitlistSignal()) return { outcome: 'waitlisted', detail: 'Already on the waitlist.', clicked: false };
  if (hasCancelButton()) return { outcome: 'already', detail: 'You are already registered.', clicked: false };

  if (!target) {
    if (successSignals().length) return { outcome: 'already', detail: 'You appear to be registered already.', clicked: false };
    const waitlistBtn = findByPatterns(WAITLIST);
    const text = pageText();
    if (waitlistBtn && allowWaitlist) {
      target = waitlistBtn;
    } else if (FULL_TEXT.test(text) || waitlistBtn) {
      return {
        outcome: 'full',
        detail: waitlistBtn ? 'Event is full (a waitlist is available).' : 'Event appears to be full or closed.',
        clicked: false,
      };
    } else if (NOT_OPEN_TEXT.test(text)) {
      return { outcome: 'not_open', detail: 'Registration does not appear to be open yet.', clicked: false };
    } else {
      return {
        outcome: 'not_found',
        detail: selector ? `No visible element matches "${selector}".` : 'No RSVP/Register button found.',
        clicked: false,
      };
    }
  }

  const label = labelOf(target) || selector;
  if (isDisabled(target)) {
    return { outcome: 'not_open', detail: `"${label}" button is disabled.`, clicked: false };
  }
  if (mode === 'inspect') {
    return { outcome: 'ready', detail: `Found "${label}" button.`, clicked: false };
  }

  const baseline = successSignals();
  click(target);
  return watchAfterClick(baseline, true, false);
}
