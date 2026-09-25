# AutoHop

A Chrome extension (Manifest V3) that registers you for limited-capacity events on
[Hopkins Groups](https://jhu.campusgroups.com) (CampusGroups) at the moment registration
opens. It uses **your own logged-in browser session**. It never sees or stores your
password, and it only acts on Hopkins Groups pages (`jhu.campusgroups.com`, plus
`hopkinsgroups.jhu.edu` in case links point there).

Event links look like `https://jhu.campusgroups.com/nrp/rsvp_boot?id=1993211`.

## What it does

1. **Schedule:** add an event URL and the time registration opens.
2. **Auto-register:** 2 minutes before opening, AutoHop opens the event in a background
   tab to check that you're logged in. If you're not, it notifies you right away. At the
   opening time it reloads the page, clicks the **RSVP / Register** button, completes a
   plain "Confirm RSVP" dialog if one appears, and checks the page for a confirmation.
3. **Fallback:** if auto-click fails, or auto mode is off (globally or for that event), you
   get a desktop notification. Clicking it opens the event page.
4. **Popup:** lists your events with a live countdown and a status: Scheduled,
   Registering…, Registered, Waitlisted, Notified, Needs you, Failed, or Missed.

### Limits it keeps

- **One attempt plus two short retries (3 s apart).** It retries only if the button isn't
  there yet or is disabled (for example, your clock is slightly ahead of the server), or if
  the page fails to load. After it has clicked, it never clicks the RSVP button again.
- **No CAPTCHA handling.** If a CAPTCHA is visible, AutoHop stops, brings the tab to the
  front and notifies you so you can finish it yourself.
- **No form filling.** If the registration form has required questions (dietary needs,
  T-shirt size and so on), it stops and hands the tab to you.
- **Only your account.** It uses the Hopkins Groups session already in your browser. There
  are no credentials, no other accounts and no background requests. It just clicks in a
  normal tab like you would.

## Install (load unpacked)

1. Download this repo: **Code → Download ZIP** on GitHub, then unzip it. Or run
   `git clone https://github.com/maxwell-jolley/autohop.git`.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the **`extension`** folder inside the repo, not the
   repo root.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **AutoHop**.
6. Allow notifications. On macOS, open **System Settings → Notifications → Google Chrome**
   and make sure alerts are allowed. On Windows, check **Settings → System →
   Notifications**. Otherwise the fallback notifications won't show up.

To update after pulling changes, click the ↻ reload icon on the AutoHop card in
`chrome://extensions`. Your scheduled events are kept.

Requires Chrome 120 or newer, or another Chromium browser such as Edge or Brave.

## Use it

1. Log in to Hopkins Groups in Chrome and open the event page.
2. Click the AutoHop icon. The URL is filled in from the current tab.
3. Set **Registration opens** to the exact date and time, down to the second.
4. Click **Schedule**.
5. Optional: click **Test** on the event. AutoHop opens the page and reports what it
   found (for example "Button found", "Not open yet", "Not logged in" or "Already
   registered") **without clicking anything**.

At opening time, keep in mind:

- **Chrome must be running and your computer awake.** Extensions can't wake a sleeping
  laptop. If Chrome was closed at opening time and it's more than 10 minutes late when
  it reopens, the event is marked **Missed** and you get a notification with the link.
- **Stay logged in.** Hopkins SSO sessions expire, so log in again shortly before the
  opening time. The 2-minute pre-check warns you if you're logged out.
- AutoHop brings its tab to the front at opening time. That's deliberate, because Chrome
  slows down background tabs.

### Popup controls

| Control | What it does |
| --- | --- |
| **Auto-register** (header) | Master switch. Off means every event only gets a notification at opening time. |
| **Auto** (per event) | Same as above, for just that event. |
| **Test** | Opens the page and reports what it sees without clicking. |
| **Run now** | Tries to register immediately, for events that are already open. |
| **Re-arm** | Schedules the event again for its original time, if that time is still in the future. |
| **Remove** | Deletes the event and its timers. |

### Advanced options (per event)

- **Button CSS selector:** use this if **Test** says "No RSVP/Register button found" on a
  page that does have one. Right-click the button → **Inspect**, then copy a selector such
  as `#rsvp_button` or `a.btn-rsvp`.
- **Join the waitlist if the event is full:** off by default. When on, AutoHop clicks
  "Join Waitlist" if that is the only option.

## How it decides what to click

It looks for a visible, enabled button or link whose text is one of **RSVP**,
**Register**, **Sign up**, **Get tickets**, **Reserve a spot**, **Attend** or **I'm
going** (including variants like "RSVP Now!"). It ignores anything containing Cancel,
Share, Calendar, Log in and similar words.

Success is confirmed when **new** text appears, such as "You're going", "You have
registered", "RSVP confirmed" or "Thank you for registering", or when a **Cancel RSVP**
button appears. Wording that was already on the page before the click doesn't count, so
an event description that mentions "registration is confirmed by email" won't fool it.
If nothing confirms within about 12 seconds, the status becomes **Needs you** and the tab
is brought forward so you can check.

## Privacy and permissions

| Permission | Why |
| --- | --- |
| `https://jhu.campusgroups.com/*`, `https://hopkinsgroups.jhu.edu/*` | Open event pages and click the button there. These are the only sites it can touch. |
| `scripting` | Run the click and check script in the event tab. |
| `alarms` | Wake up at the scheduled time. |
| `notifications` | Fallback and status notifications. |
| `storage` | Keep your list of events, locally only. |

Nothing is sent anywhere. There's no server, no analytics and no remote code.

## Development

```
extension/          ← the folder you load in Chrome
  manifest.json
  background.js     scheduling, tab handling, retries, notifications
  lib/page.js       the script injected into the event page (find / click / confirm)
  lib/config.js     timing knobs and the allowed host
  popup/            popup UI
scripts/make_icons.py
test/               Playwright tests
```

Tune the timing in `extension/lib/config.js`: how early the pre-check runs, the retry
count and delay, and how long to wait for confirmation. If Hopkins Groups ever moves to
another domain, update both `ALLOWED_HOSTS` there and `host_permissions` in
`manifest.json`.

Run the tests (Node 20+):

```sh
npm install
npm test
```

`test/page.test.mjs` runs the page script against mock event pages: confirm dialogs,
required fields, CAPTCHAs, disabled buttons, waitlists and more.
`test/extension.test.mjs` loads the real extension in Chromium, serves fake Hopkins Groups
pages from a local HTTPS server, and checks scheduling, retries, notify-only mode and
login redirects from end to end.

> The CampusGroups page layout wasn't available to test against directly, so button
> detection is based on common CampusGroups wording. Use **Test** on a real event before
> relying on it. If it misses the button, set a CSS selector for that event.
