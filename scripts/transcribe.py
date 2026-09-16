"""Local English captions: speech detection → MLX Whisper → word alignment.
Stdout is a JSON-lines progress protocol; model diagnostics go to stderr.
"""
import contextlib
import json
import os
from pathlib import Path
import sys

os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('PYANNOTE_METRICS_ENABLED', '0')
MODEL = os.environ.get('FRAME_LINE_WHISPER_MODEL', 'mlx-community/whisper-large-v3-mlx')

def emit(stage, progress):
    print(json.dumps({'stage': stage, 'progress': round(progress, 1)}), file=sys.__stdout__, flush=True)

def main():
    import numpy as np
    import torch
    import mlx.core as mx
    import mlx_whisper
    from silero_vad import load_silero_vad, get_speech_timestamps
    from whisperx.alignment import load_align_model, align
    from whisperx.audio import load_audio

    torch.set_num_threads(4)
    emit('Loading local models', 10)
    vad = load_silero_vad()
    alignment, metadata = load_align_model(language_code='en', device='cpu')
    if sys.argv[1] == '--setup':
        mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language='en', word_timestamps=True, verbose=False)
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
        result = mlx_whisper.transcribe(segment_audio, path_or_hf_repo=MODEL, language='en', word_timestamps=True, temperature=0, condition_on_previous_text=False, verbose=False)
        segments = [s for s in result['segments'] if s.get('no_speech_prob', 0) < .7 or s.get('avg_logprob', -2) > -.8]
        emit(f'Aligning words · {i+1} / {len(regions)} passages', 16+78*(i+.65)/max(1,len(regions)))
        alignment_segments = [{'start': 0, 'end': len(segment_audio)/16000, 'text': ' '.join(s['text'].strip() for s in segments)}] if segments else []
        aligned = align(alignment_segments, alignment, metadata, segment_audio, 'cpu', return_char_alignments=False)
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
        mx.clear_cache()
    Path(sys.argv[2]).write_text(json.dumps({'words': words}, ensure_ascii=False))
    emit('Transcript ready', 100)

if __name__ == '__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):
            main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
