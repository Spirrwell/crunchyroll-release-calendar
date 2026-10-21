# Crunchyroll Release Calendar (Unofficial)

A small browser extension that brings back the weekly **Release Calendar** that
Crunchyroll's website now redirects to the seasonal Simulcasts page. It shows
what actually went live, day by day, Monday–Sunday, with sub/dub filters.

Not affiliated with Crunchyroll.

> [!NOTE]
> This extension was developed entirely by Claude. I was frustrated that
> Crunchyroll seemingly removed the weekly simulcast calendar and so here is
> a mostly working replacement.

<img width="2563" height="1435" alt="image" src="https://github.com/user-attachments/assets/baebed1a-3ec9-42ba-a398-2f78259c1606" />


## Install

### Brave / Chrome / Edge / other Chromium browsers

1. Unzip this folder somewhere permanent (the browser loads it from disk).
2. Open `brave://extensions` (or `chrome://extensions`, `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `crunchyroll-release-calendar` folder.
5. Open crunchyroll.com, open **Categories → Release Calendar**.

Needs Chromium 111 or newer (Brave 1.49+). Chrome may warn about an
unrecognized `browser_specific_settings` key when loading unpacked; that key
is for Firefox and is safe to ignore.

### Firefox (128 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` inside the folder.
3. If the calendar does not appear on crunchyroll.com, open
   `about:addons`, select the extension, and under **Permissions** allow
   access to crunchyroll.com (Firefox treats host permissions as optional).

A temporary add-on is removed when Firefox quits. A permanent install needs the
extension signed through addons.mozilla.org; the manifest already carries the
add-on id Mozilla requires for that.

### Safari (17 or newer)

1. In Safari, enable **Settings → Advanced → Show features for web developers**.
2. Open **Develop → Add Temporary Extension…** and choose the folder.
3. Enable it under **Settings → Extensions** and allow it on crunchyroll.com.

A temporary extension is removed when Safari quits. A permanent install needs
the folder wrapped in a signed macOS app with Apple's
`safari-web-extension-converter`, which is a separate build.

## How it works

- **Categories → Release Calendar** still points at `/simulcastcalendar`. The
  extension catches that click and opens the calendar right there, in place,
  with no page load.
- Typing `crunchyroll.com/simulcastcalendar` (or using an old bookmark, or the
  old `?date=YYYY-MM-DD` week links) is redirected *inside the browser* to
  `/videos/new#crcal`, which also opens the calendar. Crunchyroll's server
  redirect never gets a chance to fire.
- Data comes from Crunchyroll's own "newly added" feed
  (`/content/v2/discover/browse?type=episode&sort_by=newly_added`), the same
  API the site uses for its New page. Episodes are placed on the day they became
  available to Premium members, in your local time zone. Each audio version
  (Japanese sub, English dub, …) is a separate entry, exactly like the old
  calendar.
- The extension reuses the session token the page already sends to that API.
  It never reads cookies, passwords, or account details, and the token is only
  used inside the page it was captured from. No data leaves your browser.
- **Watch progress** (the bar under each thumbnail) comes from the same
  playheads endpoint the site uses for "Continue Watching". It needs the
  account id, which the extension picks up from the page's own API request
  URLs — so it only appears while you are signed in. Progress is tracked per
  audio version, so a sub you watched won't mark the dub as watched.

## Filters (remembered between visits)

- **Subtitled (original audio)** — on by default.
- One chip per **dub language** seen this week, plus All/No dubs.
- **Free episodes** — show only episodes available to free accounts, placed on
  the day they became free.
- **Hide catalog adds** — hides older titles being added to the library
  (anything that aired 6+ months before its Crunchyroll release). They are
  tagged "Catalog · year" otherwise.
- **Hide mature**.
- **Hide watched** (signed in only) — hides episodes marked fully watched.

`‹ Last week` / `Next week ›` / `Today` move between weeks; `↻` reloads from
Crunchyroll (including watch progress); `✕` or Esc closes the calendar.
Progress is also re-read every time the calendar is opened.

## Known limitations

- The feed is read newest-first in pages of 100. A current week is 4–6
  requests; each week further back costs roughly 4 more. The extension stops
  after 40 requests (about 10 weeks back at current volume).
- Crunchyroll only lists episodes once they are live, so future days are
  always empty — same as the old calendar's "Schedule Coming Soon".
- "Free episodes" relies on the feed's free-availability date; episodes whose
  free date is more than a week after their Premium date can be missed.
- Watch progress is looked up only for the episodes currently shown (about
  one request per 50 cards). It needs your account id, which the extension
  learns from the page's own API requests and then remembers (in the site's
  localStorage) so later opens have it immediately. On a brand-new session
  the status line says it is looking for your session until the page makes
  its first account-scoped request; progress fills in by itself after that.
  If you log out or switch profiles, the remembered id is dropped the first
  time Crunchyroll rejects it and re-learned from the next request.
- The API is undocumented. If Crunchyroll renames a field or the endpoint,
  the calendar will show an error until the script is updated.
- Firefox and Safari have only been tested as temporary (developer-mode)
  extensions, not as signed or packaged installs. The script runs in the
  page's main world, which needs Firefox 128+ and Safari 17+.

## Files

- `manifest.json` — extension manifest (MV3; the `browser_specific_settings`
  block is the Firefox add-on id and minimum version).
- `rules.json` — the one redirect rule (`/simulcastcalendar` → `/videos/new#crcal`).
- `calendar.js` — everything else: token capture, feed paging, the overlay UI.
- `icons/` — toolbar/extension-page icons.

## Debugging

In the page console on crunchyroll.com, `window.__crcal.open()` opens the
calendar, `window.__crcal.close()` closes it, and `window.__crcal.reload()`
clears the cache and refetches. Errors from the API are shown in the status
line under the header.
