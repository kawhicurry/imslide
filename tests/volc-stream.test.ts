import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { VolcTranscript, parseVolcPacket, volcPacket, volcConfiguration, VOLC_ENDPOINT } from '../src/volc-stream.ts';
import { mergeSchema } from '../src/transcript-merger.ts';

function reply(value: unknown, flags = 1, sequence = 1) {
  const body = gzipSync(Buffer.from(JSON.stringify(value)));
  const header = Buffer.from([0x11, 0x90 | flags, 0x11, 0]);
  const metadata = Buffer.alloc(flags & 1 ? 8 : 4);
  if (flags & 1) metadata.writeInt32BE(sequence);
  metadata.writeUInt32BE(body.length, metadata.length - 4);
  return Buffer.concat([header, metadata, body]);
}
test('SeedASR supports gzip, signed final sequence and unsequenced final packets', () => {
  for (const [flags, sequence] of [[1, 3], [3, -3], [2, 0]]) {
    const result = parseVolcPacket(reply({ result: { text: '新增一页' } }, flags, sequence));
    assert.equal(result.final, flags !== 1);
    assert.equal(result.value.result.text, '新增一页');
  }
  const packet = volcPacket(Buffer.from([1, 2, 3, 4]), true, true);
  assert.equal(packet[1], 0x22); assert.equal(packet[2], 1);
  assert.deepEqual(gunzipSync(packet.subarray(8)), Buffer.from([1, 2, 3, 4]));
});
test('protocol rejects truncated, invalid, oversized and provider-error packets without exposing payload', () => {
  const good = reply({ result: {} });
  assert.throws(() => parseVolcPacket(good.subarray(0, 10)));
  assert.throws(() => parseVolcPacket(good.subarray(0, good.length - 1)));
  assert.throws(() => parseVolcPacket(reply({ text: 'a'.repeat(1024 * 1024) })));
  const bad = Buffer.from([0x11, 0xf0, 0x11, 0, 0, 0, 0, 42]);
  assert.throws(() => parseVolcPacket(bad), /42/);
  assert.throws(() => parseVolcPacket(reply({ code: 45000010, message: 'private secret' })), error => error instanceof Error && !error.message.includes('secret'));
});
test('only provider-confirmed sentences submit; cumulative repeats deduplicate without deleting repeated commands', () => {
  const tracker = new VolcTranscript();
  const a = { text: '新增一页。', start_time: 100, end_time: 1000, definite: false };
  assert.deepEqual(tracker.update({ result: { utterances: [a] } }, false).utterances, []);
  const confirmed = { ...a, definite: true };
  assert.equal(tracker.update({ result: { utterances: [confirmed] } }, false).utterances.length, 1);
  assert.equal(tracker.update({ result: { utterances: [confirmed] } }, false).utterances.length, 0);
  const b = { ...confirmed, start_time: 1100, end_time: 2000 };
  assert.equal(tracker.update({ result: { utterances: [confirmed, b] } }, false).utterances.length, 1);
  assert.throws(() => tracker.update({ result: { utterances: [{ ...confirmed, text: '删除一页。' }] } }, false));
});
test('normal final packet releases tail; no final packet means interim stays provisional', () => {
  const tracker = new VolcTranscript();
  const value = { result: { utterances: [{ text: '标题改为预算', end_time: 2500, definite: false }] } };
  assert.equal(tracker.update(value, false).utterances.length, 0);
  assert.equal(tracker.update(value, true).utterances.length, 1);
});
test('Plan credentials stay explicit and endpoint cannot redirect them', () => {
  assert.throws(() => volcConfiguration({}), /VOLC_ASR_API_KEY/);
  assert.throws(() => volcConfiguration({ VOLC_ASR_API_KEY: 'fixture', VOLC_ASR_ENDPOINT: 'wss://example.com' }));
  assert.equal(volcConfiguration({ VOLC_ASR_API_KEY: 'fixture' }).endpoint, VOLC_ENDPOINT);
});
test('cloud-owned long utterances do not inherit the old 24 second window limit', () => {
  const input = { session: '90000000-0000-4000-8000-000000000000', seq: 0, start: 1, end: 40, raw: '完整长句', endpoint: true };
  assert.equal(mergeSchema.safeParse(input).success, false);
  assert.equal(mergeSchema.safeParse({ ...input, source: 'volc-stream' }).success, true);
});
