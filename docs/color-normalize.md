# Normalize & Group

Automatic exposure, black level and white balance for shots, and color groups whose shared grade changes every member.
Color page: **Auto balance** (grade header), the **Groups** tab, the shot menu; Edit page: clip menu **Normalize & Group…**.
MCP: job `color-normalize`, store actions `normalizeColorGroup`, `setColorGroup`, `updateColorGroup`, `renameColorGroup`.

## Pieces

| Where | What |
|---|---|
| `scripts/color-normalize.py` | The analysis (`normalize job.json`, `--selftest`). Reuses the Color Assistant's working-frame cache and SharedCut's own engine (`color-render.py grade()`). |
| `server/colorNormalize.ts` | The job: builds each shot's stages, runs the worker, cleans its answer. `POST/GET/DELETE /api/projects/:id/color-normalize[/:job]`. |
| `src/services/colorGroups.ts` | Shared: `normalizedGrade()` (the grade after Normalize), `normalizeStages()` (what the job measures), group helpers. |
| `src/state/store.ts` | Applies a result in one undo step (snapshot first); keeps every member's group node identical. |
| `src/components/NormalizeDialog.tsx`, `ColorGroupsPanel.tsx` | The dialog and the Groups tab. |

## Data model

No new collection. Membership is `clip.properties.colorGroup = "cg-…"`. The group's shared grade is one ordinary
correction node per member, `node.group = "cg-…"`, named after the group, right after the shot's Balance node:
Input CST → Balance (per shot, automatic) → Group (shared) → Look → Output CST. All members' group nodes hold the same
values; `updateColorGroup` (and `updateNode` on a group node) writes them all. The render engines see a normal node.
Group nodes are never keyframed and hold no effects.

## How it decides (DaVinci Wide Gamut linear, before Balance)

- **White balance**: the strongest near-neutral colour cluster, weighted by brightness, by the camera's own balance
  (daylight–tungsten casts believed sooner than green/magenta; cool ones sooner than warm, because wood floors, skin and brick
  are warm), by a grey-edge estimate (flat coloured floors and grass carry no edges) and by the same camera's other shots.
  With no clear neutral (stage or festival light) it stays near the camera's balance. Same camera, small differences = one balance.
- **Exposure**: the group keeps its own level (a night game stays a night game) plus a little lift; each camera is matched to
  that level; each shot is evened out about halfway toward its camera's level, the way a colourist does by eye. A display
  guard keeps highlights from newly clipping.
- **Black level**: deep shadows come down to ~6/255 when lifted; exposure then buys the mid-tones back.
- **Phones / finished video** (Rec.709, HLG through the export's HDR→SDR table): no highlight headroom, so a mid-tone gamma
  with white pinned brings them to the camera shots' on-screen level.

## Tuning and testing on real projects

Measured on VB2 (two Canon bodies), BoySoccer (night game) and BLINK (light festival + iPhone HLG), October 2026:
camera-to-camera mid-tone gap went from 0.40 vs 0.49 to 0.53 vs 0.54 (VB2) and 0.15 vs 0.28 to 0.27 vs 0.27 (BoySoccer);
shot-to-shot spread within a camera roughly halved; BLINK's iPhone clips land on the Canon level (0.25 vs 0.25).
Change the constants at the top of `color-normalize.py` (KAPPA, BLACK, POOL, `level_offset`) only after rendering
before/after sheets of real shots, never on the synthetic self-test alone. `npm run test:color-normalize` must stay green.
