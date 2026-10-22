// Run with node --import tsx scripts/test-asr-live.mts <16kHz mono float32 PCM file>.
// Exercises real local ASR and the same overlap agreement used by the browser; never edits slides.
import { readFile, writeFile } from 'node:fs/promises';
import { AudioWindows, StableTranscript } from '../src/transcript.ts';
const raw = await readFile(process.argv[2]);
const pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const audio = new AudioWindows(), transcript = new StableTranscript();
const trace = [], submitted: string[] = [];
for (let offset = 0; offset < pcm.length + 96000; offset += 32000) {
  audio.append(offset < pcm.length ? pcm.slice(offset, offset + 32000) : new Float32Array(32000));
  const window = audio.snapshot(), started = performance.now();
  const response = await fetch('http://127.0.0.1:3001/api/asr', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: window.samples.buffer });
  const result = await response.json(); if (!response.ok) throw new Error(result.error);
  const added = transcript.update(result.words, window.start, window.end);
  submitted.push(...transcript.takeSentences(offset >= pcm.length));
  const item = { start: window.start, end: window.end, ms: Math.round(performance.now() - started), added, ...transcript.view() };
  trace.push(item); console.log(JSON.stringify(item));
  audio.retainFrom(Math.max(0, transcript.confirmedUntil - 3));
}
console.log(JSON.stringify({ submitted, ...transcript.view() }));
await writeFile('.data/asr-live-evidence.json', JSON.stringify({ submitted, trace, result: transcript.view() }, null, 2));
if (!transcript.view().fixed || !submitted.length) process.exitCode = 1;
if (process.argv[3]) {
  const normalize = (s: string) => s.replace(/[0-9]/g, n => '零一二三四五六七八九'[Number(n)]).replace(/[\p{P}\s]/gu, '');
  const expected = await readFile(process.argv[3], 'utf8');
  if (normalize(submitted.join('')) !== normalize(expected)) { console.error('Submitted text differs from expected audio transcript'); process.exitCode = 1; }
}
