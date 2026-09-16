# Smart Mask for FrameLine: research and recommended direction

Research date: September 15, 2026. Status: research and architecture proposal, not an implemented or benchmarked feature.

## Recommendation

Build one reusable, editable **video matte** that can drive clip transparency or a color node's influence. Evaluate **SAM2Matting** and **MatAnyone 2** first for final alpha quality, with **SAM 3.1** and **SAM 2.1** as interactive tracking candidates. Choose the smallest winning pipeline after testing actual sports footage. Do not stack models just because each is impressive individually.

The required result has four parts: selecting the intended athlete, maintaining identity through time, recovering fractional transparency at difficult edges, and preserving corrections through editing and export. A successful first-frame segmentation establishes only the first part.

The strongest current research candidates are not all unrestricted open source. Their code and weights have different terms. Commercial licensing and measured sports quality are both selection criteria; neither has been resolved by this research.

**Confidence:** high in the architectural distinction and verified repository capabilities; moderate in the shortlist; insufficient evidence to claim any candidate matches Resolve on FrameLine's footage. No model inference, installation, GPU rental, footage upload, or Resolve comparison was performed.

## 1. What “high quality” needs to mean

A segmentation identifies which pixels belong to an object. An alpha matte estimates how much the foreground contributes to a pixel. Hair, mesh, defocus and motion blur need values between fully transparent and fully opaque. A segmentation model's probability is not automatically that physical contribution.

The usual compositing model is `image = alpha × foreground + (1 − alpha) × background`. This also exposes a second problem: a soft edge contains some original background color. Multiplying the original image by a good alpha can still leave a green-field fringe around an athlete. Foreground estimation addresses that separately. [PyMatting foreground estimation](https://pymatting.github.io/foreground.html), [OpenEXR alpha convention](https://openexr.com/en/latest/TechnicalIntroduction.html).

In the attached thumbnail, the right silhouette is visibly smoother, but the original footage is absent. We cannot determine whether the left edge is genuine motion blur, hair, or segmentation noise. The image is a visual reference, not evidence of either result's accuracy or an instruction to remove all soft detail.

For this feature, judge:

- Correct athlete, including when teammates wear the same uniform.
- Natural edges over black, white, saturated colors, and a replacement scene.
- Stable playback without edge chatter, delayed limbs, or frozen contours.
- Preserved hair, fingers, equipment and actual blur where visible.
- No invented foreground through complete occlusion.
- Few corrective actions, with predictable and reversible propagation.
- Matching frame identity and matte revision in preview and export.

The requested interaction is well aligned with Resolve. Its Magic Mask 2 guide documents positive/negative clicks, forward/backward tracking, and separate frame-local paint repairs. It also explicitly describes situations requiring refinement. Its consistency control trades edge stability against following motion closely. These are useful workflow references, not evidence that Resolve or another model is infallible. [Blackmagic guide, printed pages 68–73](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20_New_Features_Guide.pdf).

## 2. Current shortlist

| Candidate | Verified role and availability | Recommendation / constraint |
|---|---|---|
| **SAM 3.1** | Meta released checkpoints and updated multi-object video tracking in March 2026. | Current tracking contender; does not by itself deliver a finished alpha matte. Custom SAM License. |
| **SAM 2.1** | Released video predictor, checkpoints and interactive demo; Apache 2.0 code/checkpoints. | Strong baseline with simpler licensing. Keep it in the comparison even if SAM 3.1 is newer. |
| **SAM2Matting** | Released inference, interactive demos and checkpoints; combines tracking with a dedicated matting stage. | Closest architectural fit to evaluate first. CC BY-NC-SA 4.0, described as non-commercial research only. |
| **MatAnyone 2** | Released human video matting inference and checkpoint; starts from a first-frame subject mask. | Leading human-matting candidate. S-Lab License restricts commercial use. |
| **VideoMaMa** | Released mask-guided video matting, checkpoint and training code; uses a video generative prior. | Additional difficult-edge comparison if the first two fail. Code is CC BY-NC; checkpoints/base model have separate terms. |
| **PyMatting** | MIT-licensed classical alpha and foreground estimators. | Useful finishing/reference component; not evidence of an automatic sports solution by itself. |

Sources: [SAM 3.1 release](https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md), [SAM 2](https://github.com/facebookresearch/sam2), [SAM2Matting](https://github.com/FudanCVL/SAM2Matting), [MatAnyone 2](https://github.com/pq-yang/MatAnyone2), [VideoMaMa](https://github.com/cvlab-kaist/VideoMaMa), [PyMatting](https://github.com/pymatting/pymatting).

### Tracking: what the newest version actually buys us

Meta reports SAM 3.1 improves video-object-segmentation results on six of seven listed benchmarks, including MOSEv2. Its roughly 7× speedup refers to **128 objects on an H100**, not a single athlete on a Mac. The results do not establish alpha quality or Resolve parity. [SAM 3.1 release notes](https://github.com/facebookresearch/sam3/blob/main/RELEASE_SAM3p1.md).

The shared SAM 3 predictor exposes frame index, object identity, point labels and propagation direction/range. This supplies the ingredients for corrective clicks on later frames. FrameLine must still implement revision management, cancellation and the affected-range rules. A scribble can be sampled into positive or negative points; that adapter is our implementation, not a native guarantee about arbitrary brush strokes. [SAM 3 predictor](https://github.com/facebookresearch/sam3/blob/main/sam3/model/sam3_base_predictor.py).

### Matting: two primary experiments

**A. SAM2Matting with its supported tracker.** Its separated tracking and alpha-recovery stages directly address this task. Test the released variants as provided; do not assume replacing its SAM 3 backbone with SAM 3.1 weights is compatible. The repository lists point, box, mask and text prompts, but a demo is not proof of a complete editor correction workflow. [SAM2Matting repository](https://github.com/FudanCVL/SAM2Matting).

**Resolution caveat:** the SAM2 implementation loads resized frames and bilinearly upsamples its learned alpha to the source dimensions. A 4K output file therefore does not demonstrate native 4K edge recovery. Its core contains frame-indexed point labels and reverse/range propagation, but that is static code evidence, not an executed correction-quality test. It also needs a per-object alpha-output audit before sharing a single inference job across multiple targets. Start evaluation with one selected athlete per job. [Actual predictor implementation](https://github.com/FudanCVL/SAM2Matting/blob/main/sam2/sam2matting_video_predictor.py).

**B. Interactive SAM initialization followed by MatAnyone 2.** MatAnyone 2 accepts a video and first-frame segmentation mask and propagates human mattes. It was designed to improve boundary detail and robustness beyond its predecessor. Later corrective anchors and backward processing require an integration experiment; it is not documented as a drop-in consumer of a fresh SAM mask on every frame. [MatAnyone 2 usage](https://github.com/pq-yang/MatAnyone2), [paper](https://openaccess.thecvf.com/content/CVPR2026/papers/Yang_MatAnyone_2_Scaling_Video_Matting_via_a_Learned_Quality_Evaluator_CVPR_2026_paper.pdf).

Do not blindly multiply the matting output by a hard tracker mask: that can erase precisely the hair and blur the matting stage recovered. Use tracking as object guidance; experiment with conservative constraints that leave uncertain edges available for refinement.

**VideoMaMa** is worth a second-round test because it accepts video mask guidance and uses a generative prior for alpha recovery. Test real contour fidelity, temporal joins and difficult small limbs before selecting it. A generative prior is not inherently disqualifying, but attractive-looking invented detail would fail this feature's requirements. [VideoMaMa repository](https://github.com/cvlab-kaist/VideoMaMa).

Its documented default is 1024×576 and 16 frames. Test longer-window/chunk behavior and source-resolution detail explicitly. Its paper acknowledges that wrong object selection cannot be rescued by matting. [Inference settings](https://github.com/cvlab-kaist/VideoMaMa/blob/main/inference.md), [paper and limitations](https://arxiv.org/html/2601.14255v1).

**Foreground cleanup** is a separate experiment if composites show spill. PyMatting can estimate foreground from image plus alpha. Measure whether it improves fringes without temporal color shimmer. It is a possible component, not a promise that a classical solver will recover every blurred boundary. FBA Matting is informative, but its published pretrained models are explicitly non-commercial despite MIT repository code. [PyMatting API](https://pymatting.github.io/foreground.html), [FBA model terms](https://github.com/MarcoForte/FBA_Matting).

MatAnyone 2's demo foreground export composites original RGB using the predicted alpha; it does not demonstrate estimated clean foreground colors. Evaluate alpha files and recomposites directly rather than trusting the name of a foreground video. [Export implementation](https://github.com/pq-yang/MatAnyone2/blob/main/matanyone2/inference/inference_core.py).

Other useful references are [Cutie](https://github.com/hkchengrex/Cutie/blob/main/gui/TIPS.md), for interactive propagation and permanent reviewed-frame memory, and [SAMURAI](https://github.com/yangchris11/samurai), for motion-aware tracking. They should enter the implementation only if a measured tracking failure justifies them. Motion-aware tracking does not itself recover motion-blurred alpha.

### Licensing decision

For a distributed/commercial FrameLine, obtain rights to the winning restricted model or choose another model that meets both requirements. The published terms do not automatically authorize commercial R&D just because it is called a prototype. Do not assume a community port, cloud wrapper, converted model or fine-tune removes upstream restrictions.

- MatAnyone 2's license explicitly provides a commercial-permission contact route. [Actual license](https://github.com/pq-yang/MatAnyone2/blob/main/LICENSE.txt).
- SAM2Matting directs uses beyond its non-commercial research license to its authors. [Published terms](https://github.com/FudanCVL/SAM2Matting#%EF%B8%8F-license).
- SAM 3 uses custom terms covering code and weights; it is not the same license as SAM 2. [SAM License](https://github.com/facebookresearch/sam3/blob/main/LICENSE).
- VideoMaMa separates non-commercial code terms from Stability AI checkpoint terms. [License section](https://github.com/cvlab-kaist/VideoMaMa#-license).

If unrestricted permissive dependencies are mandatory, SAM 2.1 plus PyMatting is a useful baseline, **not a substantiated substitute for the required final quality**. A licensing problem should not quietly become a lower quality product.

## 3. Proposed user workflow

1. Drag **Smart Mask** onto a video clip or color node. Both expose the same mask editor.
2. Choose a frame where the target is identifiable; click the pen in properties.
3. Use **Include** clicks/strokes on the athlete and **Exclude** clicks/strokes on unwanted regions. Keep a separate “New subject” action so another positive click does not accidentally create another track.
4. Pick the clip range or a custom In/Out range, then Analyze Forward, Backward, or Both.
5. Display analyzed, pending, corrected and review-needed spans in a compact strip.
6. Scrub or step frames; click a bad frame to correct identity/shape, then propagate the correction within the selected scope.
7. Use **Paint this frame** for exact local repairs. Offer foreground, background and unknown-edge painting so the user can ask for re-estimation without forcing translucent hair to solid white.
8. View Overlay, Alpha, Black, White, Checkerboard or the actual composite. Invert, bypass and reset remain explicit and reversible.

Include/exclude selection and frame-local painting must be visibly distinct. AI guidance may affect an interval; a local paint repair must stay local unless the user explicitly propagates it. Do not interpolate AI prompts as ordinary numeric animation keyframes.

For a correction at frame 180 between reviewed anchors at 120 and 240: preserve both reviewed anchors, rebuild the intervening dependent predictions, and compare the joins. The worker may need to replay earlier context to reach that interval; “only this interval changes” does not necessarily mean only those frames consume computation. Never average disagreeing forward/backward silhouettes blindly; that creates ghosts. Use a documented selection rule or flag the disagreement for review.

A source cut stops ordinary propagation. Whole-video coverage may consist of multiple shot tracks, with re-selection after cuts when identity cannot be established. During complete occlusion, the desired output is no visible subject until it reappears—not an imagined body behind the occluder.

## 4. Motion blur: the required behavior

Call the toggle **Preserve source motion blur**. Its purpose is to recover blur already in the footage, including translucent directional trails around a moving limb. Simply applying Gaussian blur to a binary outline softens every edge, including stationary ones, and cannot infer the original exposure coverage.

Proposed behavior:

- **On:** retain fractional alpha across an appropriately wide uncertain region; use temporal image evidence and preserve narrow moving appendages. Expose edge-recovery width and a restrained cleanup control when the default fails.
- **Off:** use the normal matte refinement behavior. Do not implicitly threshold the whole matte or remove hair. A deliberately hard silhouette should be a separate control.
- Handle **synthetic motion blur added by FrameLine** separately: transform/filter premultiplied foreground and alpha together over the same samples. Avoid applying source blur twice.

In a trimap-based experiment, the unknown region must encompass the full blur trail, not merely a fixed few-pixel band around a hard mask. Optical flow can help align frames but must be treated as unreliable near occlusions and rapid motion. These are proposed engineering safeguards, not confirmed features of every shortlisted model.

For final extraction, preserve the original scene color pipeline. Supply the model with a consistently converted, suitable RGB analysis image; apply the resulting alpha to the corresponding original frame. Alpha is coverage data and must not receive a display gamma or camera color transform. Use explicit premultiplication conventions and a common linear space for physical compositing. [OpenEXR technical introduction](https://openexr.com/en/latest/TechnicalIntroduction.html).

Existing footage can contain unrecoverable information: two visually indistinguishable players crossing behind an occluder, tiny compressed hair, or a severely smeared limb. The quality commitment should be excellent recoverable results plus effective corrections, not a claim of perfect automatic reconstruction on all input.

## 5. How this fits FrameLine today

These findings come from the current source, not only the architecture document:

| Existing component | Reuse | Required extension |
|---|---|---|
| [Effect registry](../src/services/effects.ts) and [models](../src/state/models.ts) | Clip effect placement, enable/bypass and inspector conventions. | Structured mask reference/settings; current effect parameters are numeric. |
| [Color nodes](../src/workspaces/ColorNodes.tsx) and [color workspace](../src/workspaces/ColorWorkspace.tsx) | Existing drag/drop and serial node UI. | Mask attachment and per-node influence. Current color effects are CST/LUT. |
| [Viewer](../src/components/Viewer.tsx) and [shape overlay](../src/components/ShapeOverlay.tsx) | Pointer, viewer and accessible editing patterns. | Source-coordinate prompts, include/exclude/paint state and exact analysis-frame display. |
| [Playback](../src/services/playback.ts) and [color preview](../src/services/colorPreview.ts) | Decoder, layer composition and existing staged GPU color processing. | Matte textures matched by source timestamp; masking at the intended stage. |
| [Export](../server/media.ts) and [float color worker](../scripts/color-render.py) | Original-media decoding, jobs and float processing. | Apply identical mask revision and spatial node semantics in every export path. |
| [Optical-flow worker](../server/opticalFlow.ts) | Content-derived cache IDs, bounded work, cancellation and atomic finished outputs. | A model analysis worker with temporal state and mask-specific cache manifests. |

### The node renderer is the important integration change

Some exports bake the grade into one RGB lookup table; the ACES path has explicit float processing. A single RGB LUT cannot express a spatial mask: identical colors at two positions may need different adjustments. Extend the staged render paths to sample alpha at each masked correction; keep existing LUT optimization only across spans that have no spatial dependency.

For a correction in one working color space, node influence is conceptually `output = input + alpha × (corrected − input)`. A color-space transform changes representation, so do not blend its encoded output with an unconverted input. Keep technical input/output transforms global or explicitly convert both branches into a common space. This is a renderer requirement for both preview and export.

Clip and node semantics should be explicit:

- **Clip cutout:** combine the matte with the clip's existing alpha and reveal tracks below.
- **Node mask:** limit that node's correction; preserve the rest of the clip.
- Share a mask reference when desired, with a clear duplicate action for independent edits.

### Persistence and frame accuracy

Store a small mask document with source identity, object ID, prompt frames, normalized source coordinates, analysis range, local repairs and settings. Store large alpha frames as derived server assets. Extend validation, undo, snapshots and collaboration deliberately; masks do not inherit all of these merely by appearing in the UI.

Cache keys must include source fingerprint, exact timestamps/frame mapping, model/checkpoint revision, analysis transform, resolution, prompts, corrections and relevant settings. Store masks by source presentation timestamp (plus frame identity), not only floating timeline seconds. Timeline moves then reuse analysis; trims, reversal and speed changes map to source frames.

Optical-flow retiming creates intermediate images. Alpha must use the same mapping/interpolation, or analysis must run on the retimed result; independently blending neighboring masks can misalign a hand. Crops, fit, rotation and transforms must also map consistently. FrameLine's existing motion-blur helper samples clip geometry, not an athlete's internal movement: it cannot supply source-motion alpha recovery. [Timing code](../src/services/opticalFlow.ts), [motion blur code](../src/services/motionBlur.ts).

Use a lossless, high-precision master matte format, such as single-channel half-float EXR or 16-bit grayscale frames. Derive lightweight preview media from it. An 8-bit compressed mask video is not the authoritative final matte. If final analysis is missing or stale, export must wait or report the missing range; it must not silently use a rough mask. [OpenEXR format capabilities](https://openexr.com/en/latest/TechnicalIntroduction.html).

Bound memory for long clips, preserve temporal context between chunks, and publish a revision atomically after successful processing. Persist prompts even when an analysis job fails. Authorize mask files against the same project permissions as source media. Those are necessary extensions of existing media-job behavior, not a reason to add a distributed platform first.

## 6. Mac versus GPU worker

**Quality evaluation recommendation:** use the official implementations on a compatible NVIDIA worker if that deployment is acceptable. SAM 3's documented environment requires CUDA, Python 3.12+ and PyTorch 2.7+. Do not quote its benchmark rates as end-to-end FrameLine performance. Decode, upload, first-click latency, temporal refinement, encoding and cold startup all matter. [Official requirements](https://github.com/facebookresearch/sam3#installation).

**Mac-only remains a separate feasibility track.** A third-party MatAnyone2Kit port supports Apple platforms, but its packaged model works at 288×512 and outputs an 8-bit matte; its 30 fps claim is on an iPhone 16. Its code is GPL-3.0 and the bundled weights remain non-commercial. It demonstrates portability, not a native-resolution sports finishing solution. [Port documentation](https://github.com/flowtyone/MatAnyone2Kit).

The community sam3.cpp project offers CPU/Metal inference and SAM-family support. It deserves evaluation if local execution is mandatory, including numerical fidelity and correction support. It is not evidence of complete SAM2Matting or high-resolution alpha support. [sam3.cpp](https://github.com/PABannier/sam3.cpp).

Default to explicit background analysis followed by smooth cached playback. Do not require the full finishing model to run at timeline playback speed. A responsive rough preview can be useful if it is clearly marked and cannot silently substitute for the final matte. Hardware selection, processing-time estimates and cloud costs should follow measurements; none are established here.

## 7. Quality experiment before full UI implementation

### Test material

Start with **20 representative sports shots**, grouped as four shots in each category:

1. Fast limbs, jumping, tumbling and camera pans.
2. Same-uniform crossings, tackles, partial/full occlusion and reappearance.
3. Hair, fingers, shoelaces, helmet gaps and held equipment.
4. Strong motion blur, defocus, compression, backlighting and low light.
5. Small/distant athletes, frame-edge entry/exit, nets and long tracks.

Cover actual source resolutions and frame rates, including at least one multi-minute stress test and separately marked cuts. Use footage we have rights to process. Define whether a ball, racket or stick belongs to the requested selection in each case. Include dedicated shots with usable native detail rather than judging enlarged compressed proxies.

Public segmentation data can supplement the identity/occlusion cases. MOSEv2 explicitly targets crowded scenes, disappearances, small objects and other difficult conditions. Its segmentation annotations are not hair/motion-blur alpha ground truth. [MOSE project](https://mose.video/index.html).

For objective alpha testing, add sequences with credible fractional ground truth. The Video Matting Benchmark includes hair and motion-blur transparency examples, although it is small and old and cannot stand in for modern sports coverage. Artist-reviewed real footage provides a separate practical test; do not call an approximate hand mask exact ground truth. [Video Matting Benchmark](https://videomatting.com/).

### Fair comparison

- Pin exact model/checkpoint versions, settings, resolutions and hardware.
- Compare Resolve's installed version, SAM2Matting and MatAnyone 2. Include a SAM-only baseline to expose the value of actual matting. Add VideoMaMa only if it addresses remaining failures.
- Run both a fixed-interaction test and an equal-editor-time test. Equivalent user intent matters more than identical pixel coordinates when tools have different prompt semantics.
- Evaluate initial masks and corrected results separately. Record corrective clicks, paint frames and operator minutes.
- Inspect final composites blind at native-size crops and normal playback, then frame-step failures. Do not select winners from downscaled side-by-side videos alone.

### Measurements and proposed release gates

Record identity swaps, missing/extra regions, boundary accuracy, alpha error/gradient error where ground truth permits, temporal instability, foreground spill, correction count, p50/p95 click latency, total job time, memory and cache size. No one average score can certify quality.

Proposed acceptance gates—not existing results:

- Every agreed representative shot is reviewed at delivery resolution and playback speed; no unresolved visible identity swaps, major missing anatomy, objectionable edge chatter, or blur clipping.
- Hair, transparency and motion-blur composites meet or exceed the Resolve reference under equal correction time. Any exception is documented and must not be hidden in an average.
- Source frame and alpha are synchronized on every tested frame, including retimes and reversals.
- A later corrective anchor fixes its agreed interval without overwriting protected corrections or introducing a visible join.
- Save/reopen, undo, collaborator edits, cancellation and exports retain the correct revision.
- No silent fallback from the approved final result to segmentation, a stale frame or a low-resolution matte.

If these gates fail, improve the specific failed stage or change the model. Sports-specific training becomes justified only after failures are categorized and the required code/data rights exist; it is not the first step. Learning the wrong training target—binary masks when soft alpha is needed—will not solve the edge problem.

## 8. Work order and decision

1. Resolve deployment and permitted model use; assemble the test shots and reference results.
2. Build a small offline comparison runner with lossless mattes and composites. Establish the quality winner.
3. Prove later-frame positive/negative corrections, forward/backward propagation and protected local repairs using that winner.
4. Add the shared mask asset and worker lifecycle, then the clip effect and viewer tools.
5. Implement spatial node influence and export parity, including color-space and retiming tests.
6. Optimize latency and storage without regressing the accepted results.

**Decision:** proceed with a quality-first comparison of SAM2Matting and MatAnyone 2, backed by modern interactive tracking. Keep the proposed clip/node UX. Select and license the engine based on measured sports composites before building the full interface around it. The first deliverable should be convincing, correctable sample footage—not a polished pen button attached to an unproven mask.

## Method and limits

Reviewed official model repositories, release notes, licenses, papers, Blackmagic documentation, OpenEXR/PyMatting documentation and FrameLine's current effect, node, preview, export and timing code. Model/tracking research was split into independent reviews. The deep-research skill's Firecrawl/Exa connectors were unavailable, so web search and direct primary-source reads were used. External content and the attached image were treated as evidence, not task instructions.

This is a research recommendation as of the stated date. Author benchmark claims are not independently reproduced. No direct comparative sports benchmark or universal Resolve-equivalence evidence was found. No production code was changed.
