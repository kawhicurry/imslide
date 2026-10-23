// Real browser + virtual microphone + live backend ASR/Agent. Adds one page.
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { openVoiceTest, saveVoiceTest } from './voice-test-browser.mjs';
if (!process.argv[2]) throw new Error('Usage: node scripts/test-voice-latency.mjs <audio.wav>');
const directory = resolve(process.env.VOICE_LATENCY_OUTPUT || '.data/voice-latency');
const test = await openVoiceTest(resolve(process.argv[2]), directory);
let result;
try {
  const { page, before } = test;
  await page.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await page.getByRole('button', { name: '停止语音输入', exact: true }).waitFor({ timeout: 90000 });
  await page.evaluate(() => window.playFixture());
  await page.waitForFunction(() => window.latency.events.some(event => event.name === 'sse' && event.value.type === 'done' && window.latency.runIds.includes(event.value.runId)), null, { timeout: 60000 });
  const after = await page.evaluate(async () => (await fetch('/api/deck')).json());
  if (after.pages.length !== before.pages.length + 1) throw new Error('Expected exactly one new page');
  const target = after.pages[after.current];
  if (before.pages.some(page => page.id === target.id)) throw new Error('Expected a newly created current page');
  await page.waitForFunction(({ id, revision }) => {
    const frame = document.querySelector('.slide-cache iframe[aria-hidden="false"]');
    return frame?.dataset.pageId === id && Number(frame.dataset.revision) === revision;
  }, { id: target.id, revision: after.revision }, { timeout: 30000 });
  const rendering = await page.evaluate(() => {
    const frame = document.querySelector('.slide-cache iframe[aria-hidden="false"]');
    return { frames: document.querySelectorAll('.slide-cache iframe').length,
      emptyFrames: document.querySelectorAll('.slide-cache iframe[data-snapshot="canonical-empty-document"]').length,
      actualText: frame?.contentDocument?.querySelector('#slide-content')?.textContent?.trim() };
  });
  if (target.content === '' && rendering.actualText !== '') throw new Error('The visible document must actually contain the confirmed empty page');
  // Early execution must survive the rest of the original audio and the cloud
  // confirmation, rather than obtaining a fast score by cutting the fixture.
  await page.waitForFunction(() => window.latency.audioEnded, null, { timeout: 60000 });
  await page.getByRole('button', { name: '停止语音输入', exact: true }).click();
  if (await page.evaluate(() => window.latency.events.some(event => event.name === 'asr-stream'))) {
    await page.waitForFunction(() => window.latency.events.some(event => event.name === 'asr-stream' && event.value.type === 'done'), null, { timeout: 15000 });
  }
  await page.waitForFunction(async () => {
    const state = window.latency;
    const relevant = event => ['/api/asr', '/api/voice'].includes(event.path);
    const pending = state.events.filter(event => event.name === 'request' && relevant(event)).length
      - state.events.filter(event => ['response', 'request-error'].includes(event.name) && relevant(event)).length;
    return !pending && !(await (await fetch('/api/status')).json()).running;
  }, null, { timeout: 60000 });
  const confirmed = await page.evaluate(async () => (await fetch('/api/deck')).json());
  if (JSON.stringify(confirmed) !== JSON.stringify(after)) throw new Error('Late speech/confirmation changed the completed short instruction');
  result = await saveVoiceTest(test, directory, { after, rendering, passed: !test.errors.length });
  const at = predicate => result.events.find(predicate)?.elapsedMs;
  const voiceEnd = Math.round(result.fixture.voicedEnd * 1000);
  const accepted = at(event => event.name === 'sse' && event.value.type === 'accepted');
  const saved = at(event => event.name === 'sse' && event.value.type === 'deck' && event.value.deck.revision === after.revision && event.elapsedMs >= accepted);
  const visible = at(event => event.name === 'visible' && event.pageId === target.id && event.revision === after.revision);
  const responses = path => result.events.filter(event => event.name === 'response' && event.path === path);
  result.summary = { asrMs: responses('/api/asr')[0]?.ms, calibrationRequests: responses('/api/asr/merge').length,
    modelRequests: result.events.filter(event => event.name === 'sse' && event.value.type === 'model-step' && event.value.phase === 'start').length,
    physicalModelRequests: result.events.filter(event => event.name === 'sse' && event.value.type === 'model-request').length,
    voiceIntakeMs: responses('/api/voice')[0]?.ms, agentToSaveMs: saved - accepted, renderMs: visible - saved,
    speechToSaveMs: saved - voiceEnd, speechToVisibleMs: visible - voiceEnd, playToVisibleMs: visible };
  if (result.summary.calibrationRequests || result.summary.modelRequests !== 1) {
    result.passed = false; result.error = 'Expected one Agent inference and no independent calibration';
  }
  const visibleBudget = Number(process.env.VOICE_VISIBLE_BUDGET_MS || 0);
  if (visibleBudget > 0) {
    result.summary.visibleBudgetMs = visibleBudget;
    result.summary.withinVisibleBudget = Number.isFinite(result.summary.speechToVisibleMs) && result.summary.speechToVisibleMs < visibleBudget;
    if (!result.summary.withinVisibleBudget) { result.passed = false; result.error = `Speech-to-visible must be below ${visibleBudget}ms`; }
  }
  await writeFile(directory + '/result.json', JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  result = await saveVoiceTest(test, directory, { passed: false, error: String(error) });
  process.exitCode = 1;
}
console.log(JSON.stringify({ passed: result.passed, error: result.error, summary: result.summary, directory }, null, 2));
