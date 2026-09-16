# Color workspace overhaul

Status: first implementation completed and locally validated, September 13, 2026. See [validation and remaining reference checks](color-overhaul-validation.md). Existing project grades are preserved until the user chooses Start wide-gamut grade.

## Agreed direction

- Resolve-like layout and interactions, clearer labels, and a focused effects library.
- Explicit editable input and output Color Space Transform (CST) effects, with DaVinci Wide Gamut / DaVinci Intermediate as the default working space.
- Support Sony S-Log, S-Log2, and S-Log3; Canon Log workflows for EOS R6 and EOS R6 Mark II. Retain existing Canon Log 2 support.
- Basic correction and grading first. Masks, tracking, parallel/layer mixers, temporal noise reduction, and a full OFX catalog are outside this pass.
- Screenshots are visual references for the Library / Settings panel, not a requirement to implement every pictured blur effect.

## Findings in this workspace

- `ColorWorkspace.tsx` drops scope updates based on a timer: normally the saved scope refresh setting (15 fps fallback), and 4 fps in efficient playback mode. A dropped final update need not be followed by another frame while paused.
- The viewer already publishes completed frames. Scopes can follow that event instead of running a separate refresh schedule.
- Native camera conversion applies a fixed SDR shoulder before correction nodes. Curves and several primary operations clip values, so adding DWG dropdowns alone would not create a usable wide-gamut pipeline.
- Curves expose three fixed horizontal positions, move only vertically, and interpolate with straight segments.
- Nodes are flexbox cards with decorative arrows. The model stores serial order but has no canvas positions or node effect stack.
- Global Control/Command-D duplicates a clip; Backspace/Delete deletes a clip. Color interactions need contextual shortcut handling.
- CPU color equations feed original-media exports through a sampled 3D LUT; GPU preview has a separate implementation. Both must be updated and compared.
- The project database identifies 15 Newspaper originals as S-Log3 / S-Gamut3.Cine. Direct inspection of C0965.MP4 confirms the embedded profile and 3840×2160, 10-bit 4:2:2 H.264, full range. Eight other video assets have no saved camera profile. No Canon camera recording has been positively identified during this audit.
- The current browser direct-plane path accepts only 8-bit YUV formats. Float shader calculations do not restore precision already lost during source decode or proxy creation.

## 1. Establish the color pipeline and compatibility

Default starter chain:

    Camera log → Input CST → Balance → Contrast / Look → Output CST → Rec.709 Gamma 2.4
                  └──────── DaVinci Wide Gamut / Intermediate ────────┘

The starter action creates ordinary editable nodes. Users can inspect both transforms and add corrections between them. Direct camera-log-to-Rec.709 transforms remain available manually.

- Separate gamut and transfer function identities; Rec.709 primaries and Gamma 2.4 are distinct selections.
- Implement decode → linear gamut conversion → encode using published camera and DWG/Intermediate definitions. Validate Sony S-Gamut, S-Gamut3, S-Gamut3.Cine and applicable documented camera variants; retain Canon BT.709, BT.2020 and Cinema Gamut choices. Handle any source-white-balance dependence required by legacy camera definitions explicitly.
- Support Sony S-Log/S-Log2/S-Log3 and Canon Log/Log 2/Log 3 transfer functions. Camera presets constrain the suggested pairs, while the CST exposes independent settings.
- R6 presets: Canon Log with BT.709/BT.2020; Canon Log 3 with BT.709/BT.2020/Cinema Gamut. R6 Mark II presets: Canon Log 3 with those three gamuts. Do not label Canon Log 2 as an R6 recording mode.
- Preserve floating-point, negative, and above-display-range values through the working chain. Define safe out-of-range behavior for primaries and curves; compress/clamp for output only where the selected mapping requires it.
- Exposure in stops operates in scene-linear light when grading log; white balance and saturation use the current working-space definitions. Do not reuse display-space exposure math unchanged in Intermediate.
- CST Settings: input gamut, input gamma, output gamut, output gamma, Swap, reset, enable, and remove. Tone mapping and gamut compression are separate controls with None options, and a documented SDR mapping enabled in the starter output CST.
- Validate the technical transforms independently of the artistic display rendering. Matching published DWG/Intermediate mathematics does not establish equivalence to Resolve's proprietary tone mapping or wheel response.
- Audit source range/matrix/bit depth through decoding, proxy generation, grading and export. Use higher-precision original preview where supported and label proxy/fallback precision accurately. Treat the original-versus-proxy comparison as an early acceptance gate.
- Use metadata evidence when available; an ordinary BT.709 container tag is not proof that a camera clip is non-log. Expose manual interpretation and data-level overrides for ambiguous media.
- Keep old projects on their existing rendering behavior. Offer the new starter workflow on a copied/reset grade with a recoverable snapshot. Preserve imported Resolve LUT looks without silently applying a second input/output conversion.

## 2. Build the color layout and node interactions

- Top: large viewer on the left, a usable node canvas beside it, and a collapsible/resizable Library / Settings panel at the far right.
- Middle: compact shot strip with obvious active-clip selection.
- Bottom: a large tool area with Primaries / Curves tabs and adjacent resizable scopes. Give the active tool room instead of squeezing wheels, curves and scopes into fixed small panels.
- Reuse existing panel-resizing and numeric-control patterns. Add readable labels, visible focus, keyboard equivalents, reset affordances, and precise numeric entry.
- Freely drag nodes using pointer capture. Persist canvas positions separately from processing order. Moving a card alone must not alter the grade.
- Draw continuous port-to-port connection lines. Start with one serial chain; allow deliberate order changes by insertion on a highlighted connection or explicit reorder commands.
- New Node inserts a correction at the selected location, keeping the starter output transform last by default. Select and rename nodes; expose actions in the toolbar/context menu.
- Control-D bypasses the selected node, preserving its settings and showing a darker card plus an explicit bypass state. Backspace/Delete removes the selected node and reconnects its neighbors.
- Scope shortcuts to the focused color context. Text editing and curve-point deletion take priority; node actions must not reach timeline clip commands.
- Auto Arrange lays out the serial chain cleanly without changing processing order. Include pan, zoom, and Fit Nodes for larger grades.
- One completed drag is one undo action; preserve existing collaboration permissions, locks, copying, snapshots and save/reload behavior.

## 3. Add node effects and the right inspector

- Searchable Library tab with Color Space Transform and a focused set of supported grading effects. Primaries and Custom Curves remain the main node tools in the bottom area; avoid duplicate competing settings.
- Drag an effect onto a node, or add it to the selected node from the library. Selection immediately exposes its Settings tab.
- Store ordered effect instances on each node, with independent enable, reset, remove, and reorder actions. Node bypass bypasses the whole node.
- Define execution order explicitly: node primary/curve corrections, then its effect stack, then the next node. Make the order visible in the inspector.
- Reuse existing LUT parsing for a LUT effect with an explicit expected input space and amount; do not silently replace the camera transform.
- Only expose effects whose preview and export implementation is complete. Existing clip-level spatial effects cannot simply be relabeled as node effects because their position in processing changes their result.
- Add structured effect/curve validation and stable IDs through state updates, persistence, copy/paste and animation references. Layout changes should not rebuild GPU grading parameters.

## 4. Replace the curves and refine primaries

- Master RGB and individual R/G/B curves.
- Click to add points anywhere; drag in both axes; select and delete interior points; edit coordinates; reset one channel or all channels.
- Smooth interpolation by default, with editable tangents and a linear/corner option. Keep horizontal ordering valid and handle overlapping points predictably.
- Store actual points and interpolation settings, not three scalar substitutes. Preserve existing three-point grades with their original interpolation in the compatibility path.
- Sample the same curve definition for CPU/export and a small GPU curve texture. Refresh that texture during editing rather than rebuilding a 3D LUT.
- Keep Lift/Gamma/Gain/Offset, exposure, temperature, tint, contrast/pivot and saturation. Tune wheel sensitivity and numeric precision on real footage; add fine adjustment and per-control reset.

## 5. Make scopes follow the grade

- Waveform, RGB parade, vectorscope and histogram update from each newly presented graded frame, including paused slider/wheel/curve drags.
- Remove the separate scope timer and guarantee the final drag value is drawn. Coalesce pointer input into the latest render state without queuing obsolete scope jobs.
- Measure scopes against frame/grade revision IDs so a fast update cannot display samples from an older correction.
- Reuse bounded downsample buffers first. Optimize the measured bottleneck if necessary; do not introduce a worker or GPU scope renderer without evidence it is needed.
- Target display-refresh responsiveness during paused grading (60 updates/sec on a 60 Hz test display) and one scope update per presented playback frame. Record hardware and source conditions with measurements.
- Add useful graticules, channel colors and a vectorscope skin-tone reference. Analyze the graded image before comparison overlays and UI decorations. Label the measured signal and precision accurately.

## 6. Acceptance and rollout

Build in this order: reference frames and compatibility boundary → transform/precision pipeline → node data and interactions → layout/effect inspector → curves/primaries → scope synchronization and performance pass → end-to-end validation.

Reuse the existing Node test runner and browser/GPU checks. Required evidence:

- Published black/middle-gray/white points, matrix/reference vectors, round trips, negative inputs and highlight ramps. Independently sourced reference values, not only CPU-versus-GPU agreement.
- CPU/GPU agreement for complete camera → DWG/Intermediate → correction → Rec.709 chains, including multiple CST effects, bypass and order changes.
- Resolve technical-CST reference comparison with tone/gamut mapping disabled, then separately assess the chosen output mapping on skin, foliage, saturated objects, shadows and bright highlights.
- Original-media export versus preview on the Newspaper S-Log3 shots, with LUT interpolation error measured on curves and saturated/highlight samples. Adjust export sampling or evaluation if it misses the agreed numerical tolerance.
- Real R6/R6 Mark II footage comparison once a recording is identified/provided. Synthetic Canon checks alone must not be presented as camera-footage validation.
- Scope and viewer revision agreement throughout a sustained drag and on its last value, both paused and playing, including efficient mode.
- Node drag, insertion/reorder, Auto Arrange, bypass and delete; editable multi-point curves; effect stacks; keyboard focus; undo across saves; reload and concurrent edits.
- Existing grades and imported Resolve looks retain their previous output. Build and existing relevant regression checks pass.

Completion means an actual log clip can be normalized, balanced, shaped with wheels and curves, scoped continuously, saved/reopened, and exported with consistent results.

## Primary references

- [Sony S-Log3 / S-Gamut3 technical summary](https://pro.sony/s3/cms-static-content/uploadfile/06/1237494271406.pdf)
- [Blackmagic DaVinci Wide Gamut / Intermediate specification](https://documents.blackmagicdesign.com/InformationNotes/DaVinci_Resolve_17_Wide_Gamut_Intermediate.pdf)
- [Canon EOS R6 Log settings](https://cam.start.canon/en/C004/manual/html/UG-03_Shooting-2_0080.html)
- [Canon EOS R6 Mark II Log settings](https://cam.start.canon/en/C012/manual/html/UG-04_Shooting-2_0090.html)

Obtain and pin the original Sony S-Log/S-Log2 definitions and applicable camera-matrix references before implementing those additions.
