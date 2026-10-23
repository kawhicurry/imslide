import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function openVoiceTest(audio, directory) {
  await mkdir(directory, { recursive: true });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
  await page.route('**/__latency.wav', route => route.fulfill({ path: audio, contentType: 'audio/wav' }));
  await page.goto(process.env.VOICE_TEST_URL || 'http://127.0.0.1:5173/');
  await page.waitForSelector('.voice-orb');
  await page.waitForSelector('.slide-cache iframe[aria-hidden="false"]', { timeout: 30000 });
  const before = await page.evaluate(async () => (await fetch('/api/deck')).json());
  const configuration = await page.evaluate(async () => ({ agent: await (await fetch('/api/status')).json(), asr: await (await fetch('/api/asr/status')).json() }));
  await page.evaluate(async () => {
    const events = []; window.latency = { events, start: null, runIds: [], messageIds: [] };
    const mark = (name, data = {}) => events.push({ name, at: performance.now(), ...data });
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('/api/asr/stream')) this.addEventListener('message', event => {
          try { mark('asr-stream', { value: JSON.parse(event.data) }); } catch {}
        });
      }
    };
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const path = String(url);
      if (!path.startsWith('/api/')) return original(url, options);
      let body;
      if (path === '/api/voice' || path === '/api/input') {
        body = JSON.parse(options.body);
        window.latency.messageIds.push(path === '/api/voice' ? `speech:${body.session}:${body.seq}` : `speech:${body.utteranceId}`);
      }
      const began = performance.now();
      mark('request', { path, body, audioSeconds: path === '/api/asr' ? options.body.byteLength / 64000 : undefined });
      try {
        const response = await original(url, options);
        const value = await response.clone().json();
        mark('response', { path, ms: performance.now() - began, status: response.status, value });
        return response;
      } catch (error) { mark('request-error', { path, error: String(error) }); throw error; }
    };
    const feed = new EventSource('/api/events');
    feed.onmessage = event => {
      const value = JSON.parse(event.data);
      if (value.type === 'accepted' && window.latency.messageIds.includes(value.messageId) && !window.latency.runIds.includes(value.runId)) window.latency.runIds.push(value.runId);
      if (value.type === 'deck' || window.latency.runIds.includes(value.runId)) mark('sse', { value });
    };
    const checkVisible = () => {
      const frame = document.querySelector('.slide-cache iframe[aria-hidden="false"]');
      const key = `${frame?.dataset.pageId}:${frame?.dataset.revision}`;
      if (frame && key !== window.latency.visibleKey) {
        window.latency.visibleKey = key;
        mark('visible', { title: frame.title, pageId: frame.dataset.pageId, revision: Number(frame.dataset.revision) });
      }
    };
    const observer = new MutationObserver(checkVisible);
    observer.observe(document.body, { subtree: true, attributes: true, childList: true }); checkVisible();
    const context = new AudioContext({ sampleRate: 16000 });
    const buffer = await context.decodeAudioData(await (await original('/__latency.wav')).arrayBuffer());
    const samples = buffer.getChannelData(0), hop = Math.round(buffer.sampleRate * 0.02);
    let voicedEnd = 0;
    for (let i = 0; i < samples.length; i += hop) {
      const end = Math.min(i + hop, samples.length); let energy = 0;
      for (let j = i; j < end; j++) energy += samples[j] * samples[j];
      if (Math.sqrt(energy / (end - i)) >= 0.0006) voicedEnd = end / buffer.sampleRate;
    }
    window.latency.fixture = { duration: buffer.duration, voicedEnd };
    const destination = context.createMediaStreamDestination();
    navigator.mediaDevices.getUserMedia = async () => destination.stream;
    window.playFixture = async () => {
      await context.resume();
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      window.latency.start = performance.now(); mark('play');
      source.onended = () => { window.latency.audioEnded = true; mark('audio-ended'); }; source.start();
    };
  });
  const progress = setInterval(() => { void page.evaluate(() => window.latency).then(value => writeFile(directory + '/progress.json', JSON.stringify(value, null, 2))).catch(() => {}); }, 1000);
  return { browser, page, before, errors, progress, configuration };
  } catch (error) {
    await page.screenshot({ path: directory + '/setup-error.png' }).catch(() => {});
    await writeFile(directory + '/setup-error.json', JSON.stringify({ passed: false, phase: 'setup', error: String(error), errors }, null, 2));
    await browser.close();
    throw error;
  }
}

export async function saveVoiceTest(test, directory, extra) {
  clearInterval(test.progress);
  let trace = await test.page.evaluate(() => window.latency).catch(() => undefined);
  const lostTrace = !Array.isArray(trace?.events);
  if (lostTrace) trace = JSON.parse(await readFile(directory + '/progress.json', 'utf8').catch(() => '{"events":[],"start":0}'));
  const evidence = { before: test.before, configuration: test.configuration, ...trace, errors: test.errors, ...extra };
  if (lostTrace) { evidence.passed = false; evidence.error = extra?.error || 'Browser navigation/reload lost the live trace; partial progress retained'; }
  evidence.events = evidence.events.map(event => ({ ...event, elapsedMs: Math.round(event.at - trace.start) }));
  await test.page.screenshot({ path: directory + '/result.png' });
  await writeFile(directory + '/result.json', JSON.stringify(evidence, null, 2));
  await test.browser.close();
  return evidence;
}
