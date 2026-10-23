import 'dotenv/config';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  process.exitCode = code;
}
function start(name) {
  const child = spawn('npm', ['run', name], { stdio: 'inherit', detached: true });
  children.push(child);
  child.on('exit', code => stop(code || 0));
  child.on('error', error => { console.error(error.message); stop(1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
start('dev:api');
async function ready(url) {
  for (let i = 0; i < 120 && !stopping; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await setTimeout(250);
  }
  if (!stopping) throw new Error(`Service did not start: ${url}`);
}
try {
  await ready(`http://127.0.0.1:${process.env.PORT || 3001}/api/deck`);
  if (!stopping) start('dev:web');
  await ready(`http://127.0.0.1:${process.env.WEB_PORT || 5173}/`);
  if (!stopping) start('dev:slides');
  await ready(`http://127.0.0.1:${process.env.SLIDEV_PORT || 3030}/`);
} catch (error) { console.error(error.message); stop(1); }
