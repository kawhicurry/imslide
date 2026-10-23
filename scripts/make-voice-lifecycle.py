"""Generate one continuous Chinese speech fixture without inserted pauses; requires macOS say and ffmpeg."""
import json
import subprocess
import wave
from pathlib import Path

out = Path('.data/voice-lifecycle')
out.mkdir(parents=True, exist_ok=True)
texts = [
    '请新增一页，标题设置为语音验收。',
    '在语音验收这一页添加两行内容，第一行写项目目标是提高效率，第二行写项目预算是一百万元。',
    '修改语音验收这一页，把项目预算从一百万元改为八十万元，其他内容保持不变。',
    '删除语音验收这一页里面的项目目标这一行，保留标题和项目预算。',
    '最后，删除标题为语音验收的这一页，不要删除其他页面。',
]
# One TTS invocation: no concatenation, inserted silence, or execution waits.
text = '然后'.join(part.rstrip('。').replace('，', '') for part in texts) + '。'
source, target = out / 'lifecycle.aiff', out / 'lifecycle.wav'
subprocess.run(['say', '-v', 'Tingting', '-r', '175', '-o', str(source), text], check=True)
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(source), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', str(target)], check=True)
with wave.open(str(target)) as audio:
    duration = audio.getnframes() / audio.getframerate()
manifest = {'title': '语音验收', 'text': text, 'steps': texts, 'duration': duration, 'insertedSilenceSeconds': 0}
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(json.dumps(manifest, ensure_ascii=False))
