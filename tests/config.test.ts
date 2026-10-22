import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModelConfiguration } from '../imslide.ts';

test('private credential reference keeps model overrides and non-thinking mode independent', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'imslide-config-'));
  const file = join(folder, 'config.yaml');
  try {
    await writeFile(file, 'agent:\n  llm:\n    api_key: fixture-private-key\n    base_url: https://example.invalid/v1\n    model: original-model\n');
    const config = await loadModelConfiguration({ PRIVATE_LLM_CONFIG: file, OPENAI_MODEL: 'qwen-flash', OPENAI_ENABLE_THINKING: 'false' });
    assert.equal(config.apiKey, 'fixture-private-key'); assert.equal(config.baseURL, 'https://example.invalid/v1');
    assert.equal(config.model, 'qwen-flash'); assert.equal(config.enableThinking, false);
    const override = await loadModelConfiguration({ PRIVATE_LLM_CONFIG: file, OPENAI_API_KEY: 'fixture-explicit-key' });
    assert.equal(override.apiKey, 'fixture-explicit-key');
    await writeFile(file, 'agent: [fixture-secret-value');
    await assert.rejects(loadModelConfiguration({ PRIVATE_LLM_CONFIG: file }), error => error instanceof Error && !error.message.includes('fixture-secret-value'));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
