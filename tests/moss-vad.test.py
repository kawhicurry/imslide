"""Run with .data/asr-venv/bin/python tests/moss-vad.test.py."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import numpy as np

spec = importlib.util.spec_from_file_location('moss_worker', Path(__file__).parents[1] / 'scripts/moss-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Bridge:
    def __init__(self):
        self.stdin = io.StringIO()
        self.stdout = io.StringIO('{"ready":true}\n{"id":1,"text":"You\'re welcome."}\n')
        self.stopped = False
    def terminate(self): self.stopped = True
    def wait(self, timeout=None): return 0


class GateTests(unittest.TestCase):
    def run_audio(self, audio):
        bridge = Bridge()
        source = json.dumps({'id': 1, 'audio': base64.b64encode(audio.astype('<f4').tobytes()).decode()}) + '\n'
        sink = io.StringIO()
        with patch.object(worker.subprocess, 'Popen', return_value=bridge), patch.object(worker.signal, 'signal'), patch.object(worker.sys, 'stdin', io.StringIO(source)), patch.object(worker.sys, 'stdout', sink):
            worker.main()
        self.assertTrue(bridge.stopped)
        return bridge.stdin.getvalue(), [json.loads(x) for x in sink.getvalue().splitlines()][-1]

    def test_real_silero_blocks_silence_and_noise_without_remote_inference(self):
        rng = np.random.default_rng(42)
        for amplitude in [0, 0.002, 0.01, 0.1]:
            with self.subTest(amplitude=amplitude):
                sent, result = self.run_audio(rng.uniform(-amplitude, amplitude, 64000))
                self.assertEqual(sent, '')
                self.assertEqual(result['text'], '')
                self.assertFalse(result['speechDetected'])

    def test_detected_speech_is_forwarded_without_phrase_blacklist(self):
        with patch('faster_whisper.vad.get_speech_timestamps', return_value=[{'start': 0, 'end': 64000}]):
            sent, result = self.run_audio(np.zeros(64000))
        self.assertTrue(sent)
        self.assertEqual(result['text'], "You're welcome.")
        self.assertTrue(result['speechDetected'])

    def test_invalid_pcm_never_reaches_remote(self):
        sent, result = self.run_audio(np.array([float('nan')]))
        self.assertEqual(sent, '')
        self.assertIn('error', result)


if __name__ == '__main__':
    unittest.main()
