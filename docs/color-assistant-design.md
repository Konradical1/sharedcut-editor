# Color Assistant — design (approved 2026-09-27)

An AI helper inside SharedCut's Color page. It does repetitive finishing work (evening out shots, matching
cameras, proposing looks). It does not pick shots or tell the story. **The model only proposes numbers. SharedCut's
own color engine does every transform and renders every preview.**

Read first: `CLAUDE.md` (Windows/Mac rules), `docs/color-reference.md` (Sept 26 update: the corrected pipeline and
how it was validated), `src/services/color.ts`, `src/services/colorPreview.ts`, `scripts/color-render.py`,
`src/workspaces/ColorWorkspace.tsx`, `server/cameraMetadata.ts`.

## Decisions (Konrad, 2026-09-27)

| Question | Decision |
|---|---|
| Who can run it | Only Konrad. Collaborators may see the results, but they cannot trigger AI calls. |
| AI connection | Konrad's Codex login (ChatGPT plan) via `codex exec`. No API key for now. |
| Model | `gpt-6-astra` (the best available; tested OK on Codex CLI 0.157.1). Configurable. |
| Training setting | Left as is. The stills sent may be used by OpenAI for training; Konrad is fine with that. |
| Output transform | ACES 2 Output CST stays fixed. The assistant edits only Balance and Look nodes (plus extra look nodes it adds). |
| Three looks | The model decides the three looks. An optional text prompt steers them ("cool, dramatic night scene"). The three always climb in intensity: **1 close to natural, 2 goes a little crazy, 3 all-out cinematic, dramatic, super stylized.** Be genuinely creative. Everything stays editable afterwards. |

## The pipeline it builds on (already fixed and validated)

The clip grade runs camera log → **Input CST** (color space transform) → DaVinci Wide Gamut / Intermediate working
space → **Balance** → **Look** → **Output CST (ACES 2, Rec.709 Gamma 2.4)**.

- Camera input comes from the camera's own metadata (`server/cameraMetadata.ts`). Sony S-Log3 / S-Gamut3.Cine and
  Canon Log 3 / Cinema Gamut are verified. Assets carry `cameraMetadataVersion: 2`.
- Preview (WebGL, `colorPreview.ts`) and export (OpenColorIO, `scripts/color-render.py`) match an independent
  OpenColorIO reference to under one 8-bit level. Reuse these engines; never add a second color implementation.

## User experience

- A new **Assistant** tab in the Color page's right panel (next to Library / Settings in `ColorWorkspace.tsx`).
  Only Konrad sees it.
- **Scope:** the selected shot(s) or the whole timeline. Add multi-select to the shot strip if it doesn't exist
  yet (Ctrl/Cmd-click, Shift-click).
- **Actions:**
  1. **Three looks** — optional prompt box. Result: three option cards, each with rendered stills of 2–3 shots
     (before/after), a name, and a one-line description.
  2. **Balance shots** — evens out exposure and white balance across the selection.
  3. **Match to reference** — pick a reference shot; the other selected shots are matched to it (for example Canon to Sony).
- Each result shows per-shot **confidence** and **warnings**. **Apply** writes normal node values in one undo
  step, after an automatic snapshot. **Regenerate** asks again. After applying, everything is editable in the
  nodes as usual.
- A progress state while it measures, calls the model and renders. The last result stays in the panel.

## Architecture

### 1. Sample frames and measure (server, no AI)
- For each shot: 5 frames spread over the used source range (sourceIn … sourceIn + duration × speed). Skip 0.25 s
  at each end (transitions).
- Decode from the **original** with the same matrix/range handling as export (`videoFilters` in `server/media.ts`).
  Downscale to about 640 px wide. Run the clip's stages **up to the Balance node**, so values are in the working
  space. Cache the frames as float arrays keyed by (asset, source times, grade hash of the earlier nodes).
- Measure per frame, then aggregate per shot:
  - luminance percentiles (p1/p10/p50/p90/p99) in stops relative to 18% gray
  - clipped fraction
  - R/G and B/G ratios in shadows, mids and highlights
  - a neutral / white-balance estimate
  - skin-tone fraction and mean hue
  - saturation p50/p90
  - frame-to-frame variation (lighting change inside the shot)
- Implement in Python in `.venv-color` (NumPy + OpenColorIO), reusing `scripts/color-render.py`'s stage code.
  Refactor it into an importable module if needed. Run it through `FRAME_LINE_COLOR_PYTHON` like existing jobs.
  Cross-platform only (no macOS tools).

### 2. Render proposals (server)
- Apply a proposal's Balance/Look values to the cached working-space frames with the same `color-render.py` code
  and the ACES 2 output. Encode JPEG stills (about 640 px) for the UI.
- These renders must equal what Apply produces. Check with the capture/compare harness in
  `artifacts/qa/color-camera-2026-09-26/scripts/` (target: under 1 level mean vs the live preview).
- Three looks get one review: the model sees its first looks rendered (up to 2 shots: before + 3 looks) with their
  measured change from before (mean 8-bit levels and the hue/saturation part), and may revise them toward the
  per-look bands (`LOOK_BANDS`). A failed or invalid review keeps the first answer. Bands and the prompt's screen
  scale were measured on real footage; retune with `scripts/color-assistant-tune.mjs` (real Codex, 2 calls a run).

### 3. Model call (server)
- `server/colorAssistant.ts` owns a single job queue (one Codex call at a time; the docs allow one job stream
  per `auth.json`). Timeout 180 s. Cancel through `server/processTree.ts`.
- Command, prompt via stdin, run in an empty temp dir:
  `codex exec --ignore-user-config --ephemeral --skip-git-repo-check -s read-only --disable shell_tool
  -c web_search="disabled" -m <model> -C <tmp> -i <still>... --output-schema <schema.json> -o <out.json> -`
- The executable comes from `FRAME_LINE_CODEX`. Windows default: the npm vendor `codex.exe`, e.g.
  `%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`.
  Node cannot spawn the `codex.cmd` shim without a shell. On Mac/Linux the default is `codex`. The model comes
  from `FRAME_LINE_AI_MODEL` (default `gpt-6-astra`).
- `--ignore-user-config` matters. Konrad's personal config loads MCP servers, hooks and skills.
- The live server runs as Windows user `<user>` (elevated scheduled task, S4U), so it uses his existing
  `codex login`.
- Add `FRAME_LINE_AI_PROVIDER=fake` (returns fixed valid JSON) for tests. No API-key provider yet; add one only
  if collaborators ever need to run it.

### 4. What the model may return (JSON schema, enforced twice)
- **Balance:** exposure, temperature, tint, and lift/gamma/gain/offset R/G/B deltas.
- **Look:** contrast, pivot, saturation, lift/gamma/gain/offset (+R/G/B), and custom curves (RGB/R/G/B, ≤ 8
  points each). Extreme looks may add up to 2 extra serial look nodes, placed before the Output CST.
- **Per shot:** `confidence` 0–1, `warnings` (enum + short text), a one-line `rationale`.
- **Three looks:** exactly 3 options, each with `{name, intensity: natural|bold|extreme, description, nodes}`.
- **Limits:** use tighter limits than the engine's (`colorStages` in `color.ts`), e.g. exposure ±3, temperature
  ±2000, tint ±100, contrast 0.5–2.5, saturation 0–200, wheel deltas ±0.4. Validate curves with
  `validateGradeNode`. Invalid output is rejected as a whole; nothing is partly applied.

### 5. Match to reference
- SharedCut computes a deterministic first guess from the measurements:
  - exposure from the p50 difference
  - temperature/tint from the neutral estimates
  - R/G/B gain/lift from per-channel percentile matching in the working space
- The model sees reference and target stills, before and after that guess, plus the numbers. It accepts,
  adjusts within limits, or flags a bad match (different lighting, day vs night, different subject).

### 6. Apply
- New store action (in `src/state/store.ts`). It saves a snapshot, then writes all Balance/Look node changes
  for all affected clips in **one** `commit` with a change list, so it is one undo. `initializeColorGrade`
  uses the same pattern.
- It never touches CST effects, camera labels or keyframes. Shots still on the legacy pipeline first need
  "Start wide-gamut grade" (offer it; it snapshots).

## Uncertainty rules (never invent camera settings)
- No verified camera profile → skip the shot with "set the camera input first". Never set the Input CST.
- Output CST not ACES 2 → show the existing **Use ACES 2 output** fix first.
- High clipping → warn that clipped highlights can't be recovered.
- Lighting changes inside the shot → warn (keyframed grades are out of scope for now).
- Low model confidence or large measured residual after a match → mark "check this shot".

## Data sent to OpenAI (show this in the panel's info popover)
Per request: up to about 10 JPEG stills (about 640 px) of graded frames, the measurement numbers, shot names,
camera model and log type, and the style prompt. Never the original video, audio, other projects or user data.
It goes through Konrad's ChatGPT account, so it counts against his Codex limits (Pro: hundreds of messages per
5 hours). OpenAI may use it for training, per his current setting.

## Server API (all require Konrad's account)
- Allow-list the user via `FRAME_LINE_AI_USERS` (comma-separated account ids such as `user-…`; Konrad finds his in `/api/auth/me`). Ids, not emails, because any user can change their own email. If it is unset, the feature is off.
  The server rejects everyone else; the UI hides the tab.
- `POST /api/projects/:id/color-assistant` with body `{mode: 'looks'|'balance'|'match', clipIds, referenceClipId?, prompt?}`
  returns `{jobId}`. `GET` it for progress, result JSON, still URLs and warnings.

## Build order
1. Measurement and cached working-space frames, with tests on synthetic frames plus one real clip.
2. Codex adapter, schema, fake provider, owner check.
3. **Three looks end to end** (panel, prompt, renders, apply, one undo). This is the feature Konrad wants first.
4. Balance shots.
5. Match to reference.

Tests: schema/limit rejection, owner-only, apply = one undo + snapshot, renders equal the live preview. Also one
manual real Codex call. Verify live on sharedcut.com as a signed-in user after deploying (see memory).

## Open items before starting
- FischMedia2026Reel C0518 and C0539 still have Output CST "Tone mapping: None". Konrad can click
  **Use ACES 2 output** on each, or it can be applied with a server restart (Windows admin prompt; he must click Yes).
- The Sept 26 color fix is uncommitted in the working tree: `server/cameraMetadata.ts` (+ test), `server/media.ts`,
  `server/index.ts`, `src/state/models.ts`, `src/workspaces/ColorWorkspace.tsx`, and 3 docs. Another session also
  has uncommitted work in the tree. Don't revert either.
- The reviewed version of the startup camera check in `server/index.ts` goes live at the next server restart.
