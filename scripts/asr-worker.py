"""Local, persistent ASR worker. Audio stays in memory; stdout is JSONL only."""
import base64
import json
import os
import sys
import numpy as np
from faster_whisper import WhisperModel
from opencc import OpenCC
normalize = OpenCC("t2s")

model = WhisperModel(os.environ.get('ASR_MODEL', 'base'), device='cpu', compute_type='int8',
                     cpu_threads=int(os.environ.get('ASR_THREADS', '4')), local_files_only=True)
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        audio = np.frombuffer(base64.b64decode(request['audio']), dtype='<f4').copy()
        if not 0 < len(audio) <= 16000 * 24 or not np.isfinite(audio).all():
            raise ValueError('Invalid audio window')
        words = []
        active = [i for i in range(0, len(audio) - 319, 320)
                  if np.sqrt(np.mean(audio[i:i+320] ** 2)) >= 0.002]
        voice_start = active[0] / 16000 if active else 0
        voice_end = (active[-1] + 320) / 16000 if active else 0
        if np.sqrt(np.mean(audio * audio)) >= 0.002:
            segments, _ = model.transcribe(audio, language='zh', beam_size=5, temperature=0.0,
                word_timestamps=True, condition_on_previous_text=False, initial_prompt='以下是普通话简体中文转写。页面、标题、演示文稿、实时预览。',
                vad_filter=True, vad_parameters={'min_silence_duration_ms': 300})
            for segment in segments:
                for word in segment.words or []:
                    # Whisper can hallucinate tokens after voiced audio, often with zero duration.
                    midpoint = (word.start + word.end) / 2
                    if word.end - word.start < 0.01 or midpoint > voice_end + 0.05 or midpoint < voice_start - 0.15:
                        continue
                    words.append({'text': normalize.convert(word.word), 'start': word.start, 'end': word.end, 'confidence': word.probability})
        print(json.dumps({'id': request['id'], 'words': words}, ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps({'id': request.get('id'), 'error': '本机语音识别失败'}), flush=True)
