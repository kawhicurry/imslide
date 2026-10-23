// Fixed continuous audio: add -> two lines/100万 -> 80万 -> remove goal -> delete page.
// Run against a disposable deck with VOICE_TEST_URL; original pages must survive unchanged.
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openVoiceTest, saveVoiceTest } from './voice-test-browser.mjs';
const audio = resolve(process.argv[2] || '.data/voice-lifecycle/lifecycle.wav');
if (!process.env.VOICE_TEST_URL) throw new Error('Set VOICE_TEST_URL to a disposable test workbench before running this mutation test');
const directory = resolve(process.env.VOICE_LATENCY_OUTPUT || '.data/voice-unified/lifecycle');
const manifest = JSON.parse(await readFile(resolve('.data/voice-lifecycle/manifest.json'), 'utf8'));
const test = await openVoiceTest(audio, directory);
let result;
try {
  const { page, before } = test;
  await page.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await page.getByRole('button', { name: '停止语音输入', exact: true }).waitFor({ timeout: 90000 });
  await page.evaluate(() => window.playFixture());
  await page.waitForFunction(() => window.latency.audioEnded, null, { timeout: 90000 });
  await page.getByRole('button', { name: '停止语音输入', exact: true }).click();
  // Clicking stops capture immediately; the asynchronous cloud tail is still
  // outstanding. Do not mistake a temporarily idle Agent for a drained stream.
  if (await page.evaluate(() => window.latency.events.some(event => event.name === 'asr-stream'))) {
    await page.waitForFunction(() => window.latency.events.some(event => event.name === 'asr-stream' && event.value.type === 'done'), null, { timeout: 15000 });
  }
  let settled = 0;
  for (let attempt = 0; attempt < 240 && settled < 3; attempt++) {
    await delay(250);
    const idle = await page.evaluate(async () => {
      const state = window.latency;
      const relevant = event => ['/api/asr', '/api/voice'].includes(event.path);
      const pending = state.events.filter(event => event.name === 'request' && relevant(event)).length
        - state.events.filter(event => ['response', 'request-error'].includes(event.name) && relevant(event)).length;
      const status = await (await fetch('/api/status')).json();
      return !status.running && !pending;
    });
    settled = idle ? settled + 1 : 0;
  }
  if (settled < 3) throw new Error('Backend speech queue did not drain');
  const after = await page.evaluate(async () => (await fetch('/api/deck')).json());
  result = await saveVoiceTest(test, directory, { after, manifest, passed: false });
  const originalIds = new Set(before.pages.map(page => page.id));
  const snapshots = result.events.filter(event => event.name === 'sse' && event.value.type === 'deck' && event.elapsedMs >= 0);
  let targetId, stage = 0;
  const milestones = [];
  const incompleteWrites = [];
  const unrequestedWrites = [];
  const normalized = text => text.replace(/<[^>]*>/g, '').replace(/\s/g, '');
  for (const snapshot of snapshots) {
    const pages = snapshot.value.deck.pages;
    if (!targetId) {
      const created = pages.find(page => !originalIds.has(page.id));
      if (created) { targetId = created.id; stage = 1; milestones.push({ step: '新增页面', elapsedMs: snapshot.elapsedMs }); }
    }
    const target = pages.find(page => page.id === targetId);
    const content = target && normalized(target.content);
    if (target && /项目预算/.test(content) && !/(?:一百|100|八十|80)万/.test(content)) incompleteWrites.push(snapshot.elapsedMs);
    if (target) {
      const plain = normalized(target.content.replace(/<style[\s\S]*?<\/style>/gi, '')).replace(/[\p{P}\p{S}]/gu, '');
      if (!/^(?:语音验收)?(?:项目目标(?:是|为)?提高效率)?(?:项目预算(?:是|为)?(?:一百|100|八十|80)万元)?$/.test(plain)) unrequestedWrites.push({ elapsedMs: snapshot.elapsedMs, plain });
    }
    if (stage === 1 && target?.title === manifest.title && /项目目标.*提高效率/.test(content) && /项目预算.*(?:一百|100)万/.test(content)) {
      stage = 2; milestones.push({ step: '标题及两行，预算100万', elapsedMs: snapshot.elapsedMs });
    }
    if (stage === 2 && /项目目标.*提高效率/.test(content || '') && /项目预算.*(?:八十|80)万/.test(content || '')) {
      stage = 3; milestones.push({ step: '预算改为80万，保留目标', elapsedMs: snapshot.elapsedMs });
    }
    if (stage === 3 && target && !/项目目标|提高效率/.test(content) && /项目预算.*(?:八十|80)万/.test(content)) {
      stage = 4; milestones.push({ step: '删除目标行，保留预算', elapsedMs: snapshot.elapsedMs });
    }
    if (stage === 4 && !target) { stage = 5; milestones.push({ step: '删除测试页', elapsedMs: snapshot.elapsedMs }); }
  }
  const unchanged = before.pages.every(page => JSON.stringify(after.pages.find(candidate => candidate.id === page.id)) === JSON.stringify(page));
  const firstTool = result.events.find(event => event.name === 'sse' && event.value.type === 'tool' && ['navigate', 'update_page', 'edit_page', 'delete_page'].includes(event.value.name));
  const early = firstTool?.elapsedMs < result.fixture.duration * 1000;
  const transportErrors = result.events.filter(event => event.name === 'request-error' || (event.name === 'response' && event.status >= 400));
  const agentErrors = result.events.filter(event => event.name === 'sse' && ['error', 'input-failed', 'tool-error'].includes(event.value.type));
  result.checks = { allFiveStepsInOrder: stage === 5, earlyExecution: early, originalPagesUnchanged: unchanged,
    firstFourStepsDuringSpeech: milestones.length >= 4 && milestones.slice(0, 4).every(step => step.elapsedMs < result.fixture.duration * 1000),
    noExtraPages: after.pages.length === before.pages.length, noBrowserErrors: !test.errors.length,
    noTransportErrors: !transportErrors.length, noAgentErrors: !agentErrors.length, noIncompleteWrites: !incompleteWrites.length,
    noUnrequestedWrites: !unrequestedWrites.length };
  result.unrequestedWrites = unrequestedWrites;
  result.milestones = milestones;
  result.firstToolMs = firstTool?.elapsedMs;
  result.passed = Object.values(result.checks).every(Boolean);
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  result = await saveVoiceTest(test, directory, { passed: false, error: String(error), manifest });
  process.exitCode = 1;
}
console.log(JSON.stringify({ passed: result.passed, checks: result.checks, milestones: result.milestones, firstToolMs: result.firstToolMs, error: result.error, directory }, null, 2));
