# SharedCut Importer: final design

Date: 2026-10-08. Product: SharedCut. Base: `c13b5b3` on `main`. Status: ready to build.

The importer is a page at `sharedcut.com/importer`. It takes a Final Cut Pro project and its footage from a person's own Mac into SharedCut over Wi-Fi.

This design starts from the fit-first proposal, which has the smallest change surface. It keeps `uploadSource()` unchanged and adds a direct-roles-only rule for guests. On top of that it takes:
- from the UX-first proposal: the walkthrough, the footage guidance, the server dry run and progress computed by the server;
- from the robustness-first proposal: the inexpensive reliability measures.

It drops upload stripes, IndexedDB folder handles and the guest login-merge.

---

## 1. Goals and non-goals

### Goals
- One page takes a non-technical person from a Final Cut project on their Mac to a SharedCut project on the server. The path is Wi-Fi and the Cloudflare tunnel, with nothing to install, no terminal and no cable.
- Each screen asks for one thing. Each one is explained in plain words and shows a short looping animation drawn in SharedCut's own look.
- If the person is signed in, the import uses that account. Otherwise the page asks for a name, plus the class code when the server has one.
- Before the upload starts, the page states the size and a time measured on this connection: "This project is 4.8 GB. It might take about 14 minutes to upload to SharedCut."
- During the upload it shows live progress, speed and time left. It keeps going after Wi-Fi drops, sleep, server restarts and a closed tab.
- The Projects screen shows "Maya is importing a project from Final Cut", then "Getting it ready", then the finished project.
- Guests can import and do nothing else. They cannot touch another person's project or fill the disk.
- It runs on the Mac and on the Windows Lenovo. Every new route ships with its MCP entry in the same commit.

### Non-goals
- No LAN shortcut, cable, drive transfer or native app. `public/fcp.sh` stays as it is, and the importer does not link to it. `/api/uploads/info`'s `localUrl` is unused.
- **Parallel chunks within one file.** The server appends to each file in order. Sending four files at a time already saturates a sender doing 2–6 MB/s, since one connection carries 6–9 MB/s.
- **Remembering folder access across reloads** (IndexedDB handles). After a reload, the person drags the same folders again, and only the missing bytes are sent.
- **Merging a guest into an existing account at sign-in**, unzipping a `.fcpxmld` that Safari zipped, and reading `sources.tsv` bundles in the browser. Bundles still import through MCP and `scripts/import-fcp.mjs`.
- Storage quotas for members.

### Decisions (formerly open questions)

| Question | Decision |
|---|---|
| Who sees a guest's import | Shared with the class with role **Editor**, SharedCut's default class role. Guests hold only direct roles (§4.3), so no guest can reach another project. A classmate with a real account can edit it. A student who later signs in with her real account can still edit the project she imported as a guest. |
| Members' imports | A checkbox on the Check screen, "Let my class see it on their Projects screen", **on** by default. Off keeps today's private import. Rebuilds and resumes leave sharing alone. |
| Guest limits | 5 Final Cut imports per guest. 100 GB planned per guest (`FRAME_LINE_GUEST_MAX_GB`). 20 fonts per guest. 60 new guests per hour per network address, since a class sits behind one school IP. |
| No class code configured | A guest needs only a name, the same bar as signup. |
| Per-file cap | `FRAME_LINE_MAX_UPLOAD_BYTES` stays at 10 GiB. Larger files are shown as left out before Start. |
| Partial uploads | Kept **7 days** for a project with an active import, and 24 h everywhere else as today. |
| Disk | Start needs the remaining bytes × 1.25 to fit, on top of the 5 GB reserve and the bytes other imports still have to send. |
| Project name | Final Cut's project name. An "Untitled Project" takes the export's file name (the existing `name` fallback). The importer does not let the person rename it. |
| Pages a guest can open | Only `/importer`. A guest who opens `/` is sent to `/importer`. |
| Guest account upgrade | "Save my account" (email and password) upgrades the guest in place and keeps the user id. Signing in to a different, existing account does not merge. |

---

## 2. Screens, copy and animation

### 2.1 Shell
- **Entry.** `src/main.tsx` picks the page by path before anything else loads:
  ```tsx
  const Page = lazy(() => location.pathname === '/importer' ? import('./components/Importer.tsx') : import('./App'));
  ```
  - `/importer` never loads the editor store, `connectSession()`, the caption fonts or the editor bundle. It imports only `api.ts`, `upload.ts`, `importer.ts`, `ui.tsx`, motion and lucide.
  - `loadCaptionFonts()` and `captions.css` move into `App.tsx`.
  - The server already serves `index.html` for `/importer`, so it needs no change for the page.
- **Layout.**
  - A header row holds `<Brand/>` with the BETA pill (as in the dashboard sidebar), the step rail, and the identity chip.
  - Below it, the **stage** (the illustration, 55%) sits left of the **copy column** (45%).
  - Below 900 px they stack, with the stage at 40vh, 16 px side gutters and no horizontal scroll.
  - `.importer` is its own scroll container, because `html`, `body` and `#root` are `overflow:hidden`.
- **Type.**
  - The importer root sets `font-size:15px`; the editor's 12 px is too small here.
  - H1 is 32 px/600, body 16 px, eyebrow 11 px with letter-spacing 1.5 px.
  - The primary button is a larger variant of `.button-primary`: 46 px tall, 15 px/600 text, and a `0 0 24px #bce8c71f` glow on hover.
- **Tokens.** Only existing tokens:
  - `--bg #111315`, `--panel #181b1e`, `--panel-raised #202428`, `--line #303438`.
  - `--accent #bce8c7`, `--accent-dim #223c2d`.
  - Dashboard greens `#252a2c` and `#485c4d`.
  - Headings `#e1e6df`, body `#b4bbc0`, muted `#90979c`.

  One local token, `--importer-warn: #e8cf8f`, marks paused and reconnecting states. Errors use `#ffc4bf` on `#2a1d1b` with a `#69342f` border.
- **Stage.**
  - Background `#151a18` with a soft mint radial glow and 20 px radius.
  - On Welcome, the stage shows `close-up-timeline.png` under the AuthScreen gradient, so the page reads as SharedCut.
  - The stage holds a **Replay** link (bottom right).
- **Step rail.** You · Export · Footage · Upload · Done.
  - The active dot is a mint pill that slides between steps (motion `layoutId`).
  - Fonts and Decide are sub-steps of Export, and Check is part of Upload, so the rail does not change for them.
- **Step change.**
  - `AnimatePresence mode="wait"`: the leaving step goes to opacity 0 and x −16 over 180 ms; the new step comes in from x +16 over 260 ms with ease `[0.22,1,0.36,1]`.
  - Focus then moves to the new step's `<h1 tabIndex={-1}>`.
- **Scenes.** Every scene is a 6–9 s loop that plays 3 times, then rests on its last frame, which is the explanatory still.
  - CSS scenes use `animation-iteration-count: 3; animation-fill-mode: both`. The global reduced-motion rule (`styles.css` line 27) then lands on that still with no extra CSS.
  - motion scenes check `useReducedMotion()` and render the last frame.
  - Drawings are inline SVG or HTML: generic macOS-style windows labelled with the real menu words. There is no Apple artwork and no external asset, because the CSP is `default-src 'self'`.
- **Drop anywhere.**
  - Window-level `dragover` and `drop` always call `preventDefault()`. Otherwise a missed drop makes Safari open the file in the tab.
  - A `dragenter` that carries files shows an overlay: inset 16 px, 2 px dashed mint border, background `#101214e6`, "Drop it anywhere" at 28 px.
  - Every drop is routed by what it contains (§3.1), whatever step is showing.
- **Title.** `document.title` is "Import from Final Cut · SharedCut". While uploading it becomes "42% · Import from Final Cut · SharedCut".
- **Error boundary.** "Something went wrong on our side. What you've sent is saved, so reload this page to continue." The technical detail sits in a collapsed `<details>`.

### 2.2 Blocked (only when needed)
- **iPhone or iPad.** Detected from the user agent, or a "Macintosh" user agent with `maxTouchPoints > 1`.
  - H1 "Open this on your Mac".
  - Body "Use the Mac that has your Final Cut library and go to **sharedcut.com/importer** there."
  - Animation: a phone fades out and a MacBook fades in.
- **Browser too old.** Any of `AbortSignal.any`, `crypto.subtle` or `DataTransferItem.prototype.webkitGetAsEntry` is missing.
  - H1 "Your browser needs an update".
  - Body "This page needs Safari 17.4 or newer, or Chrome. Open Apple menu › System Settings › General › Software Update, or use Chrome."
- **Windows or Linux desktop.** Not blocked. A muted line under Welcome says "Final Cut runs on a Mac. If your project is on a Mac, open this page there."

### 2.3 Welcome and You
**Animation A1 "handoff" (7 s).**
1. A MacBook outline shows a small magnetic timeline of blue, purple and green clip bars.
2. One by one (staggered 0.35 s) the bars lift off, travel a dotted arc and land on the mint tracks of a SharedCut timeline beside the logo (`/brand/sharedcut-logo-colored.png`). The landing is a spring with a 2 px overshoot.
3. The logo pulses mint once.

Last frame: every bar sits on the SharedCut tracks.

**Copy.**
- Eyebrow "FINAL CUT → SHAREDCUT"
- H1 "Bring your Final Cut project to SharedCut"
- Body "We'll move your edit and all its footage over Wi-Fi. Nothing to install."
- Three icon chips: "Export from Final Cut" · "Find your footage" · "Upload"

**Identity block** (from `GET /api/auth/me`). It shows one of three cases.
- **Signed-in member:**
  - Avatar, then "Importing as **Konrad Fischer**", then the link "Not you?".
  - "Not you?" first confirms "This signs you out of SharedCut on this Mac.", then calls `POST /api/auth/logout` and reloads.
  - Primary button "Let's start".
- **Guest cookie:**
  - "Welcome back, **Maya**." with the link "Not Maya? Start fresh", which logs out and shows the name form.
  - Primary button "Let's start".
- **Signed out:**
  - Field "Your name": placeholder "First and last name", hint "Your class sees this name next to the project.", `maxlength=80`, `autocomplete=name`, autofocus.
  - Field "Class code", shown only when `registrationRequiresCode`: hint "Your teacher has it. It's the code you'd use to sign up for SharedCut." It uses monospace text with `autocapitalize=off autocomplete=off spellcheck=false`.
  - Primary "Let's start", disabled while the name is empty. It sends `POST /api/auth/guest {name, inviteCode, color}`, where `color` is chosen at random from AuthScreen's six collaboration colors.
  - Link "Have a SharedCut account? Sign in", which goes to `/login?next=/importer`.
  - The stage shows a **name tag**: typed letters appear on it live, in the chosen color.
  - Wrong code (403): the code field shakes (x ±6 px, 3 cycles, 300 ms; with reduced motion only the border turns red) and shows "That code didn't work. Check it with your teacher and try again."
  - Too many tries (429): "Too many tries from this network. Wait a few minutes, then try again."

**Unfinished imports.** These come from `GET /api/fcp/import` and appear above the start button for any session, one card each.
- Uploading or paused: "**Soccer Highlights** is 62% uploaded." Primary "Continue upload" (§2.10), secondary "Start a different project".
- Stopped: "**Soccer Highlights** stopped at 41%. Continue upload sends only what's missing."

**Guest who has already imported something.** A quiet card: "Save your account so you can open your projects from any computer." It opens the inline claim form (§2.9).

**Footnote:** "Use the Mac that has your Final Cut library."

### 2.4 Export (step 1 of 3)
**Copy.**
- Eyebrow "STEP 1 OF 3"
- H1 "Export your project from Final Cut"
- Numbered steps. A mint bar marks each one in sync with the animation:
  1. "In Final Cut, click your project once in the browser."
  2. "Choose **File › Export XML…**"
  3. "Save it to your **Desktop**, then drag it onto this window."

**Animation A2 (8 s).** It is CSS keyframes on an HTML mock.
1. A menu bar reads "Final Cut Pro  File  Edit  Trim  Mark  Clip". The cursor clicks a project thumbnail.
2. At 1.6 s the File menu drops (y −6 → 0, items fade in one after another).
3. At 3.0 s the highlight steps down and stops on **Export XML…**, which pulses mint.
4. At 4.0 s a save sheet slides down: "Save As: My Film", "Where: Desktop". **Save** presses.
5. At 5.4 s a document icon labelled "My Film.fcpxmld" lands on a desktop strip.
6. At 6.4 s the cursor drags it into a small browser window labelled "sharedcut.com/importer", and the window glows.

Last frame: the menu is open with Export XML highlighted and the file is on the Desktop, with an arrow pointing to the browser.

**Drop card.** A real `<button>`: dashed 2 px `#485c4d` border, 160 px tall, a document icon, the text "Drag the exported file here" and the link "or choose it…".
- The link opens a hidden `<input type=file accept=".fcpxml,.fcpxmld,.xml">`.
- Idle: the border "breathes" (opacity .5 ↔ 1 over 3 s).
- Dragging over it: the border turns solid mint, the background becomes `#223c2d55`, and the icon lifts 4 px.

**Reading.** "Reading your project…" with clip bars assembling into a strip. Meanwhile the page sends `POST /api/fcp/import?dry=1&name=<file name without .fcpxml/.fcpxmld>` with the XML `File` as the body.

**Success (A3).** The document icon morphs into a mint check (a 400 ms stroke draw plus a ring burst). Text: "Got it: **My Film** · 38 clips · 4 min 12 s". "Continue" takes focus.

**`<details>` "It won't drop?"** "Right-click the file on your Desktop, choose **Show Package Contents**, and drag **Info.fcpxml** onto this window instead."

**Errors, with exact copy:**
- A video file: "That's a video. We need the file Final Cut makes with **File › Export XML…**. It ends in .fcpxml or .fcpxmld."
- A `.fcpbundle`: "That's your whole Final Cut library. First choose **File › Export XML…** in Final Cut, then drop the file it saves."
- A `.zip`, or a `.fcpxmld` that arrives as a 0-byte or unreadable file: "Your browser packed that file. Drag it in from your Desktop instead. It's easier." A2 replays.
- Server 400 for an XML with no project: "This file has clips but no project. In Final Cut, click the project (the timeline icon) in the browser, then export again."
- Any other 400: "Final Cut's file didn't open. Export it again with File › Export XML…, then drop the new one."
- Over 95 MB (checked in the browser; Cloudflare caps request bodies at 100 MB): "This project file is too big to send over the internet. Ask your teacher to import it at school."
- 403 because the project is someone else's: "That project belongs to someone else in SharedCut." Primary "Import a separate copy" (`fresh=1`).
- Dry run returns `limit: true` (a guest who already has 5 imports): "You've imported 5 projects as a guest. Save your account to import more." This opens the inline claim form.

### 2.5 Decide (sub-step, only when the dry run says `changed` or `deleted`)
- **`changed`:**
  - H1 "You've imported this project before"
  - Body "Your edit changed since then. Update the SharedCut project with your new edit? Footage you already sent is kept."
  - Primary **"Update it"** (`rebuild=1`). Secondary "Make a separate copy" (`fresh=1`).
  - Note "The old version of the edit is saved as a snapshot."
- **`deleted`:**
  - H1 "This project was deleted from SharedCut"
  - Body "It can still be restored from Recently deleted in SharedCut, or you can import a new copy."
  - Primary "Import a new copy" (`fresh=1`).
- **`resume`** (the same XML as before) has no screen. The Footage screen opens with "Welcome back! **31 of 38 clips** are already in SharedCut. Let's send the rest." If nothing is left to send, the page goes straight to Getting it ready, or to Done.

### 2.6 Fonts (sub-step, only when `missingFonts` is not empty)
**Copy.**
- Eyebrow "ONE MORE THING"
- H1 "Your titles use fonts SharedCut doesn't have yet"
- One row per font family. "Futura PT · needed" turns into "Futura PT · added", and the check pops in with a spring. Each row also has a "Choose font file…" link.
- Body "Open **Font Book**, find the font, right-click it and choose **Show in Finder**. Drag the font files here."
- In Chromium only (`'queryLocalFonts' in window`) there is an extra button, **"Add them from this Mac"**.
- Primary "Continue". While some fonts are still missing it reads "Skip: use a similar font".

**Animation A4.** A Font Book window, then a right-click menu, then "Show in Finder", then a Finder window holding `FuturaPT-Bold.otf`, then a drag into the browser window.

**Feedback.**
- A dropped font file that matches no family: toast "Didn't need Arial-Bold.ttf."
- An upload error: the server's message, shown on that row.

The matching rules are in §9.

### 2.7 Footage (step 2 of 3)
This is the center of the importer. The dry run already gave the original path of every clip, so the screen says exactly where to look.

**Copy.**
- Eyebrow "STEP 2 OF 3"
- H1 "Now let's find your footage"
- Body "Drag these onto this window. We only send the 38 clips your project uses, nothing else on your Mac."

**Place rows.** These come from `places()` (§3.4). Each row shows a lucide icon, a sentence, a hint and a progress ring that fills as files match (a 400 ms `stroke-dasharray` transition; the count ticks up with motion `animate`).
- `Clapperboard`: "Your Final Cut library **School Library**" · "in Movies" · "0 of 24 found"
- `HardDrive`: "The drive **SD CARD**" · "plug it in first" · "0 of 12 found"
- `Folder`: "The folder **Music** in Documents" · "0 of 2 found"
- A finished row turns mint, its check draws in over 250 ms, and it reads "24 of 24 found".

**"Show me where"** on each row expands to show:
- A Finder-style breadcrumb, for example "Macintosh HD › Users › maya › Movies › School Library".
- A **Copy location** button. It copies the full POSIX path, and its label reads "Copied" for 2 s.
- The line "In Finder, press **Shift ⌘ G**, paste, then press Return. Drag what opens onto this window."
- **Choose folder…**, which opens a hidden `<input type=file webkitdirectory multiple>`.

**Animation A5 Finder scene.** It is built from the first unfinished row's real names, with props `{sidebar, item, kind}`.
1. A Finder window opens.
2. The sidebar item ("Movies", "SD CARD" or "Documents") highlights.
3. The named item highlights.
4. The cursor drags it into a small browser window.

Last frame: the item sits inside the window, with an arrow.

**While walking a drop:** "Looking through School Library… 1,204 files". The counter updates every 100 entries and uses the existing `spin` keyframe.

**On each match:** the row's counter rolls up, and up to 12 file-name chips fly from the drop point into the row (motion, 400 ms, staggered 30 ms).

**While checking:** "Checking clips… 20 of 38" (§3.5).

**Inline problems, shown only when needed:**
- **Ambiguous:** "Two files are called **C0001.MP4**. Which one is from this project?" A radio group of two cards, each showing the parent folder, size and date.
- **Different clip:** "We found a **C0001.MP4** in SD CARD, but it's a different clip (12 s long; the project's is 48 s). Drag the folder it came from." There is also a link, "Use it anyway".
- **Unreadable:** "We can't open **C0012.MP4**. If it's on a drive, plug it in and drag the folder again."
- **Too big:** "**A001.mov** is 14.2 GB. SharedCut takes files up to 10.7 GB, so it'll be left out."
- **Package arrived as a file:** "Your browser gave us **School Library** as a single file. Right-click it in Finder, choose **Show Package Contents**, and drag the folders inside onto this window."
- **Zip:** "That came in as a zip file. Drag the folder itself from Finder instead."
- **Over 300,000 entries:** "That's a lot of files. Drag the folder your clips are in instead."

**Footer.** "36 of 38 clips found", then one of:
- Everything found: primary "Continue".
- Some missing: primary "Continue without 2 clips", with the line "They'll show as missing in SharedCut. You can add them later: come back here and drag them in." A `<details>` "Which clips?" lists their names and original paths. The rows stay droppable.

**Help `<details>` "Can't find a clip?":**
- "In Final Cut, select the clip and press **Shift ⌘ R** to show it in Finder."
- "Libraries are in your Movies folder unless you saved them somewhere else."

### 2.8 Check (step 3 of 3)
**Copy and states.**
- Eyebrow "STEP 3 OF 3"
- H1 "Checking your Wi-Fi…" while the 6 s probe runs (§7.4), then "Ready to upload".
- **Animation A6 Wi-Fi gauge:** an SVG half-arc fills as samples arrive. The needle follows the latest sample with a motion spring (stiffness 120, damping 18). Then it settles and the number counts up.
- Big stats: "**4.8 GB** · 38 clips"
- The sentence (Konrad's wording): "This project is 4.8 GB. It might take about **14 minutes** to upload to SharedCut."
- When resuming: "31 of 38 clips are already in SharedCut. 1.1 GB left: about **3 minutes**."
- Small line: "Your Wi-Fi is sending about 6.1 MB/s right now." Over 1 hour it adds " if your Wi-Fi stays like this".
- **Probe failed:** "We couldn't check your Wi-Fi. At a typical school speed it might take roughly **58 minutes**." This assumes 1.5 MB/s.
- **Under 1 MB/s:** "Your Wi-Fi is slow right now. It'll still work, or move closer to the router and press **Check again**."
- **Over 3 hours:** "That's a long one. Start it when your Mac can stay open and plugged in for a while. If it stops, come back here and it picks up where it left off."
- **No room** (remaining × 1.25 > `room` from the probe): "SharedCut doesn't have room for this right now. It needs about 6.0 GB and has 3.1 GB free. Your files are safe on your Mac. Tell your teacher, then press **Check again**." Start stays disabled.
- **Where it lands:**
  - Guest: "It'll show up in SharedCut as **My Film**, shared with your class."
  - Member on a new import: a checked checkbox "Let my class see it on their Projects screen", then "It'll show up in your Projects as **My Film**."
  - Rebuild or resume: no checkbox. Sharing is unchanged.
- **Left-out summary** (only when there is one): "Left out: 2 clips not found, 1 too big."
- **Tips row** (icons): "Keep your Mac plugged in" · "Leave this tab open" · "Don't close the lid"
- Primary **"Start upload"**. Secondary "Back".

**What Start does, in order** (§5.6):
1. The real import POST (skipped on resume).
2. The plan PUT.
3. The upload lanes.

A 507 at the plan shows the no-room copy. The project stays and resumes later.

### 2.9 Upload
- H1 "Uploading **My Film**"
- **Animation A7 lanes**, styled like SharedCut timeline tracks:
  - One horizontal track per lane, up to four (`#202428` tracks, 6 px radius, labels 1–4).
  - Each track shows the file it is sending as a clip that fills from left to right in mint.
  - Between server acknowledgements the fill glides at the measured rate, and it never moves backwards.
  - Finished files drop into a "done" strip below, which grows like a timeline.
  - Offline: the tracks dim and turn amber. Paused: the tracks dim.
- **Progress.** "42%" in 64 px tabular figures, then a 6 px `<progress>` styled as `.progress-track`, then "2.0 GB of 4.8 GB · 6.3 MB/s · about 8 minutes left". The first 10 s show "Starting…" with no time.
- Counter: "30 of 38 clips sent".
- **Status line** (a polite live region), one of:
  - Offline: "Wi-Fi dropped. Waiting to reconnect… Your progress is saved."
  - Server unreachable, 5xx, or Cloudflare 502/524: "SharedCut isn't answering right now. We'll keep trying, and nothing is lost."
  - 507: "SharedCut ran out of room. Nothing is lost. Tell your teacher; it continues by itself when there's space."
  - Second tab: "This import is already running in another tab."
  - Paused: "Paused", with a **Resume** button.
  - A file became unreadable: "We can't read **C0012.MP4** anymore. Plug its drive back in and drag its folder here." The other lanes keep going, and a drop fixes it.
  - 401, member: "You were signed out. Sign in again to continue." with a Sign in button to `/login?next=/importer`.
  - 401, guest: "Your guest session ended, so this browser can't finish the upload. Your class can still see what arrived."
- Chip "Keeping your Mac awake" while a Wake Lock is held.
- **Controls:** "Pause" (secondary), and "Show clips (38)", which expands a list of rows: queued · sending 42% · sent (with a check) · left out (with the reason).
- **Guest nudge.** After 60 s, guests see a card: "Want to open this from another computer later? Save your account now. It takes 20 seconds." It opens the inline claim form.
- **Guards:**
  - `beforeunload` prompts while bytes remain.
  - A Screen Wake Lock is requested inside the Start click, again on `visibilitychange` to visible, and released on pause or finish.
  - A Web Lock on the project is held for the whole upload (§7.5).
- **Live-region announcements:** every 10% (for example "42 percent, about 8 minutes left") and every state change.

### 2.10 Continue upload (resume without the XML)
"Continue upload" on Welcome loads `GET /api/fcp/import/:id`. That response has every source path, status and received byte count, so the XML is not needed again.

The page opens Footage showing only the places that still have unfinished files:
- Banner: "Welcome back. **Soccer Highlights** is 62% uploaded. Drag in these places again. The 18.3 GB already sent won't be sent again."
- Then it continues with Check and Upload as above.

### 2.11 Getting it ready
- H1 "Uploaded! SharedCut is getting it ready"
- **Animation A8:** the done strip's clips carry the existing `clip-preparing-stripes` pattern. Each one turns solid mint, with its thumbnail fading in (scale .96 → 1, staggered .05 s), as its media row becomes `ready`. This is driven by the 3 s poll (§5.3).
- "12 of 38 clips ready", with a bar.
- "You can close this page now. SharedCut keeps working, and it'll be in Projects when it's done."
- Members also see a secondary **Open in SharedCut** button.

### 2.12 Done
- H1 "**My Film** is in SharedCut"
- **Animation A9:** the card drops into a small Projects grid, gains a mint glow and a check, and a 20-particle burst plays. The burst is skipped with reduced motion.
- **Member:** body "It's in your Projects." Primary **"Open in SharedCut"** goes to `/project/<id>`. Secondary "Import another project".
- **Guest:** body "Everyone in your class can find it in Projects. Want to edit it yourself from any computer?"
  - The inline **claim form**: Email, and Password (8 or more characters, with show/hide). Primary **"Save my account"**.
  - Success: "All set. Next time, sign in at sharedcut.com with maya@school.org." The form is replaced by **Open in SharedCut**.
  - 409: "That email already has a SharedCut account. Sign in with it; your class project is already there for you to edit."
  - Secondary "I'm done".
- **Disclosures**, each only when it applies:
  - "2 clips were left out": the names, then "Come back here with their folders to add them."
  - "4 things look a little different from Final Cut": the converter's `warnings`.
  - "1 clip couldn't be prepared": the media `error`. For members: "Open SharedCut to retry it." For guests: "Your teacher can retry it in SharedCut."

---

## 3. File access and matching

All of this lives in `src/services/importer.ts`, as pure functions plus a little DOM glue. It sits under `src/services`, so `npm test`'s `src/services/*.test.ts` glob picks up its tests.

### 3.1 Intake
There is one window-level drop handler, plus pickers.

1. **Drop.** Inside `onDrop`, call `item.webkitGetAsEntry()` *synchronously* for every `DataTransferItem`, because the items are gone after the first `await`. If an entry is `null`, fall back to `dataTransfer.files`. Then walk the entries asynchronously.
2. **Route by content, whatever step is showing:**
   - **XML:** a file ending `.fcpxml` or `.xml`, or a directory ending `.fcpxmld`. For the directory, read `Info.fcpxml`, or its single `*.fcpxml`, the same rule as `readFcpBundle`.
   - **Fonts:** `.ttf .otf .ttc .woff .woff2`.
   - **Footage:** everything else (folders, `.fcpbundle`, drives, loose clips). It is held until the Footage step exists, then matched.
3. **Pickers.**
   - XML: `<input type=file accept=".fcpxml,.fcpxmld,.xml">`.
   - Folders: `<input type=file webkitdirectory multiple>`, giving `{path: webkitRelativePath, file}`.
   - Fonts: `<input type=file accept=".ttf,.otf,.ttc,.woff,.woff2" multiple>`.
4. **Package quirks.** The page detects them; it does not assume how a browser behaves.

   | What arrives | What the page does |
   |---|---|
   | A directory entry | Walk it. This is the expected path. |
   | A `File` named `*.fcpbundle` or `*.fcpxmld` whose size is 0 or whose `slice(0,1)` read fails | "Show Package Contents" copy (§2.4 and §2.7). Suffix matching still works on the folders inside. |
   | A `.zip` | "Drag it in instead" copy. A zip is never uploaded. |

Files are kept in component refs and are never stored. A `File` is lazy: nothing is read until the check pass, and only matched files are read.

### 3.2 Walking: `walk(entries, wanted, onCount)`
- Call `readEntries()` in a loop until it returns an empty batch. Chrome returns 100 entries per call.
- **Never descend into:**
  - `Render Files`, `Transcoded Media`, `Analysis Files`, `Peaks Data`, `Thumbnail Media`, `Shared Items`, `Backups`
  - `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`, `.DocumentRevisions-V100`, `Backups.backupdb`
- Skip names that start with `.`, which includes the AppleDouble `._*` files.
- **Cheap pruning.** `entry.file()` is called only when the base name's key (`name.normalize('NFC').toLowerCase()`) is in `wanted`, the set of base names the project still needs. Directories are still walked. A failing `file()` (a broken alias, or an unplugged drive behind a link) is skipped quietly.
- `onCount` fires about every 100 entries. Above 300,000 entries the walk stops with the "That's a lot of files" copy.
- **Output:** `{path, file}[]`, where `path` is the root name plus the relative segments joined with `/` (for example `School Library.fcpbundle/4-10-26/Original Media/A001.mov`). Results are deduplicated by path.

### 3.3 Matching: `matchSources(sources, found)`
The sources are the media rows from the dry run, or from `GET /api/fcp/import/:id` on a resume. Each row is `{id, name, sourcePath, duration, uploaded, received}`. The server decodes `sourcePath` with `fileUrlPath`, so the browser never parses XML.

```ts
const segs = (p: string) => p.normalize('NFC').toLowerCase().split('/').filter(Boolean);
// How many trailing path components agree: 1 = only the file name, 2 = folder and name, and so on.
const suffix = (a: string[], b: string[]) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
```

1. Skip sources the server already has (`uploaded`).
2. Find candidates: found files with the same base-name key.
3. Score each candidate with `suffix(segs(sourcePath), segs(found.path))`. Comparison ignores case, as macOS does, and is NFC on both sides, because macOS names can reach the browser decomposed while decoded XML paths are composed.
4. **One best score:** it is a match. A score of 1 is marked `weak`.
5. **A tie between files with identical `size` and `lastModified`:** they are copies of the same file, so take either.
6. **Any other tie:** `ambiguous`, which goes to the chooser.
7. **No candidate:** `missing`.

A clip stored inside the library has an XML path like `/Users/maya/Movies/School Library.fcpbundle/4-10-26/Original Media/A001.mov`. A dropped library gives `School Library.fcpbundle/4-10-26/Original Media/A001.mov`, which is a 4-segment match. Two SD cards with the same `DCIM/100CANON` layout are told apart by their volume name, which comes first in the dropped path.

With "leave files in place", the XML points at the real external path, so `places()` asks for that folder or drive rather than the library.

### 3.4 Where to look: `places(missing)`
Missing sources are grouped by their original path:
- **Library:** the path contains `/<X>.fcpbundle/`. The group key is the path up to and including the bundle. Label "Your Final Cut library **X**"; hint "in <parent folder>", or "on the drive <D>" for a library under `/Volumes`.
- **Drive:** the path starts with `/Volumes/<D>/`. The group is the lowest common folder of the group's files on that drive, or the drive itself. Label "The drive **D**", or "The folder **DCIM** on the drive **D**"; hint "plug it in first".
- **Home:** the path starts with `/Users/<u>/`. The group is the lowest common folder, but never higher than `/Users/<u>/<top>`, so files spread across Desktop and Movies become two groups. Label "The folder **Footage** in Movies", or "Your **Desktop**".
- **Anything else:** "The folder **X**".
- **At most 6 rows.** Beyond that, groups merge up to their drive or their `/Users/<u>/<top>` folder.
- Each group carries the full POSIX path for **Copy location** and a breadcrumb, in which the leading root reads "Macintosh HD" and `/Users/maya` reads "maya".

### 3.5 Check pass: `checkFile(file, kind, duration)`
This runs on every match, 8 at a time, with the "Checking clips…" counter.
1. **Read check.** `await file.slice(0, 1).arrayBuffer()`. A failure (`NotReadableError` or `NotFoundError`) marks the file `unreadable`. This catches broken links and unplugged drives before Start.
2. **Size check.** A file larger than `maxUploadBytes` (from `GET /api/uploads/info`) is marked `tooBig`.
3. **Duration check**, for video and audio whose XML duration is greater than 0.
   - Load `<video preload="metadata">` from an object URL, with a 5 s timeout, and revoke the URL afterwards.
   - If the measured duration differs from the XML duration by more than `max(0.5 s, 1%)`, the file is marked `different`. "Use it anyway" overrides that.
   - Codecs the browser can't read (MXF, some ProRes RAW) and timeouts count as `ok`.

This catches `C0001.MP4` from the wrong card even when the folder layout matches.

---

## 4. Identity and guest permissions

### 4.1 Who is importing
- `GET /api/auth/me` returns `{user, registrationRequiresCode}`, and `user` may now carry `guest: true`.
- **Member:** no questions. The import is theirs.
- **No session:** the name form (plus the code, if one is set), then `POST /api/auth/guest`.
- **Guest session:** "Welcome back, Maya".
- **A guest opening `/`:** `connectSession()` in `src/services/sync.ts` sees `user.guest` and calls `location.replace('/importer')` before it requests `/api/state`.
- **`/login?next=/importer`:** after sign-in, App sends the person to `/importer` with `location.assign`. Only that exact value is honored, so this is not an open redirect.

### 4.2 Guest accounts: `POST /api/auth/guest`
This route sits beside signup and login, before `requireAccount`. A guest is an ordinary `accounts` row, so sessions, ownership, the user list and broadcast all work unchanged.

```ts
if (path === '/api/auth/guest' && method === 'POST') {
  const body = await jsonBody(req, 4096), address = clientAddress(req);
  limit(`network:${address}`, 120, 60_000); limit(`guest:${address}`, 60, 3_600_000);   // a class behind one school IP fits
  if (!codeOk(body.inviteCode)) fail(403, 'Enter the class code to import.');           // passes when no code is configured
  const current = authenticated(req); if (current) { send(res, 200, { user: current.user }); return; }
  const name = textField(body.name, 80, true).trim() || fail(400, 'Enter your name.'), id = `user-${randomUUID()}`, salt = randomBytes(16).toString('hex');
  const color = typeof body.color === 'string' && /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#F06A70';
  // No password anyone knows: a guest lives in this browser's cookie, and "Save my account" upgrades it in place.
  const account: Account = { user: { id, name, email: `${id}@guest.invalid`, initials: initials(name), color, guest: true },
    salt, hash: (await scrypt(randomBytes(32), salt, 64) as Buffer).toString('hex'), settings: { ...DEFAULT_SETTINGS } };
  saveAccount(account); persist(); openSession(req, res, account, 201); return;
}
```

- **Helpers.** `limit()`, `codeOk()` and `openSession()` are lifted out of the existing signup and login block, which then calls them, so its behavior is unchanged.
  - `codeOk(value)` is the same SHA-256 `timingSafeEqual` check, and returns true when `FRAME_LINE_SIGNUP_CODE` is unset.
  - `openSession` inserts the session and sets the same `frameline_session` cookie (30 days, HttpOnly, SameSite=Strict, Secure behind the proxy).
- **Email.** `.invalid` is the reserved RFC 2606 domain, so it can never collide with a real address and satisfies `accounts.email UNIQUE NOT NULL`.
- **Login path untouched.** The random hash means the login code needs no change and cannot throw on an empty hash.

### 4.3 What a guest may call
Guests can reach these routes, which come before the `/api/` block and work unchanged:
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/signup` (the upgrade, §4.5)
- `GET /api/uploads/info`
- `GET /api/health`

Inside the block, directly after `requireAccount`:

```ts
// A guest (the importer's name-only sign-in) brings Final Cut projects in and nothing else; saving the account lifts this.
const GUEST = /^(?:(?:GET|POST) \/api\/fcp\/import|(?:GET|PUT) \/api\/fcp\/import\/fcp-[\w-]{1,60}|(?:GET|POST|PUT) \/api\/media\/[\w-]+\/upload|PUT \/api\/media\/[\w-]+\/thumbnail|GET \/api\/media\/[\w-]+\/files\/\S+|POST \/api\/fonts|POST \/api\/uploads\/probe)$/;
if (account.user.guest && !GUEST.test(`${method} ${path}`)) fail(403, 'Save your account to do that.');
```

This uses `.test()` on a method-plus-path string, so `mcp/coverage.test.ts` does not read it as a route.

What this closes off: `/api/state`, `/api/events`, `/api/library`, presence, sharing, editing, exports, captions, flow, depth and everything else return 403 to guests.

**Guests hold direct roles only.** In `server/index.ts`:

```ts
// Guests get no class or folder role: a class-shared project is never theirs to rebuild or upload into.
const isGuest = (userId: string) => accountCache?.byId.get(userId)?.user.guest === true;   // fresh: this request authenticated first
const roleFor = (project: Project, userId: string) => isGuest(userId) ? project.members.find(m => m.userId === userId)?.role : library.projectRole(project, userId);
```

`requireProject` therefore returns 404 to a guest for anything it does not own directly. This closes the gap where any account gets `classRole` on every class-shared project (`server/library.ts:34`).

**Other guest rules:**
- **`POST /api/fcp/import`:**
  - A new guest import is always `shared: true, classRole: 'Editor'`.
  - A guest may own at most **5** Final Cut projects (counted as direct-Owner `fcp-*` projects). The 6th gets 403 "Guests can import up to 5 projects. Save your account to import more."
  - `rebuild` and `fresh` work only on the guest's own project, which `requireProject` already enforces.
- **Plan (`PUT /api/fcp/import/:id`):** the total of plan sizes across the guest's own imports must stay at or under `FRAME_LINE_GUEST_MAX_GB` (default 100). Otherwise 403 "Guests can upload up to 100 GB. Save your account to upload more."
- **Upload init (`POST /api/media/:id/upload`):** a guest must match a planned `{id, size}` of that project. Otherwise 403 "Start this upload from sharedcut.com/importer." This is what makes the byte cap real.
- **`POST /api/fonts`:** at most 20 fonts uploaded by that guest (`fonts.countBy(uploader)`), else 403 "Guests can add up to 20 fonts." The shared 1,000-font cap and the 15 MB per-file limit still apply.

**Existing limits that still apply:**
- the same-origin write check and SameSite=Strict
- `maxUploadBytes` per file
- `requireSpace` on each chunk
- 5,000 sources per project and the 128 MB XML limit (100 MB at Cloudflare)
- the import room check (§5.4)

### 4.4 What members see of guests
- `view()` blanks the email of guest users (`user.guest ? { ...user, email: '' } : user`) inside the existing users map.
- `SharingFields.tsx` filters out `u.guest`, so guests don't fill the share pickers.
- Cards show guest names normally.

### 4.5 Saving the account (upgrade in place)
The guest's claim form sends `POST /api/auth/signup {name, email, password, upgradeGuest: true}`. In the signup branch:

```ts
const guest = body.upgradeGuest === true ? authenticated(req) : undefined;
if (guest && !guest.user.guest) fail(409, "You're already signed in.");
if (!guest && !codeOk(body.inviteCode)) fail(403, 'Enter the installation access code to create an account.');   // the guest already gave it
// …existing password, profile() and duplicate-email checks…
account = guest ? { ...guest, user: { ...guest.user, ...fields, guest: undefined }, salt, hash } : { /* new account, as today */ };
```

- The user id stays the same, so the guest's projects (where it is Owner) become a normal account's projects.
- `saveAccount`'s `ON CONFLICT(id)` update moves the email column.
- Without `upgradeGuest`, a signup from a browser holding a guest cookie creates a separate new account, as today. That way a classmate on a shared Mac never takes over Maya's guest.
- Signing in to an existing account replaces the session and merges nothing.

---

## 5. API contract

Every write still passes the same-origin check. Byte counts are integers in bytes and times are server milliseconds.

### 5.1 `POST /api/fcp/import` (changed)
**Body:** the raw XML, as today. The browser sends the `File` with `Content-Type: application/xml`, so `api()` doesn't label it JSON.

**New query parameters:**
- `dry=1` runs the converter and the existing id logic, then returns **without writing anything**:
  - no project, no `data/fcp/<id>`, no persist
  - the same 400, 403 and 404 errors as the real import
  - the 409 cases become `state` values instead of errors
- `class=1` shares a **newly created** project with the class (`shared: true, classRole: 'Editor'`). Rebuilds leave sharing alone. Guests are always treated as `class=1`.

**Dry-run response:**
```jsonc
200 {
  "projectId": "fcp-…", "name": "My Film", "duration": 252.0,
  "state": "new" | "resume" | "changed" | "deleted",
  "media": [{ "id": "fcp-…-media-…", "name": "A001.mov", "kind": "video", "duration": 12.4,
              "sourcePath": "/Users/maya/Movies/Footage/A001.mov", "uploaded": false, "received": 0 }],
  "missingFonts": ["Futura PT"], "warnings": ["…"],
  "limit": false                      // true: a guest at the 5-import cap, and state is "new"
}
```

How each field is computed:
- **`state`** maps the branches the real import already takes:
  - `new`: no existing project.
  - `resume`: the existing project has the same `fcpImportHash`.
  - `changed`: the hash differs.
  - `deleted`: `reserved(id)` is true.
- **Media ids** are deterministic (`${projectId}-media-${sha256(path)}`), so they equal the ids the real import will create.
- **`uploaded`** is true when `originalPath(id)` exists.
- **`received`** is the size of `upload.part` (0 if there is none), or the file's full size once uploaded.

**Real-import response:** unchanged, `{projectId, warnings, media}`, plus `missingFonts`.

### 5.2 `GET /api/fcp/import` (new method on an existing path)
- Returns `200 {imports: [{projectId, name, fcpImport}]}`.
- It lists the caller's direct-Owner projects whose `fcpImport.phase` is `uploading`, `paused` or `stopped`, newest first, at most 20.
- Welcome uses it for the "Continue upload" cards.

### 5.3 `GET /api/fcp/import/:projectId` (new)
Route regex: `/^\/api\/fcp\/import\/(fcp-[a-zA-Z0-9_-]{1,60})$/`. It requires `requireProject(read)`.

```jsonc
200 { "projectId": "fcp-…", "name": "My Film", "fcpImport": FcpImport | null,
      "media": [{ "id", "name", "kind", "duration", "sourcePath", "uploaded", "received", "status", "progress", "error"?, "thumbnail"? }] }
```

- Getting it ready and Done poll it every 3 s, or every 10 s while the tab is hidden, and stop when `phase` is `ready`.
- Continue upload uses it in place of the XML.

### 5.4 `PUT /api/fcp/import/:projectId`: the plan (new)
```jsonc
PUT { "files": [{ "id": "fcp-…-media-…", "size": 734003200, "fingerprint": "A001.mov:734003200:1712345678000" }] }   // 1–5000 entries
200 { "fcpImport": FcpImport, "files": [{ "id", "received", "complete" }] }
```

**Checks, in order:**
1. `requireProject(id, userId, true)`, and the project has `fcpImportHash` (otherwise 409 "That project was not imported from Final Cut.").
2. Every `id` is media of this project (otherwise 400).
3. `size` is a safe integer from 1 to `maxUploadBytes` (413 above that).
4. `fingerprint` is text of at most 300 characters.
5. The guest byte cap (§4.3).
6. **Room:** `need = Σ(size − received) × 1.25` must be at most `room(id)`, otherwise `507 {error, needed, room}`.

**Effects:**
- An unfinished upload whose `upload.json` `{size, fingerprint}` differs from the plan is dropped (both `upload.part` and `upload.json`, skipping any asset in `uploadLocks`). A different copy of a file then restarts cleanly instead of hitting 409 "The selected file differs…".
- Writes `data/fcp/<id>/plan.json` as `{by, files}` and caches it in memory.
- Sets `project.fcpImport` with `by: userId`. `startedAt` is now, unless the previous phase was `uploading` or `paused`. Then it runs `importTick(id, true)`, which goes straight to `processing` or `ready` when everything has already arrived.

**Room helper:**
```ts
// ponytail: × 1.25 leaves room for the previews made from the footage; measure full-v3 + stream sizes against originals and tune.
const outstanding = (except?: string) => state.projects.reduce((sum, p) => p.id !== except && (p.fcpImport?.phase === 'uploading' || p.fcpImport?.phase === 'paused') ? sum + (p.fcpImport.total - p.fcpImport.received) * 1.25 : sum, 0);
const room = (except?: string) => freeBytes() - minFreeBytes - outstanding(except);
```

The fingerprint must equal `uploadSource`'s: `name:size:lastModified`. `fingerprintOf` is exported from `src/services/upload.ts`.

### 5.5 `POST /api/uploads/probe` (new)
- Requires an account; guests are allowed.
- The body is read through `binaryBody(req, 8 MiB)` and discarded.
- Query parameter `project` (optional) leaves that project out of `outstanding`.
- Returns `200 {bytes, room}`. Over 8 MiB gives 413; no session gives 401.

### 5.6 Call order
- **New import:** `dry=1` (Export) → `POST /api/fonts` per matched font (Fonts) → probe (Check) → `POST /api/fcp/import[?class=1|rebuild=1|fresh=1]` → `PUT /api/fcp/import/:id` → the lanes (`POST`/`PUT /api/media/:id/upload`, `PUT …/thumbnail`) → poll `GET /api/fcp/import/:id`.
- **Continue upload:** `GET /api/fcp/import/:id` → probe → `PUT` plan → lanes → poll.

### 5.7 Unchanged routes the page relies on
- `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/signup`
- `GET /api/uploads/info` (`maxUploadBytes`)
- `GET /api/health` (used by the offline gate)
- `GET`/`POST`/`PUT /api/media/:id/upload`, `PUT /api/media/:id/thumbnail`

---

## 6. Data model changes

### `src/state/models.ts`
```ts
export interface User { id: string; name: string; email: string; initials: string; color: string; guest?: boolean }
/** A Final Cut import in flight. Only the server writes it (plan, chunks, media status); every Projects screen that can see the project reads it. */
export interface FcpImport {
  by: string;                                                    // user id of the importer
  phase: 'uploading' | 'paused' | 'processing' | 'ready' | 'stopped';
  total: number; received: number;                               // bytes of the planned files
  files: number; uploaded: number; ready: number; failed: number; // planned files; fully received; ready or failed; failed
  rate: number;                                                  // server-measured bytes/s, smoothed
  startedAt: number; updatedAt: number; doneAt?: number;         // updatedAt moves only when bytes arrive
}
// Project gains: fcpImport?: FcpImport
```

**Server-owned.** `putState` drops any `fcpImport` the client sends and keeps the stored one. This happens **before** the role and lock comparisons, so a stale copy from a Viewer cannot trip the 403 "Your role does not allow this project change.":

```ts
const project = { ...sent, fcpImport: existing.get(sent.id)?.fcpImport };   // first line of the incoming.projects map
```

**On disk:** `data/fcp/<projectId>/plan.json` = `{by, files: [{id, size, fingerprint}]}`. The per-file plan stays off the project row, so state deltas stay small.

**Accounts:** a guest row has `user.guest: true`, the email `<id>@guest.invalid` and a random scrypt hash. There is no schema change.

---

## 7. Upload engine

### 7.1 Reuse
`uploadSource()` is **unchanged**. It already handles:
- the POST that resumes from the server offset
- 8 MiB chunks with `Upload-Offset` and a SHA-256 `Upload-Checksum`
- 5 attempts per chunk
- a 60 s timeout per request
- the thumbnail first

The only changes in `upload.ts`: `fingerprintOf` and `recoverable` become exports, `bytes()` moves in from `UploadQueue.tsx` (now showing one decimal for GB), and `uploadImport()` is added below.

### 7.2 `uploadImport()`: shared by the page and the MCP `fcp` job
```ts
/** Plans a Final Cut import's files, then uploads them `lanes` at a time, largest first; the server keeps the project's import card current. */
export async function uploadImport(projectId: string, items: { assetId: string; file: File }[],
  { lanes = 4, signal, onProgress = () => {} }: { lanes?: number; signal?: AbortSignal; onProgress?: (p: ImportProgress) => void } = {}): Promise<ImportResult>
```

1. **Plan.** `PUT /fcp/import/:id {files}`. A 507, 403 or 400 here throws to the caller, before any byte is sent.
2. **Queue.** Files are sorted by remaining bytes, **largest first**, so one giant clip never runs alone at the end. Files that are already complete count their full size and are skipped.
3. **Lanes.** `W` workers each take the next file and run `uploadSource(assetId, file, …, signal, onTransfer)`.
   - Parallelism is across files only. The server rejects a second writer on one asset (409 "Upload is busy.") and any out-of-order offset.
   - Memory use is at most `W × 8 MiB`.
4. **Retry around each file:**

| Error | Handling |
|---|---|
| Network `TypeError`, 408, 409, 429, 5xx except 507, Cloudflare 502/524 | `await reachable()`, then back off `min(30 s, 2ⁿ s)` with ±20% jitter, with `n` reset whenever the file makes progress, then call `uploadSource` again. Its POST re-syncs the offset, so no acknowledged byte is sent twice. **No limit** while the page is open. |
| `TimeoutError` | `W = max(1, W − 1)`, then retry as above. |
| 507 | A global **full** gate: every lane waits, retrying one init POST every 60 s. |
| 401 | Stop everything and throw. |
| 400, 403, 404, 413 | That file fails with the server's message; the other files continue. |
| `NotReadableError` / `NotFoundError` | That file is **unreadable**; the other files continue. Dropping its folder again re-adds it and requeues it. |
| `AbortError` (Pause) | Stop quietly. Resume calls `uploadImport` again, which re-plans (idempotent) and continues from the server offsets. |

5. **`reachable()`.** One shared gate for all lanes.
   - If `navigator.onLine === false`, wait for the `online` event.
   - Then poll `GET /api/health` every 5 s until it gets any HTTP response; a 503 for low disk still counts as reachable.
   - While waiting, `waiting` is set to `'offline'` or `'server'`.
   - In Node (the MCP), there is no `navigator.onLine` and no `window`, so the gate just polls health.
6. **Progress.** `ImportProgress` is `{bytes, total, rate, eta, files, sent, lanes, waiting, failed: [{id, reason}]}`.
   - `bytes` is the sum of each file's `onTransfer.bytes`, which includes resumed bytes.
   - Once a second, the aggregate of **newly acknowledged** bytes (`bytes − resumedBytes`) goes into a 20-sample ring, so `rate` is the rolling 20 s rate. A resumed 4 GB offset never reads as a speed spike.
   - `eta` uses `estimateSeconds` (§7.3) on the remaining sizes, with `parallel = rate` and `single` = the fastest lane's rolling rate.
   - The page shows no ETA for the first 10 s. After that the displayed time changes at most every 5 s, and only when it moves by more than 10% or crosses a unit.

### 7.3 Estimating and choosing lanes
- **`lanesFor(parallel, files) = clamp(floor(parallel / 0.5 MB/s), 1, min(4, files))`.** Each lane keeps at least 0.5 MB/s, so an 8 MiB chunk lands in 16 s or less, well inside `uploadSource`'s 60 s timeout even on poor Wi-Fi.
- **`estimateSeconds(sizes, single, parallel, W)`.** An event simulation hands files to `W` lanes, largest first. With `k` lanes active, each runs at `min(single, parallel / k)`. The result is × 1.08 for hashing, chunk gaps and per-file POSTs. This is what keeps "a 5 GB project with one 3 GB interview" honest.
- **`friendlyDuration(s)`:**
  - under 45 s: "less than a minute"
  - under 90 min: "about N minutes"
  - otherwise: "about H hours M minutes", with M rounded to 10
- **Worked example:** 4.8 GB at 6.1 MB/s: 4.8e9 / 6.1e6 × 1.08 = 850 s, so "about 14 minutes". The test pins `friendlyDuration(850) === 'about 14 minutes'`.

### 7.4 Speed probe: `measureSpeed(files, projectId?)`
- A 2 MiB random block, filled once with `crypto.getRandomValues` in 64 KiB slices.
- **Phase 1, single stream, 2 s:** `POST /api/uploads/probe` repeatedly. The first response is dropped as warm-up (TLS and TCP slow start). `single` = bytes acknowledged after it divided by the time since.
- **Phase 2, `min(4, files)` streams, 3.5 s,** measured the same way: `parallel`.
- About 12 MB crosses on a 2 MB/s link. The last response's `room` feeds the room check.
- **On failure:** `single = parallel = 1.5 MB/s` and the "roughly" copy.
- **"Check again"** reruns the probe.

### 7.5 Keeping the upload alive
- **Web Lock.** `navigator.locks.request('sharedcut-import-' + projectId, { ifAvailable: true }, run)`. If there is no lock, the page shows "This import is already running in another tab." and sends nothing.
- **Wake Lock.** `navigator.wakeLock?.request('screen')` in the Start click, again on `visibilitychange` to visible, and released on pause or finish. Closing the lid still sleeps the Mac; on wake, `reachable()` resumes the lanes by themselves.
- **`beforeunload`** while bytes remain.
- **After a closed tab** (§2.10):
  - In-flight PUTs are aborted. The server appends a chunk only after reading the whole body and checking its checksum, so nothing partial lands.
  - After 90 s the card reads paused.
  - Files that already arrived keep processing.
  - Partial files are kept for 7 days.
  - Continue upload sends only the missing bytes.

---

## 8. Library status

### 8.1 Only the server writes `fcpImport`
The pure part is `importStatus(plan, statusOf, receivedOf, previous, now)` in `server/fcpxml.ts`:
- **`received`:** the sum over planned files of `min(size, receivedOf(id))`.
- **`uploaded`:** planned files that are fully received.
- **`ready`:** uploaded files whose media status is `ready` or `failed`.
- **`failed`:** the `failed` subset of those.
- **`phase`:**
  - `uploading` while `uploaded < files`. A `paused` import stays `paused` until bytes move.
  - `processing` once everything is uploaded and `ready < files`.
  - `ready` otherwise, which also sets `doneAt`.
- **`updatedAt`:** set to `now` only when `received` moved.
- **`rate`:** `0.7·rate + 0.3·Δreceived/Δt` when at least 5 s have passed since the previous tick.

The wrapper is `importTick(projectId, force?)` in `server/index.ts`:
- It is a no-op without `fcpImport`, or while the phase is `stopped` and not forced.
- It is throttled to once every 5 s per project unless forced.
- `receivedOf(id)` is the planned size if `originalPath(id)` exists, otherwise the size of `upload.part`. It stats at most 5,000 files, about 10 ms.
- When the result differs from the stored value, it replaces the project object and calls `persist()`, which broadcasts `change`.

**Hooks** (one line each):
1. Chunk PUT that is not the last chunk, next to the existing 5 s `progressAt` update: `importTick(asset.projectId)`.
2. Last chunk: `importTick(asset.projectId, true)`.
3. `updateAsset` when `'status' in patch`: `importTick(asset.projectId, true)`.
4. Housekeeping, every 10 s: `phase === 'uploading' && now − updatedAt > 90_000` → `paused` (persist). Chunks flip it back.
5. `expireUploads`, hourly:
   - Partial uploads of a project whose phase is `uploading` or `paused` are kept for 7 days, and `lastTouched` stays as today.
   - Before the loop, any import still `uploading` or `paused` with `updatedAt` more than 7 days old becomes `stopped`. Its partial files are then discarded by the normal 24 h rule in the same pass.
   - A later plan PUT restarts it.

Because the server computes it, MCP, `scripts/import-fcp.mjs` and browser imports all show on the card. A lost tab can't leave the card stale, and no client can forge it.

### 8.2 Card: `ProjectLibrary.tsx` `card(p)` and `dashboard.css`
When `p.fcpImport` exists, and either the phase is not `ready` or `doneAt` is within the last 24 h, an overlay `.drive-import` sits at the bottom of `.drive-thumbnail`. It has a gradient to `#111315e6`, two lines of text and a `.progress-track`. The name is resolved from `users` by `by`, and reads "You" when it is the viewer.

| Phase | Line 1 | Line 2 and bar |
|---|---|---|
| uploading | **Maya** is importing a project from Final Cut (own: "You're importing a project from Final Cut") | "42% · 2.0 of 4.8 GB · about 9 min left" (`(total − received) / rate`); mint bar with the stripe shimmer |
| paused | Paused · waiting for Maya's Mac | "42%"; grey bar, amber pause icon |
| processing | Getting it ready | "12 of 38 clips ready"; `clip-preparing-stripes` bar |
| stopped | Import stopped at 41% | "Maya can finish it at sharedcut.com/importer"; muted, no bar |
| ready (< 24 h) | no overlay | a "New from Final Cut" chip with a check in the meta line, using the existing `snapshot-arrive` animation; plus a warn chip "3 clips need attention" when `failed > 0` |

- The cover fills in as thumbnails arrive: `uploadSource` sends them first, and `projectCover` already picks them up.
- The card stays openable. The editor already shows media that is still uploading.
- The button's `aria-label` carries the state, for example "Open My Film. Maya is importing a project from Final Cut, 42 percent".
- **Row "Coming in from Final Cut".** At the root of every section, when no search is active, a row above "Pick up where you left off" lists the visible projects whose phase is `uploading`, `paused` or `processing`. It reuses `card(p)` and the `.drive-recents` layout with an `ArrowDownToLine` icon, and is hidden when empty. This puts a class guest import on Konrad's first screen.

### 8.3 Entry points
- Dashboard header: a secondary **Import from Final Cut** button next to "Import Resolve". It is a plain `<a href="/importer">`, so the page loads without the editor.
- AuthScreen footer: "Bringing a Final Cut project? Import it without an account →", linking to `/importer`.

---

## 9. Fonts
1. **Missing families.** The converter collects them in `fontFor`'s existing gap branch: no library match, with Helvetica, Helvetica Neue and Arial still excluded. `importFcpxml` returns them as `missingFonts`, and both the dry run and the real import pass them through.
2. **Fonts upload before the real import**, because titles are measured against the library fonts at import time.
3. **Assignment** follows `fcp.sh`'s rule. A dropped font file goes to the first family whose `fontKey` is a prefix of `fontKey(file base name)`. It is uploaded as `POST /api/fonts?name=<file base name>`, and the server's `fontFor` resolves it through the same prefix match. A file picked through a row's "Choose font file…" is uploaded with `name=<family>`, which covers file names that don't start with the family name.
4. **"Add them from this Mac"** (Chromium only) calls `queryLocalFonts()` (one permission prompt). It keeps faces whose `fontKey(family)` equals a missing key or whose `fontKey(fullName)` starts with it, then uploads `await face.blob()` as `name=<fullName>`.
5. **Moving the key.** `fontKey` moves from `server/fcpxml.ts` into `src/services/importer.ts`, and the server imports it from there (the server already imports from `src/`). Browser and server therefore decide matches the same way.
6. **Skipping** is always allowed. Titles then use a stand-in, and the Done screen's "look a little different" list keeps the converter's message. Adding the font later and choosing "Update it" (a rebuild) fixes it.

---

## 10. Failure states

| Situation | Where | What the person sees | What happens |
|---|---|---|---|
| Video, library or zip dropped as the export | Export | Specific copy (§2.4) | Nothing is sent |
| XML over 95 MB | Export | "too big to send over the internet…" | Checked in the browser |
| XML with no project | Export | "clips but no project…" | Server 400 |
| Wrong class code | You | Shake and "That code didn't work…" | 403 |
| Too many guests from one network | You | "Too many tries from this network…" | 429 |
| Guest already has 5 imports | Export | Claim form | `limit:true` / 403 |
| Edit changed, or project deleted | Decide | Update it / separate copy / new copy | `rebuild=1` / `fresh=1` |
| Package arrives as a file, or as a zip | Export / Footage | "Show Package Contents" / "drag it instead" | Nothing is uploaded |
| Clips not found | Footage | "Continue without N clips" | Not planned; they stay missing in the editor |
| Same name, different file | Footage | Chooser / "different clip" + "Use it anyway" | Duration check |
| Broken link or unplugged drive | Footage | "We can't open…" | Read check |
| File over 10 GiB | Footage / Check | "left out" | Not planned |
| Not enough room at Check | Check | "doesn't have room… Check again" | Start disabled |
| Not enough room at plan | Start | Same copy | 507; project kept and resumable |
| Not enough room mid-upload | Upload | "ran out of room… continues by itself" | Full gate, retried every 60 s |
| Wi-Fi drop, sleep, lid | Upload | Amber lanes, "Wi-Fi dropped…" | `reachable()` then resume from the offset |
| Tunnel 502/524, server restart | Upload | "SharedCut isn't answering…" | Backoff with no limit |
| Response lost after the server wrote | — | Nothing | 409, then offset re-sync |
| Second tab | Upload | "already running in another tab" | Web Lock |
| One file refused or unreadable | Upload | Row "left out: reason" / drop-to-fix | The other files continue |
| Session lost (401) | Upload | Member: sign in. Guest: copy (§2.9) | Workers stop |
| Tab closed | Welcome | "Continue upload" card | Only the missing bytes are sent |
| Away more than 7 days | Library | "Import stopped at 41%" | `stopped`; partial files discarded |
| Clip fails to prepare | Done / card | "1 clip couldn't be prepared…" / "needs attention" | Phase still reaches `ready` |
| Anything unexpected | Any | Error-boundary copy | Reload resumes |

---

## 11. Accessibility (WCAG 2.2 AA)
- **Structure and focus.**
  - `<main aria-labelledby>`; each step's `<h1 tabIndex={-1}>` receives focus on every step change.
  - The rail is `<ol aria-label="Import steps">` with `aria-current="step"`.
- **Drag is never required.** Every drop zone is a real `<button>` that opens a picker, and each place row has "Choose folder…".
- **Forms.** Inputs use `Field` labels. Errors are `role="alert"` cards (lucide `AlertTriangle`). The ambiguous chooser is a radio group.
- **Live region.** One visually hidden `role="status" aria-live="polite"` region announces:
  - the step ("Step 2 of 3: Find your footage")
  - per place, "24 of 24 clips found in School Library"
  - upload progress every 10% with the time left
  - Wi-Fi and server state changes

  It never announces every second.
- **Progress.** A native `<progress>` with `aria-valuetext="42 percent, about 8 minutes left"`.
- **Status never relies on color alone:** there is always an icon and text.
- **Contrast.** Body `#b4bbc0` and headings `#e1e6df` on `#111315` are both above 9:1. Muted `#90979c` is about 6.4:1. Mint buttons carry dark `#1a2a1f` text.
- **Focus and targets.** The existing 2 px mint focus ring. Targets are at least 44 × 44.
- **Zoom and width.** Usable at 200% zoom and at 390 px wide.
- **Illustrations are `aria-hidden`.** The written steps beside them carry every instruction.
- **Reduced motion.**
  - `MotionConfig reducedMotion="user"`, plus the existing global rule, so a guest's OS setting applies.
  - Each scene shows its final annotated frame, with numbered markers 1–2–3 matching the text steps.
  - No traveling chips, no particle burst, no shake (the border turns red instead), no lane glide, no rail slide.
- **Motion budget.** Animations stop by themselves after 3 loops (WCAG 2.2.2), and Replay starts them again.

---

## 12. Browser support and the package-drop caveat

| | Safari 17.4+ (macOS 13+) | Chrome / Edge 116+ | Firefox 124+ | iPhone / iPad |
|---|---|---|---|---|
| Folder drop (`webkitGetAsEntry`) | yes | yes | yes | blocked screen |
| `webkitdirectory` picker | yes | yes | yes | — |
| `crypto.subtle`, `AbortSignal.any` | yes (17.4) | yes | yes (124) | — |
| Web Locks | yes | yes | yes | — |
| Wake Lock | yes (16.4) | yes | no (the tips still show) | — |
| `queryLocalFonts` | no (drag fonts) | yes | no (drag fonts) | — |

**Feature gate on load:** `AbortSignal.any`, `crypto.subtle` and `DataTransferItem.prototype.webkitGetAsEntry`. If any is missing, the page shows the update screen. School Macs may be Safari-only and managed, so Safari is the first-class path.

**Package-drop caveat.** `.fcpbundle` and `.fcpxmld` are directories that Finder shows as single items. Nobody has yet checked how Safari's drag and its pickers hand them over. The design works whichever way they arrive:
- **The drop path expects a directory entry.**
- **0-byte or unreadable files, and zips,** get the "Show Package Contents" or "drag it instead" copy (§3.1).
- **For libraries,** dragging the folders inside the package still matches by path suffix.
- **For exports,** dragging `Info.fcpxml` out of the package works.

Konrad checks these on a real Mac in Safari and Chrome before shipping (§14.4). That check also decides whether the helper copy should lead or stay in `<details>`.

---

## 13. MCP coverage (same commit)

**`mcp/coverage.test.ts` `ROUTES`:**
```ts
'/api/auth/guest': 'no: guests are people typing their name at sharedcut.com/importer; the MCP runs as a signed-in account',
'/api/uploads/probe': 'no: the importer page times its own Wi-Fi before an upload; the MCP reports its real upload rate',
'/api/fcp/import/(fcp-[a-zA-Z0-9_-]{1,60})': 'job:fcp',
```
`GET /api/fcp/import` keeps the existing `'/api/fcp/import': 'job:fcp'` key.

**`mcp/jobs/export.ts` `importFinalCut`:**
- `locateSource` is unchanged. After it, the job stats each found source and calls `uploadImport(projectId, items, { signal, onProgress: p => report(…) })` in place of the sequential `uploadSource` loop.
- MCP imports therefore send the plan, upload 4 files at a time and show on Projects screens.
- New `class?` parameter, which maps to `class=1`.
- The doc line (240 characters or fewer) becomes `'{path: bundle folder from sharedcut.com/fcp.sh | .fcpxml, media?:[folders], rebuild?, project?:@h, fresh?, class?} imports a Final Cut Pro project, uploads its footage 4 files at a time; Projects shows it importing'`.
- One line is added to the `export` help topic: "No terminal needed: people can use sharedcut.com/importer in a browser (name and class code)."

**`scripts/import-fcp.mjs`:** after the import POST, it stats the located files and sends `PUT /api/fcp/import/<id> {files}` before its upload loop (3 lines). Drive-bundle imports then show on Projects too.

There are no new store actions: `fcpImport` is server-owned and read-only on the client.

---

## 14. Tests

### 14.1 `server/importer.test.ts` (new; `npm test`)
Uses node:test with a throwaway `createFrameLineServer` on a temp `dataDir`, the `sample` XML from `server/fcpxml.test.ts`, and env values saved and restored.

1. **Guest creation.** With `FRAME_LINE_SIGNUP_CODE` set:
   - no code or a wrong code gives 403; the right code gives 201 and a cookie
   - `/auth/me` shows `guest: true`
   - the 61st guest from one address within an hour gives 429
   - logging in as `<id>@guest.invalid` with any password gives 401, not 500
2. **Allowlist.** A guest gets 403 from `GET /state`, `GET /events`, `GET /library`, `POST /media` and `PATCH /projects/:id`.
3. **Direct roles only.** A member's class-shared Editor project gives the guest 404 on `GET /fcp/import/:id`, `PUT` plan and `POST /media/:id/upload`, and a 404 or 403 on `POST /fcp/import?projectId=…&rebuild=1`.
4. **Guest import.**
   - 201 with `shared: true, classRole: 'Editor'`, and a member's `GET /state` includes it.
   - In the member's view, the guest's email is blank.
   - The 6th import (`fresh=1`) gives 403, while the dry run gives 200 with `limit: true`.
5. **Dry run.**
   - It writes nothing: revision unchanged, project absent, no `data/fcp/<id>`.
   - Its ids equal the real import's.
   - `missingFonts` lists the fixture's family.
   - `state` goes `new` → (after the real import) `resume` → (edited XML) `changed` → (delete) `deleted`.
6. **Plan.**
   - An unknown id gives 400, an oversized file 413, a guest over `FRAME_LINE_GUEST_MAX_GB` 403, and a huge `FRAME_LINE_MIN_FREE_GB` 507 (with `needed` and `room`).
   - Another active import's outstanding bytes reduce `room`.
   - A good plan sets `fcpImport` to `{phase: 'uploading', total}`.
   - A mismatched fingerprint drops the partial file (`GET …/upload` reports offset 0).
7. **Status.**
   - Chunks advance `received`.
   - The last chunk with `FRAME_LINE_DEFER_PREP=1` gives `phase: 'processing'`; `updateAsset` to `ready` gives `phase: 'ready'` with `doneAt`.
   - A back-dated `updatedAt` turns `paused` on the housekeeping body; the next chunk flips it back to `uploading`.
   - A `PATCH /state` carrying a forged or stale `fcpImport` is ignored and does not 403 a Viewer's otherwise valid save.
8. **Guest upload.** An init POST without a plan gives 403; with a plan entry of the same size, 200.
9. **Expiry.**
   - The partial file of an importing project survives a 2-day back-date and the sweep.
   - At 8 days it becomes `stopped` and the partial is gone.
   - A non-import upload still expires at 24 h.
10. **Upgrade.**
    - `signup {upgradeGuest: true}` from the guest cookie without a code gives 201 with the **same user id**, after which `GET /library` gives 200 and the guest's projects are still owned.
    - A signup without `upgradeGuest` creates a separate account.
    - A duplicate email gives 409.
11. **Probe.** 2 MiB gives `{bytes: 2097152, room}`; 9 MiB gives 413; no session gives 401.
12. **`GET /api/fcp/import`** lists only the caller's unfinished imports.

**`server/fcpxml.test.ts` additions:**
- `importStatus`, as a table: uploading → processing → ready; the failed count; paused held until bytes move; the rate EWMA.
- `missingFonts` from `importFcpxml`.

### 14.2 `src/services/importer.test.ts` (new) and `src/services/upload.test.ts` (extended)
- **`matchSources`:**
  - a longer suffix beats a name-only match; NFD against NFC; case-insensitive
  - two `C0001.MP4` files on two cards resolved by volume name
  - identical copies picked silently; real ties reported as ambiguous; name-only matches flagged `weak`
- **`places`:**
  - a library group (Movies), and a library on a drive
  - a `/Volumes/SD CARD/DCIM` group
  - home groups capped at `/Users/u/<top>`; Desktop and Movies split into two groups
  - more than 6 groups merged
  - the breadcrumb text
- **`walk` with fake entries:**
  - batches of 100 read until empty
  - skip-list folders and `._*` files never walked or read
  - `file()` called only for wanted names
  - a failing `file()` skipped
  - the counter, and the 300k cap
- **`assignFonts`:** matches `fcp.sh`'s rule, and a row pick forces the family.
- **Estimates:**
  - `estimateSeconds`: one giant file against many small ones, and a resume subset
  - `lanesFor` thresholds
  - `friendlyDuration`: 30 → "less than a minute", 850 → "about 14 minutes", 7800 → "about 2 hours 10 minutes"
- **`uploadImport` with a mocked `fetch`:**
  - it sends the plan first
  - never more than `W` PUTs in flight, largest file started first
  - a network error then success resumes; a 409 re-syncs the offset
  - a 413 fails one file while the others finish
  - a 507 gates every lane; a 401 stops everything
  - resumed bytes do not inflate `rate`

### 14.3 Browser walkthrough with screenshots: `src/components/importer.browser.test.ts`
Run with `"test:importer": "node --experimental-strip-types --test src/components/importer.browser.test.ts"`.

It follows the `markers.browser.test.ts` pattern:
- build `dist` into a temp folder unless `DIST` is set
- Chromium (`PLAYWRIGHT_CHROME_PATH` or channel `chrome`)
- `createFrameLineServer({ dataDir: temp, distDir })` with `FRAME_LINE_SIGNUP_CODE='class-2026'`
- `pageerror` and console errors fail the run
- **any 403 or 5xx response during the guest walkthrough fails the run**, which catches a stray call the allowlist refuses

**Fixtures**, in a temp folder:
- 2 s 320×180 clips from `FFMPEG_PATH`'s `testsrc`:
  - `Movies/School Library.fcpbundle/Event 1/Original Media/A001.mp4`
  - `SD CARD/DCIM/100CANON/C0001.mp4`
  - `Desktop/Footage/C0001.mp4`, the same name with a different duration, on purpose
- Without ffmpeg, the clips are random bytes, `FRAME_LINE_DEFER_PREP=1` is set, and the test stops at Getting it ready.
- An `Info.fcpxml` pointing at `file:///Users/maya/Movies/School%20Library.fcpbundle/…`, `file:///Volumes/SD%20CARD/DCIM/100CANON/C0001.mp4` and one missing clip, with one title in "Barlow Condensed". `public/fonts/BarlowCondensed-Bold.ttf` stands in as the missing font file.

**Context A** (a guest, 1440×900) takes screenshots to `artifacts/qa/importer/NN-name.png`:

| # | Screen | Action and assertion |
|---|---|---|
| 01 | welcome | — |
| 02 | you, wrong code | type "Maya Chen" and a wrong code; error text visible |
| 03 | export | right code; `setInputFiles` the XML; "Got it: … 3 clips" |
| 04 | fonts | add the TTF; the row shows "added" |
| 05 | footage, first view | 2 place rows, the first scene names "Movies" |
| 06 | footage, partial | `setInputFiles` on the folder input with `Desktop/Footage`; the "different clip" message appears for `C0001.mp4` |
| 07 | footage, done | add `Movies` and `SD CARD`; "2 of 3 found"; "Continue without 1 clip" |
| 08 | check | matches `/This project is .+\. It might take (about .+\|less than a minute) to upload to SharedCut\./` |
| 09 | uploading | `page.route('**/api/media/*/upload', …)` holds PUTs; the number of held PUTs is at most the lane count |
| 10 | **B's library** | a member context on `/` shows "Maya Chen is importing a project from Final Cut" with a percentage, in the "Coming in from Final Cut" row |
| 11 | offline | release the PUTs; `context.setOffline(true)` for 4 s shows "Wi-Fi dropped"; back online it continues |
| 12 | getting ready | — |
| 13 | done | the claim form is visible |
| 14 | B's library | the card shows "New from Final Cut" (ffmpeg case) |

**Extra passes:**
- **Resume.** Hold the PUTs after the first file finishes, then reload A. Assert the Welcome card "Continue upload". Re-add the folders, assert the first PUT for the partial file has `Upload-Offset > 0`, and assert no PUT for the finished file (`page.on('request')`). Screenshot `15-resume`.
- **Upgrade.** Fill the claim form; `/auth/me` keeps the same id and loses `guest`. Screenshot `16-saved`.
- **Reduced motion.** `emulateMedia({ reducedMotion: 'reduce' })` on Export; `document.getAnimations().every(a => a.playState !== 'running')`. Screenshot `17-reduced-motion`.
- **Narrow.** At 390×844, `scrollWidth <= clientWidth`. Screenshot `18-phone-width`.
- **Keyboard only.** Tab and Enter from Welcome to Export, asserting `document.activeElement` is each step's h1.

### 14.4 Manual pass on a real Mac (last, on sharedcut.com, over Wi-Fi only)
Done by Konrad, in Safari and in Chrome:
1. Drag a `.fcpxmld` from the Desktop.
2. Drag a `.fcpbundle` from Movies.
3. Use "Choose folder…" on a library package.
4. Use "or choose it…" on a `.fcpxmld`.
5. Drop an SD card.
6. Use a library with "leave in place" media.
7. Close the lid for 2 minutes mid-upload.
8. Toggle Wi-Fi.
9. Run `schtasks /run /tn "SharedCut Restart"` mid-upload.
10. Close the tab, then continue.
11. Run a real 2–5 GB project and compare the estimate with the actual time, then tune the 1.08 factor.
12. Watch the card from a second machine.

---

## 15. Implementation plan (build order)

`npm test` stays green after each phase. All paths go through `node:path`; there are no OS tools and no symlinks.

**Phase 1: guests (server)**
1. `server/index.ts`:
   - Lift `limit()`, `codeOk()` and `openSession()` out of the signup and login block.
   - Add `POST /api/auth/guest`.
   - Add the signup `upgradeGuest` branch.
   - Add the `GUEST` allowlist after `requireAccount`.
   - Make `isGuest` and `roleFor` guest-aware.
   - Blank guest emails in `view()`'s users map.
   - Add the guest font cap in `POST /api/fonts`.
2. `server/fonts.ts`: add `countBy(uploader)`, one SQL line.
3. `src/state/models.ts`: add `User.guest?`.
4. `mcp/coverage.test.ts`: add `'/api/auth/guest'`.
5. `server/importer.test.ts`: tests 1–4 and 10.

**Phase 2: import routes and status (server)**
1. `server/fcpxml.ts`: `missingFonts` from `fontFor`; the pure `importStatus()`; import `fontKey` from `src/services/importer.ts`.
2. `server/index.ts`:
   - `dry=1`, `class=1`, guest sharing and the 5-import cap on `POST /api/fcp/import`.
   - `GET /api/fcp/import`.
   - `GET` and `PUT /api/fcp/import/:id`, with `plan.json`, `outstanding()` and `room()`.
   - `POST /api/uploads/probe`.
   - The guest plan check in upload init.
   - `importTick` and its hooks in the chunk PUT and `updateAsset`.
   - The housekeeping pause.
   - `expireUploads`: the 7-day keep and `stopped`.
   - The `putState` pin.
3. `src/state/models.ts`: add `FcpImport` and `Project.fcpImport?`.
4. `mcp/coverage.test.ts`: add the probe entry and the `:id` regex entry.
5. `server/importer.test.ts`: tests 5–9, 11 and 12. `server/fcpxml.test.ts`: the `importStatus` and `missingFonts` cases.

**Phase 3: client services and MCP**
1. `src/services/importer.ts` (new):
   - `fontKey` (moved here)
   - `walk`, `places`, `matchSources`, `checkFile`, `assignFonts`
   - `measureSpeed`, `estimateSeconds`, `lanesFor`, `friendlyDuration`
   - no store imports
2. `src/services/upload.ts`: export `fingerprintOf`, `recoverable` and `bytes`; add `uploadImport()` and the `ImportProgress` type. `src/components/UploadQueue.tsx` imports `bytes`.
3. `mcp/jobs/export.ts`: `importFinalCut` uses `uploadImport` and gains `class?`, the new doc line and the help line.
4. `scripts/import-fcp.mjs`: send the plan PUT before uploading.
5. `src/services/importer.test.ts` (new), plus the `uploadImport` cases in `src/services/upload.test.ts`.

**Phase 4: library and entry points**
1. `src/components/ProjectLibrary.tsx`: the `.drive-import` overlay and states, the aria-label, and the "Coming in from Final Cut" row.
2. `src/components/dashboard.css`: `.drive-import`, the chips, and the amber paused style.
3. `src/components/Dashboard.tsx`: the **Import from Final Cut** link. `src/components/AuthScreen.tsx`: the footer link.
4. `src/components/SharingFields.tsx`: hide `u.guest`.
5. `src/services/sync.ts`: a guest session in `connectSession()` goes to `/importer`.
6. `src/App.tsx`: `?next=/importer` after sign-in; `loadCaptionFonts()` and `captions.css` moved in from `main.tsx`.

**Phase 5: the importer page**
1. `src/main.tsx`: lazy-load the importer or App by path, inside `<Suspense fallback={null}>`. `styles.css` and `StaleBuildBanner` stay.
2. `src/components/Importer.tsx` (new):
   - the shell, rail and step machine: `you → export → (decide) → (fonts) → footage → check → upload → ready → done`, plus `blocked`
   - all the copy in §2
   - the window drop routing
   - the probe, the Start sequence and `uploadImport`
   - the Web Lock, Wake Lock, `beforeunload` and title
   - the poll, the claim form and the error boundary
3. `src/components/ImporterArt.tsx` (new): A1–A9, the name tag, the Finder scene with `{sidebar, item, kind}`, the Font Book scene, the gauge and the lanes. Each has a meaningful last frame and Replay.
4. `src/components/importer.css` (new): the layout, the large buttons, the drop overlay, the rail, the place rows, the scene keyframes and the narrow layout. It uses the tokens from `styles.css`.

**Phase 6: verification and ship**
1. `src/components/importer.browser.test.ts`, and the `test:importer` script in `package.json`.
2. Run `npm test`, `npm run build` and `npm run test:importer`, and review the screenshots in `artifacts/qa/importer/`.
3. Do the manual Mac pass (§14.4) on sharedcut.com, then ship through the usual mac → Dell flow (`git push dell HEAD:mac-incoming`, build, `schtasks /run /tn "SharedCut Restart"`).
4. Add one README line: "Final Cut → SharedCut without a terminal: sharedcut.com/importer".

---

## 16. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Safari hands over `.fcpbundle` or `.fcpxmld` drags as files or zips | Students can't add a library or export | Detection plus "Show Package Contents" copy; suffix matching works on inner folders; checked on a real Mac before ship (§14.4) |
| The host's disk is tight (the Dell had 11 GB free in October) | Imports stall mid-upload | `room()` with × 1.25 headroom and other imports' outstanding bytes at Check and at the plan; 507 pauses and retries instead of failing; the guest byte cap |
| The × 1.25 processing headroom is a guess | Processing could fill the disk | `ponytail:` note; measure full-v3 and stream sizes on real imports and tune it |
| The XML crosses the tunnel twice (dry run, then real) | Slow for very large XMLs | The 95 MB client guard; typical XMLs are under 5 MB |
| Estimate accuracy on school Wi-Fi | "about 14 minutes" turns into 30 | Two-phase probe, a lane-aware simulation, a rolling live ETA after 10 s, and calibration of 1.08 in the live pass |
| Lid closed or Mac asleep during long uploads | Upload stops | Tips copy, Wake Lock, automatic resume on wake, partial files kept 7 days, Continue upload |
| A shared school Mac keeps a guest cookie | The next student imports as the previous one | Welcome shows "Welcome back, Maya. Not Maya? Start fresh"; signup without `upgradeGuest` never takes over a guest |
| A guest loses their cookie | The project has no reachable owner | It is class-shared as Editor, so classmates and the teacher can still edit it. `ponytail:` an owner-transfer action, added when a teacher needs one |
| Guest accounts pile up in the user list | Clutter | Hidden from share pickers; emails blanked. `ponytail:` cleanup of guests with no projects, added when the list gets noisy |
| A persist every 5 s per importing project broadcasts to every client | Extra delta fetches | The same rate media progress already uses; deltas are one project row; the plan stays off the row |
| `importTick` stats up to 5,000 files | CPU every 5 s | Throttled; about 10 ms per tick |
| Lane count on very slow links | 60 s request timeouts | `lanesFor` keeps at least 0.5 MB/s per lane, and a timeout drops a lane |
| A false "different clip" on variable-frame-rate or trimmed media | A valid clip is flagged | Tolerance of max(0.5 s, 1%), "Use it anyway", and unreadable codecs count as ok |
| The ponytail notes have known limits | — | Per-file single-connection ceiling (add range writes if one clip usually dominates and senders exceed about 8 MB/s); no end-to-end file hash (per-chunk SHA-256 covers transit); fixed 4 lanes at most |
