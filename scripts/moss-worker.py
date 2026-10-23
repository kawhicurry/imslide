"""Local Silero VAD gate, followed by the persistent remote MOSS bridge.

No speech means no remote inference. Missing VAD fails closed, never bypasses it.
"""
import base64
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    try:
        import numpy as np
        from faster_whisper.vad import get_speech_timestamps, get_vad_model, VadOptions
        get_vad_model()  # Bundled ONNX weights; no downloads or Whisper model load.
    except Exception:
        emit({'error': '人声检测不可用，请用 ASR_PYTHON 配置已安装 scripts/asr-requirements.txt 的 Python 环境'})
        return
    bridge = Path(__file__).with_name('moss-bridge.py').read_text()
    command = 'python3 -u -c ' + shlex.quote(bridge) + ' ' + shlex.quote(os.environ.get('MOSS_BASE_URL', 'http://127.0.0.1:18768'))
    child = subprocess.Popen(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'UpdateHostKeys=no',
                              '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
                              os.environ.get('MOSS_SSH_HOST', '157'), command],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        health = json.loads(child.stdout.readline())
        emit(health)
        if not health.get('ready'):
            return
        for line in sys.stdin:
            item = {}
            try:
                item = json.loads(line)
                audio = np.frombuffer(base64.b64decode(item['audio'], validate=True), dtype='<f4').copy()
                if not 0 < len(audio) <= 16000 * 24 or not np.isfinite(audio).all():
                    raise ValueError('Invalid PCM')
                speech = get_speech_timestamps(audio, VadOptions(threshold=0.5, min_speech_duration_ms=100,
                                                               min_silence_duration_ms=300, speech_pad_ms=0))
                if not speech:
                    emit({'id': item['id'], 'text': '', 'speechDetected': False})
                    continue
                # Preserve original timing and quiet consonants; VAD gates, it does not trim speech.
                child.stdin.write(line)
                child.stdin.flush()
                result = json.loads(child.stdout.readline())
                if result.get('id') != item['id']:
                    raise ValueError('Mismatched response')
                emit({**result, 'speechDetected': True})
            except Exception:
                emit({'id': item.get('id'), 'error': '人声检测或MOSS语音转写失败，未提交指令'})
    finally:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


if __name__ == '__main__':
    main()
