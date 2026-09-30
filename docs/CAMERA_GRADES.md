# Girls Soccer camera grades

Three cameras on the shoot. Every clip starts with the same four nodes (Input CST → Balance → Look → Output CST);
only the Input CST and the Balance node differ per camera.

| Camera | Files | Input CST | Balance (exposure / temperature / tint) |
|---|---|---|---|
| Sony | `C0979`–`C1061` | S-Log3 / S-Gamut3.Cine (auto-detected) | +0.3 / −1500 / 0 |
| Canon A | `4B4A6962`–`4B4A7057` | Canon Log 3 / Cinema Gamut | +0.3 / +600 / 0 |
| Canon B | `7V5A6049`–`7V5A6123` | Canon Log 3 / Cinema Gamut | +0.6 / +200 / 0 |

Look node, all cameras: contrast 1.1 (pivot 0.336), saturation 110.
Output CST, all cameras: DaVinci Intermediate / DaVinci Wide Gamut → Rec.709 / Gamma 2.4, tone mapping **ACES 2**, gamut mapping none.

How these were derived: the Canon A clip `4B4A7040` was matched frame-for-frame against Konrad's Resolve grade
(`MaddieGoal.mov`, CST to DaVinci Intermediate). With the corrected Canon Log 3 curve and the ACES 2 output, the
Balance and Look values above bring the mean pixel error to 0.016 (0 to 1 scale) against that reference. The
per-camera temperature and exposure offsets neutralise the white jerseys under the same stadium lights on each
camera, measured on four mid-clip frames per camera.

Apply to another shot from the same camera: select a graded shot on the Color page, Cmd+C, select the target,
Cmd+V. Adjust exposure by eye per shot; the stadium lighting is even but the framing is not.

## The bug this replaced

Canon Log curves are IRE formulas. Canon puts 0 IRE at code 64 and 100 IRE at code 940 in every container, so
black is code 128 and Canon Log 3 peaks at 109 IRE (code 1020, which is why full-range Canon files hit 1023).
SharedCut was feeding the full-range normalised value straight into the IRE formula, so black landed at
0.125 instead of 0.073, lifting shadows by ~2% linear, adding a third of a stop, and flattening contrast by 14%.
The fix converts code to IRE first, the same convention the ACES Canon IDTs use. Canon Log and gamut are read from
the camera's maker notes (see color-reference.md); all 170 clips here record Canon Log 3 / Cinema Gamut / Neutral.
