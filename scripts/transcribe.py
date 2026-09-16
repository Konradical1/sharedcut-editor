"""Local English captions: speech detection → Whisper → word alignment.
MLX Whisper on Apple silicon, faster-whisper on CUDA or CPU everywhere else.
Stdout is a JSON-lines progress protocol; model diagnostics go to stderr.
"""
import contextlib
import json
import os
from pathlib import Path
import platform
import sys

os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('PYANNOTE_METRICS_ENABLED', '0')
# Every model this downloads is public, so do not attach whatever token happens to be cached on the
# host. A stale one makes the Hub answer 401 on a public repo, which reads as "model not found" and
# takes captions down for a credential they never needed. Override to '0' for a gated model.
os.environ.setdefault('HF_HUB_DISABLE_IMPLICIT_TOKEN', '1')
# MLX is Apple silicon only. Everywhere else faster-whisper runs the same model through
# CTranslate2, which carries its own CUDA and does not need a GPU build of torch.
MLX = sys.platform == 'darwin' and platform.machine() == 'arm64'
MODEL = os.environ.get('FRAME_LINE_WHISPER_MODEL') or ('mlx-community/whisper-large-v3-mlx' if MLX else 'large-v3')

def emit(stage, progress):
    print(json.dumps({'stage': stage, 'progress': round(progress, 1)}), file=sys.__stdout__, flush=True)

def main():
    import numpy as np
    import torch
    from silero_vad import load_silero_vad, get_speech_timestamps
    from whisperx.alignment import load_align_model, align
    from whisperx.audio import load_audio

    torch.set_num_threads(4)
    # Alignment is torch, so it can only use the card if this is a CUDA build of torch. whisperx
    # pins a torch version that has no CUDA wheel, so off Apple silicon this is usually 'cpu'.
    align_device = 'cuda' if torch.cuda.is_available() else 'cpu'
    emit('Loading local models', 10)
    vad = load_silero_vad()
    alignment, metadata = load_align_model(language_code='en', device=align_device)

    # Both backends return the same shape: a list of segments carrying the text and the two
    # confidence fields the filter below reads.
    if MLX:
        import mlx.core as mx
        import mlx_whisper

        def transcribe(samples):
            return mlx_whisper.transcribe(samples, path_or_hf_repo=MODEL, language='en', word_timestamps=True, temperature=0, condition_on_previous_text=False, verbose=False)['segments']

        def release():
            mx.clear_cache()
    else:
        # The nvidia-* wheels drop their DLLs in site-packages/nvidia/*/bin, a directory Windows
        # does not search. Without this CTranslate2 reports a missing cublas64_12.dll while the
        # card sits there working, and captions fall back to the CPU for a path problem.
        # CTranslate2 resolves these lazily with a plain LoadLibrary, which consults PATH and
        # ignores add_dll_directory, so both are needed: the directory list for the extension
        # module's own dependencies, and PATH for the lazy CUDA loads.
        if os.name == 'nt':
            import glob
            import sysconfig
            folders = glob.glob(os.path.join(sysconfig.get_paths()['purelib'], 'nvidia', '*', 'bin'))
            for folder in folders:
                with contextlib.suppress(OSError):
                    os.add_dll_directory(folder)
            if folders:
                os.environ['PATH'] = os.pathsep.join(folders) + os.pathsep + os.environ.get('PATH', '')

        import ctranslate2
        from faster_whisper import WhisperModel

        # CTranslate2 ships its own CUDA and is independent of whichever torch whisperx dragged in,
        # so ask it directly. Asking torch instead would strand transcription on the CPU next to an
        # idle card, which is exactly what a CPU-only torch build looks like from here.
        # Seeing a card is not the same as being able to drive it, so both the probe and the load
        # are guarded. Captions on the CPU are slow, not broken; say what happened and carry on
        # rather than failing the job.
        model = None
        try:
            if ctranslate2.get_cuda_device_count() > 0:
                model = WhisperModel(MODEL, device='cuda', compute_type='float16')
        except Exception as error:
            print(f'CUDA unavailable to CTranslate2 ({error}); transcribing on the CPU.', file=sys.stderr)
        if model is None:
            model = WhisperModel(MODEL, device='cpu', compute_type='int8')

        def transcribe(samples):
            segments, _ = model.transcribe(samples, language='en', word_timestamps=True, temperature=0, condition_on_previous_text=False)
            return [{'text': s.text, 'no_speech_prob': s.no_speech_prob, 'avg_logprob': s.avg_logprob} for s in segments]

        def release():
            pass

    if sys.argv[1] == '--setup':
        transcribe(np.zeros(16000, dtype=np.float32))
        emit('Models ready', 100)
        return
    audio = load_audio(sys.argv[1])
    emit('Detecting speech', 14)
    regions = get_speech_timestamps(torch.from_numpy(audio), vad, sampling_rate=16000, max_speech_duration_s=25, min_silence_duration_ms=350, speech_pad_ms=120)
    words = []
    for i, region in enumerate(regions):
        offset = region['start'] / 16000
        segment_audio = audio[region['start']:region['end']]
        emit(f'Transcribing · {i+1} / {len(regions)} passages', 16+78*i/max(1,len(regions)))
        result = transcribe(segment_audio)
        segments = [s for s in result if s.get('no_speech_prob', 0) < .7 or s.get('avg_logprob', -2) > -.8]
        emit(f'Aligning words · {i+1} / {len(regions)} passages', 16+78*(i+.65)/max(1,len(regions)))
        alignment_segments = [{'start': 0, 'end': len(segment_audio)/16000, 'text': ' '.join(s['text'].strip() for s in segments)}] if segments else []
        aligned = align(alignment_segments, alignment, metadata, segment_audio, align_device, return_char_alignments=False)
        for seg in aligned['segments']:
            items = seg.get('words', [])
            for n, item in enumerate(items):
                text = item.get('word', '').strip()
                if not text:
                    continue
                uncertain = 'start' not in item or 'end' not in item or item.get('score', 1) < .45
                # Unalignable numbers retain an explicitly approximate position in their phrase.
                start = item.get('start', seg['start']+(seg['end']-seg['start'])*n/max(1,len(items)))+offset
                end = item.get('end', seg['start']+(seg['end']-seg['start'])*(n+1)/max(1,len(items)))+offset
                start = max(0, start, words[-1]['start'] if words else 0)
                end = max(start+.01, end)
                if words and words[-1]['text'].casefold() == text.casefold() and start < words[-1]['end']:
                    continue
                words.append({'text': text, 'start': round(start, 4), 'end': round(end, 4), **({'uncertain': True} if uncertain else {})})
        release()
    Path(sys.argv[2]).write_text(json.dumps({'words': words}, ensure_ascii=False))
    emit('Transcript ready', 100)

if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):
            main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
