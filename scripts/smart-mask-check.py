"""Run with .venv-mask/bin/python scripts/smart-mask-check.py (no models needed)."""
import importlib.util
from pathlib import Path
import tempfile
import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("smart-mask.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

times = [0, .04, .09, .12, .18]
doc = {"range": {"start": .04, "end": .18}}
assert worker.frame_at(times, .10) == 2
assert worker.selected_frames(times, doc, "both", .09)[0] == [1, 2, 3]
assert worker.selected_frames(times, doc, "forward", .09)[0] == [2, 3]
assert worker.selected_frames(times, doc, "backward", .09)[0] == [1, 2]
# The frame showing at range.start belongs to the range, as in the editor's frame mapping.
assert worker.selected_frames(times, {"range": {"start": .05, "end": .18}}, "both", .05)[0] == [1, 2, 3]
assert worker.region_for((100, 100), 1024, 3840, 2160) == (0, 0, 1024, 1024)
assert worker.region_for((3800, 2100), 1024, 3840, 2160) == (2816, 1136, 1024, 1024)
assert worker.region_for((0, 0), 2160, 3840, 2160) == (0, 0, 3840, 2160)
blob = np.zeros((1024, 1024), bool); blob[400:500, 450:550] = True
assert worker.mask_bounds(blob, (100, 200, 1024, 1024)) == (550, 600, 649, 699)
region = worker.follow(worker.mask_bounds(blob, (100, 200, 1024, 1024)), (100, 200, 1024, 1024), 3840, 2160)
assert region[2] == region[3] and 700 < region[2] < 1024, region
assert worker.follow(None, (0, 0, 3840, 2160), 3840, 2160) == (0, 0, 3840, 2160)
assert worker.whole_candidate([.06, .19, .09], [.72, .43, .83]) == 1      # jersey click -> whole player
assert worker.whole_candidate([.02, .70, .05], [.8, .1, .3]) == 2          # window-filling junk is skipped
assert worker.whole_candidate([.6, .7, .9], [.2, .5, .1]) == 1             # nothing plausible -> best score
edge = worker.antialias(blob)
assert edge[450, 500] == 255 and edge[300, 300] == 0 and edge[400, 500] == 191 and edge[399, 500] == 64
scene = np.zeros((600, 600), bool); scene[100:400, 100:250] = True; scene[420:480, 120:160] = True; scene[300:330, 500:530] = True
clean = worker.cleanup(scene)
assert clean[200, 150] and clean[450, 140] and not clean[310, 510]
last = np.zeros((600, 600), bool); last[100:480, 100:250] = True
assert worker.cleanup(scene, last)[450, 140] and not worker.cleanup(scene, last)[310, 510]
last[300:330, 500:530] = True
assert worker.cleanup(scene, last)[310, 510]
stroke = {"points": [{"x": .1, "y": .5}, {"x": .9, "y": .5}], "radius": .02}
points = worker.stroke_points(stroke, 100, 100)
assert len(points) > 2 and np.allclose(points[[0, -1]], [[9.9, 49.5], [89.1, 49.5]])
assert np.allclose(worker.stroke_points({"points": [{"x": 1, "y": 1}], "radius": .01}, 100, 80), [[99, 79]])
base = np.full((80, 80), .37123, dtype=np.float32)
repair = {"points": [{"x": .5, "y": .5}], "radius": .1, "kind": "foreground"}
alpha = worker.repair_alpha(base, [repair])
assert alpha[40, 40] == 1 and alpha[0, 0] == base[0, 0]
alpha = worker.repair_alpha(base, [repair, {**repair, "kind": "background"}])
assert alpha[40, 40] == 0
alpha = worker.repair_alpha(base, [repair, {**repair, "kind": "unknown"}])
assert alpha[40, 40] == base[40, 40] and alpha[0, 0] == base[0, 0]
with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / "alpha.png"
    Image.fromarray(np.rint(base*65535).astype(np.uint16)).save(path)
    loaded = np.asarray(Image.open(path)).astype(np.float32)/65535
    assert np.max(abs(base-loaded)) <= 1/65535
    assert len(path.read_bytes()) > 0
    original, revised = Path(folder)/"original", Path(folder)/"revised"
    original.mkdir(); revised.mkdir()
    job = {"document": {"source": {"width": 80, "height": 80}, "repairs": [dict(repair, time=0)]}}
    # The decode already wrote source/, so finish_frames only turns tracked alpha into the saved mattes.
    (original/"source").mkdir()
    Image.new("RGB", (80, 80)).save(original/"source/0.jpg")
    worker.finish_frames(job, [0], [0], original, lambda _: base)
    assert (original/"source/0.jpg").is_file(), "the decoded frame stays as the artifact's source sidecar"
    import json
    manifest = {"sourceTimes": [0], "frames": [{"index": 0, "time": 0, "file": "frames/0.png"}]}
    (original/"manifest.json").write_text(json.dumps(manifest))
    worker.finish_repair_job({"document": {"source": {"width": 80, "height": 80}, "repairs": []},
                             "baseInput": str(original), "output": str(revised), "version": 1,
                             "key": "new", "signature": "current", "projectId": "project", "mediaId": "media", "sourceFingerprint": "same"})
    assert np.asarray(Image.open(original/"frames/0.png"))[40, 40] == 65535
    assert abs(int(np.asarray(Image.open(revised/"frames/0.png"))[40, 40])/65535 - float(base[40, 40])) <= 1/65535
print("Smart Mask: irregular PTS/range/direction, follow windows, edge cleanup, stroke sampling, ordered local repairs and gray16 precision passed.")
