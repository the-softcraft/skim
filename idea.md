# Skim — Idea Spec

YouTube video summarizer. Paste a link, get the gist instead of watching.
Branch: `feat/skim`

## 1. App

| Field | Value |
| ----- | ----- |
| Name | **Skim** |
| Purpose | Summarize a YouTube video from its transcript |
| Package | `com.fazlerabbi.skim` |
| Target | Android WebView APK (API 23+), works in a desktop browser too |

## 2. Build target

- Template: **`web/raw`** → copied into `app/`
- Files: `index.html`, `style.css`, `script.js` only. No build step, no deps.
- Assets 100% local: inline SVG icons (`fill:none; stroke:currentColor`), system fonts, no CDN.
- Network **only for data**: RapidAPI (transcript), Gemini (summary), YouTube thumbnails (`i.ytimg.com`).
- Theme: light tokens in `:root`, dark in `html.dark`, inline `<head>` script applies saved theme before first paint, `localStorage["theme"]`.

## 3. Pipeline

```
paste link
   │
   ├─ parse video id ──✗──> inline error
   │
   ├─ check keys ────────✗──> "Add your API keys in Settings" (graceful, no crash)
   │
   ├─ RapidAPI: transcript
   │     └─✗ no captions / 404 / network ──> inline error + retry
   │
   ├─ Gemini: summary (model + language from Settings)
   │
   └─ render: metadata + summary + key points + read time
```

### 3.1 RapidAPI — transcript

```
GET https://youtube-transcript3.p.rapidapi.com/api/transcript?videoId=<ID>
headers:
  x-rapidapi-key:  <user key>
  x-rapidapi-host: youtube-transcript3.p.rapidapi.com
```

- Response: `{ transcript: [ { text, duration, offset, lang } ] }` (tolerate a nested
  `transcript.transcript` array as the old build did).
- Flatten: `arr.map(o => typeof o === "string" ? o : o.text).join(" ")`, collapse whitespace.
- Fail: non-2xx, missing `transcript`, or empty text → human error
  ("Transcript failed — check RapidAPI key / quota.").

### 3.2 Gemini — summary

```
POST https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:generateContent?key=<KEY>
Content-Type: application/json
{ "contents": [ { "parts": [ { "text": "<prompt>" } ] } ] }
```

- Read text from `candidates[0].content.parts[].text`, join, trim.
- Fail: non-2xx → show `error.message` from the response body; empty text → "Gemini returned an empty summary."

**Prompt shape**

```
Write the summary in <LANG>. Summarize this YouTube video transcript clearly.
Structure with markdown:
## TL;DR (2-3 sentences)
## Key points (bullets)
## Takeaways
Keep it faithful, no invented facts. Transcript:

<transcript, capped at 30000 chars>
```

- Length control (short/medium/detailed) is appended to the same prompt.
- Response is markdown → rendered with a small local `md()` converter
  (headings, lists, bold, inline code, blockquote). **No markdown library.**
- Transcript is capped at 30k chars before sending (token safety).

## 4. Layout

**Header** (slim, minimum height)
- logo + "Skim"
- theme toggle button (moon/sun, `aria-pressed` + dynamic label)

**Main** — swappable views

**Bottom tab bar** (fixed)
- 4 tabs: **Home · History · Settings · About**
- **Icons only, no labels** — each needs `aria-label` + `title`
- Active tab highlighted

**Floating cancel button** — bottom-right, visible only while a job runs

## 5. Features

### Home
1. YouTube URL input + Summarize
2. **Paste from clipboard** button (`N.readClipboard()`, browser fallback)
3. **Summary length control** — short / medium / detailed
4. **Summary** paragraph
5. **Key-point bullets**
6. **Copy** summary (`N.copyText()`)
7. **Share** summary (`N.shareText()`)
8. **Estimated read time**
9. **Video metadata** — title, channel, thumbnail
10. **Offline banner** when `navigator.onLine === false` (blocks submit)
11. **Clear / reset** — back action or swipe clears the current input + result state
12. **Fullscreen reading mode** — distraction-free overlay, `Esc` to close

### Background-safe generation
- A running job **survives tab switches** — never abort on navigation.
- Job state lives outside the view renderer; returning to Home re-attaches the UI.
- Floating **cancel** button (bottom-right) while `pending`: aborts the in-flight request.
- On finish: toast + history entry written.

### History
- Last **20** summaries, oldest dropped
- `localStorage`, tap to reopen, swipe/back to clear input state
- Re-running a summary from history re-uses the stored result (no re-fetch)

### Settings
- **RapidAPI key** input
- **Gemini key** input
- **Theme colors** — four native `<input type="color">` pickers (light page, light cards,
  dark page, dark cards), applied live, saved to `skim.colors`, plus **Reset to defaults**
- **Model dropdown** — a `<select>` with presets + **Custom…**:
  - `gemini-2.5-flash` *(default)*
  - `gemini-2.5-flash-lite`
  - `gemini-2.5-pro`
  - `gemini-2.0-flash`
  - `gemini-2.0-flash-lite`
  - **Custom…** → reveals a free-text field; any string the user types is saved as-is
    and used in the URL path (URL-encoded). Unknown model → Gemini's own error
    message is surfaced, not swallowed.
- **Summary language** dropdown: Bangla, English, Hindi, Urdu, Arabic, Chinese, Japanese
- Missing key → generation is prevented with a clear, graceful message (never a silent failure)
- Saved on Save: keys + model + language, in one `skim.settings` blob

### About
- App name, version, short description, credits

## 6. Native bridge usage

| Need | Call |
| ---- | ---- |
| Copy summary | `N.copyText(text)` |
| Share summary | `N.shareText(text)` |
| Paste link | `N.readClipboard()` |
| Toast on job done | `N.toastMsg(msg)` |
| Keys persisted natively (optional mirror) | `N.setValue/getValue` |

Every call guarded: `if (!window.Native) { /* browser fallback */ }`.

## 7. Data model (localStorage)

```
skim.settings → { rapidKey, geminiKey, model, lang }
skim.colors   → { lightBg, lightSurface, darkBg, darkSurface }   // hex
skim.length   → "short" | "medium" | "detailed"
skim.history  → [{ id, url, videoId, model, lang, date,
                   text, readTime }]      // max 20, newest first
theme         → "light" | "dark"
```

Thumbnail is derived, never stored: `https://img.youtube.com/vi/<videoId>/hqdefault.jpg`.

## 8. States

`idle → validating → fetching-transcript → summarizing → done | error | cancelled`
All states rendered inline; cancel is always reachable while running.

## 9. Out of scope

- Save summary to file (`N.saveFile`)
- True OS background service / notifications while the app is closed
- Service worker, manifest.json
- Login, accounts, cloud sync
- Player embed

## 9.1 Design decisions (built)

- **Layout** — content max-width **700px**, fixed bottom tab bar (icons only),
  slim sticky header (logo + name + theme toggle).
- **No animation, no transitions** — instant state changes only; feedback via
  toast, inline status line, `confirm()` / `alert()`.
- **Palette** — warm paper background with a YouTube-red accent
  (`#d32f2f` light / `#ff6b6b` dark); dark mode is neutral near-black
  (`#0a0a0a` page, `#121212` cards). Tab bar is a translucent glass strip
  (`backdrop-filter`). Page + card colors are user-overridable in Settings.
- **Type** — Inter for UI, Source Serif 4 for reading (remote, `display=swap`,
  falls back to Georgia / system fonts when offline).
- **Fullscreen reader** — overlay at 700px measure, `Esc` or close button,
  copy/share inside it.
- **Job model** — one running job, `AbortController` when available, otherwise
  a cancelled flag; tab switches never abort it; cancel FAB while running.
- History entries also carry `title` + `channel` fetched from YouTube oEmbed
  (public, no key, degrades to `Video <id>`).

## 10. Pending from you

- None blocking — API workflow captured above.
- Optional: whether keys are validated on save (plan: no network check, just
  presence + shape check; the first real request surfaces bad keys).
