# SharedCut: smooth playback and a host that stays up (revised plan)

## Answer first

We fix the cause of the host overload first, add per-browser reports second, and build the flat review video only if measurements show it is needed.

**1. The overload most likely comes from our own preview renders, not from heavy use.** For the Girls Soccer timeline, each "preview" the server renders first bakes (pre-renders) the whole 135-second nested composition at 4K, plus the Stabilize and optical-flow clips, whatever 4 seconds were asked for (media.ts:769, 1903). Two previews times three parallel ffmpeg processes at about 1.9 GB each matches the six processes and 11 GB seen at 20:30. A composition bake was running again at 21:22 today. Who asked for those previews is not yet known (a log line in the first server release will tell us). Nothing cancels a preview when the viewer leaves, and nothing checks free memory before starting a process.

**2. Sophie's slow playback is proven only for one stretch.** The slow-computer run (3.7 to 4 pictures/s) covers the opening of the timeline. A read-only count by one reviewer found all 54 colour-graded clips start in the first two minutes, about 4.3% of the video time. Nobody has measured the other 96% on a slow computer. So the review video is not built until short test runs say the problem is wider than that opening.

**3. Honest limit.** The 19 hard resets since 9/5 look like power or graphics-card trouble (no blue screen, none since 9/29). Today's 0.3 GB-free episode caused heavy swapping but no reset. The memory work protects responsiveness; it cannot prove the resets fixed. The Lenovo move stays the long-term answer.

## What changed after review

- The memory guard (an admission gate: a job may start only when enough memory is free) is now opt-in at the few heavy start points instead of sitting in front of every process. Health checks, probes and stream-copy steps are never delayed.
- No forced starts. A hard floor of 3 GiB (a GiB is a gibibyte, about 1.07 GB) always holds; waiting longer only changes the status text.
- The guard runs in "watch only" mode for about a day before it blocks anything. Cause fixes are on from day one. A switch file changes modes without a restart.
- Memory is measured as the smaller of "available" and "commit headroom" (the memory Windows can still promise to programs), because the commit limit is the real wall.
- The two .env changes are dropped. They raise the threads per ffmpeg process (8 to 12 per export pass, 3 to 8 per media job), so they do not simply reduce load (media.ts:198-205, 229, 1273).
- Reports are stored in plain daily text files, not SQLite. A damaged database file cannot stop the server booting if there is no database.
- A lock bug is fixed: after any server restart every open tab ignores lock updates for the rest of its session (index.ts:407 starts the counter at 0, sync.ts:111 drops older numbers).
- The speed test for the review video now measures the real renderer with the real colour tables, because the draft's hand-built command left out the 129-point colour table (a 60 MB file) that graded clips use.
- Nothing playback-related reaches production without a measured run, which needs your go.

## What we know and what we do not

| Question | Evidence | Status |
|---|---|---|
| What started the six ffmpeg? | previewCache.ts:25-28 skips only Depth; media.ts:769 bakes a composition if ANY is on the timeline; media.ts:1903 renders it from 0 | Mechanism confirmed. Requester unverified. |
| Does a failed or cancelled preview ever retry? | previewCache.ts:27 returns any non-ready record unchanged until 64 newer ones push it out | Existing bug. Fixed in the first release. |
| Does the memory guard cover every heavy process? | No. Seven other spawn sites exist (captions.ts:17, captionRender.ts:33, graphicsRender.ts:57, depth.ts:62, smartMask.ts:172, linkImport.ts:44, codexExec.ts:37) | We gate only the sites the incident showed. The real Available reading still sees the rest. |
| Does a 4-second preview cap its threads? | Only single-pass ones. renderSplit recomputes threads (media.ts:1273) | Previews are forced to one pass with 4 threads. |
| Is the live site's dist folder safe to swap? | One generation of hashed files; old tabs lose lazy chunks | Copy-only deploy script plus a "reload" notice. |
| Is /api/health safe to gate? | It runs ffmpeg and ffprobe on every call (index.ts:759, media.ts:93-98), and the tunnel watchdog kills the tunnel after 3 misses | It spawns nothing after the fix (cached 60 s). |
| Girls Soccer facts | 576 clips on the main timeline, 172 assets, 9 clips with Stabilize (enabled state unchecked), 171 of 172 assets have a separate audio file | Corrected. The audio worry is closed. |

## Plan in order

| Step | What ships | Restart |
|---|---|---|
| M0, now | Read-only status, safer restart script, separate code copy, memory-capped test runner | No |
| M1, release R1 | Cause fixes, memory guard (watch only at first), pressure response, host health log, lock fix, server half of reports | Yes, one |
| M2, browser release | Per-browser report (observer only) and your Health page | No |
| M3, browser release | Behaviour fixes for flaky links and server restarts | No |
| M4, decision gate | Short measured runs, with your go, decide what comes next | No |
| M5 or M6, only if M4 says so | A targeted fix for the graded opening, or the review video | M6 only |
| M7, optional | Composition bake limit, crash dumps, black-box logger | Some |

M2 and M3 are checked by one short test session, with your go, before the browser files are swapped in.

## Host protection (M1)

**Stop the cause.** The preview request keeps only clips that can touch the 4-second range, and strips waveform and thumbnail data before the server copies the project (that copy is about 6.6 MB per request today). The fingerprint of a preview is then computed from only what matters, so an edit elsewhere does not invalidate it. A new check, bakeReason, built from the same tests renderTimeline uses (lines 767-787), makes a preview "skipped" (the browser plays that part live) when the range needs a bake. A lease (a 6-second timer renewed by every browser poll) cancels a preview nobody asks about, and a preview that has not started within 30 seconds is dropped too, so two stuck jobs cannot cause minutes of "queue busy". Cancelled records are deleted and failed ones retry after 60 seconds. Each new preview logs who asked. Previews run as one pass, 4 threads, Idle priority.

**Memory guard.** Heavy starts ask for permission first: the render pass encode, media preparation encodes, baked-clip encodes, and the Python workers. A job starts only if the smaller of Available and commit headroom, minus memory promised to jobs that started in the last 20 seconds, minus its own cost, stays above its class reserve: export 4 GiB, prepare and AI 4 GiB, preview 6 GiB. Never below the 3 GiB floor. At today's 10.4 GiB available, an export still gets three passes (it leaves 4.7 GiB); a fourth process waits. Waiters are checked every 1 to 2 seconds in priority order, so a small job can start past a big one that cannot fit, until the big one has waited 30 seconds and earns a reservation. A preview never queues for memory; it is refused and the browser backs off. Waiting jobs show "Waiting for memory".

**Pressure response, on from day one.** If memory stays under 2 GiB for 5 seconds, running previews are aborted first, then filmstrip and waveform jobs. Exports, AI jobs and uploads are never killed; they only log and show "Low memory". Cooldown 20 seconds.

**Evidence.** A health log (one line every 30 seconds, rotated at 5 MB) records Available, commit headroom, battery state, GPU memory and temperature, CPU performance, event-loop lag, queue sizes and the live ffmpeg and Python children. The next reset leaves a trail.

## Per-browser reports and the Health page (M2)

Every browser adds one small block of about 20 numbers to the presence message it already sends (presence is the "who is in which project" message). The old server ignores unknown fields. The block holds pictures per second against target, share of time loading, longest freeze, what it waited on (colour, decode, buffer, seek), link speed, round-trip time, device facts, the build, and the playhead minute so stalls can be placed on the timeline. Runs from the test harness are flagged and shown separately. Only numbers leave the browser: no clip, file or project names. A Settings switch turns reporting off.

The server keeps the latest 30 minutes per browser in memory and appends one row per browser-minute to a daily text file (one JSON record per line, kept 14 days, about 2 to 3 MB a day). A damaged last line is simply skipped. Only accounts you list can open the Health page; everyone else gets "not found".

The page shows the host (free memory, commit headroom, queues, running processes) and one row per person with a traffic light and a plain sentence such as "Computer too slow: 4 of 30 pictures/s, 51% waiting on colour processing". Lights are computed when read, so thresholds can be retuned later.

| Light | Starting rule |
|---|---|
| Green | at least 93% of target pictures/s, loading under 5%, longest freeze 0.4 s or less |
| Red | under 60% of target, or loading over 25%, or a freeze over 2.5 s |
| Amber | everything else |

## Browser fixes (M3)

Back off when the server says "queue busy" (2 s growing to 15 s, with jitter). Never ask the host for previews from a browser running on the host itself. Pause background downloads of far-ahead footage while playing on a slow link (the likely cause of the first-seconds freezes at 10 Mbps, a prediction). Stop giving up on footage forever after three failures (footageCache.ts:380 sets "never retry"); cap the wait at 60 s. Reconnect the live-update channel after a restart; if it closes, a tab posts presence about 10 times a second (sync.ts:372). Show "new version, reload when convenient" instead of a blank screen if an old tab cannot load a piece of the app. Deploys become copy-only and keep the previous hashed files.

## Decision gate (M4) and what follows

With your go, four 30-second runs: the opening plus minute 10 and minute 40 on a 4x slower computer, one run with the opening on the existing low picture-size setting, and a profile of the opening. Plus two or three days of Sophie's own reports.

- If the ungraded stretches hold 24 or more pictures/s on the slow setting, the problem is the graded opening only. M5: a longer colour warm-up before each cut, or pre-render only the 29 graded chunks. No review video.
- If they also struggle, M6: the review video, built in three steps. First a speed test using the real renderer, the real 129-point colour table and the logo overlay blend, under background load. Then host segments, 540p, picture only, one at a time, in their own queue lane outside the media queue. Then the browser player, which only trusts a segment while no edit overlaps it, and takes the frame rate from the server's answer. The test stops at a median above 2.7 s per 4-second segment.
- If Sophie's reports show a slow link, not a slow computer: stop.

## While you are editing

- All work happens in a separate copy of the code folder. The live folder runs known-good code until the one planned restart. A laptop reset mid-work boots known-good code.
- Builds and tests run under a Windows Job Object (a system-enforced memory cap that kills the whole tree) of 4 GiB, and refuse to start under 10 GiB free. Preferably they run on your Mac. No full test suite, no GPU tests, no harness without your go.
- Browser updates need no restart. Your open tab keeps its old version until you reload.
- A restart refuses connections for roughly 10 seconds (unmeasured; the rehearsal times it). Your tab shows offline and re-sends your last change. Running exports restart from zero, uploads still processing show Retry, caption jobs fail, locks and presence reset. Before it I check, read-only, that no export is rendering, nothing is uploading or processing, nobody is playing or dragging, no test is running, and I wait for your go. The tunnel watchdog is paused for the window.
- Before the restart the exact commit boots on another port with a temporary data folder and answers its health check.

## Risks

| Risk | How we would know | What we do |
|---|---|---|
| The guard stalls jobs | host log shows waiters over 2 minutes while memory is free | Switch file to watch-only or off, no restart |
| Exports slow down | Time one export before and after. Pass counts are not changed; the 14% figure is only 3 versus 2 passes | Lower the reserves |
| Cost guesses wrong (only 1.9 GiB per 4K pass is measured) | Watch mode logs the real memory drop 20 s after each start | Correct the table |
| Commit reading fails | CIM query empty or localized | Falls back to Available only |
| Telemetry breaks editing | It runs in try/catch and cannot open a database | Dropped silently |
| Hard resets continue | Kernel-Power 41, WHEA 17 counts, crash dump | Hardware answer |
| Disk fills (C: hit 0.2 GB on 10/1) | Disk check before renders | Cap review cache at 2 GiB |

## Disk footprint

Health log 10 MB at most, report files about 40 MB over 14 days, review cache 2 GiB only if M6 ships, dist-next a few tens of MB, worktree small (node_modules is a junction). Pagefile is left system-managed; a fixed 40 GB would take half of the 83 GB free.

## Rollback

R1 adds no workspace tables. Report files and the health log are plain files older builds ignore. The new account setting is merged as-is (index.ts:740, unverified). Rollback is revert plus restart. Never run npm install in the worktree (it writes through the junction), and remove the junction with cmd /c rmdir before git worktree remove.

## Not verified

Who requested the two previews. Whether slowness exists outside the graded opening. Sophie's computer. Review render speed on the real graph. Whether the live-update channel closes for good behind the tunnel. Restart duration. How much memory the Python workers use. Whether Job Object setup works on this machine. How often animated clips (not only compositions) force a bake.
