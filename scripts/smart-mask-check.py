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
    worker.finish_frames(job, [0], [0], original, lambda _: base,
                         lambda _, target: Image.new("RGB", (80, 80)).save(target))
    import json
    manifest = {"sourceTimes": [0], "frames": [{"index": 0, "time": 0, "file": "frames/0.png"}]}
    (original/"manifest.json").write_text(json.dumps(manifest))
    worker.finish_repair_job({"document": {"source": {"width": 80, "height": 80}, "repairs": []},
                             "baseInput": str(original), "output": str(revised), "version": 1,
                             "key": "new", "signature": "current", "projectId": "project", "mediaId": "media", "sourceFingerprint": "same"})
    assert np.asarray(Image.open(original/"frames/0.png"))[40, 40] == 65535
    assert abs(int(np.asarray(Image.open(revised/"frames/0.png"))[40, 40])/65535 - float(base[40, 40])) <= 1/65535
print("Smart Mask: irregular PTS/range/direction, stroke sampling, ordered local repairs and gray16 precision passed.")
