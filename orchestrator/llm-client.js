#!/usr/bin/env node
/**
 * llm-client.js — Unified Ollama + MLX client with LOCAL-ONLY enforcement.
 *
 * All HTTP requests are validated against a localhost allowlist before dispatch.
 * No cloud SDKs are imported. Raw undici fetch only.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, '..', 'configs');

// ── Local-only enforcement ──────────────────────────────────────

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function assertLocalUrl(urlStr, context) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL in ${context}: "${urlStr}"`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `🚫 LOCAL-ONLY VIOLATION in ${context}: "${urlStr}" resolves to non-local host "${host}".\n` +
      `   Only localhost/127.0.0.1/[::1] endpoints are allowed.\n` +
      `   This orchestrator is designed to use local LLMs only — no cloud APIs.`
    );
  }
}

function validateAllEndpoints(orchestratorConfig, modelsConfig, tasksConfig) {
  const errors = [];

  // Check orchestrator allowedEndpoints
  for (const url of orchestratorConfig.guardrails?.allowedEndpoints || []) {
    try { assertLocalUrl(url, 'orchestrator.json → guardrails.allowedEndpoints'); }
    catch (e) { errors.push(e.message); }
  }

  // Check tasks.json backend URLs
  if (tasksConfig?.backend?.ollamaUrl) {
    try { assertLocalUrl(tasksConfig.backend.ollamaUrl, 'tasks.json → backend.ollamaUrl'); }
    catch (e) { errors.push(e.message); }
  }
  if (tasksConfig?.backend?.mlxUrl) {
    try { assertLocalUrl(tasksConfig.backend.mlxUrl, 'tasks.json → backend.mlxUrl'); }
    catch (e) { errors.push(e.message); }
  }

  // Check that no blocked env vars are set
  for (const envVar of orchestratorConfig.guardrails?.blockedEnvVars || []) {
    if (process.env[envVar]) {
      errors.push(
        `⚠️  Blocked env var ${envVar} is set in your environment. ` +
        `The orchestrator will NOT use it, but its presence may indicate a cloud SDK is configured.`
      );
    }
  }

  return errors;
}

// ── Config loading ──────────────────────────────────────────────

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, filename), 'utf-8'));
}

// ── LLM Client class ───────────────────────────────────────────

export class LlmClient {
  #orchestratorConfig;
  #modelsConfig;
  #tasksConfig;
  #ollamaUrl;
  #mlxUrl;

  constructor() {
    this.#orchestratorConfig = loadJson('orchestrator.json');
    this.#modelsConfig = loadJson('models.json');
    this.#tasksConfig = loadJson('tasks.json');
    this.#ollamaUrl = this.#tasksConfig.backend.ollamaUrl;
    this.#mlxUrl = this.#tasksConfig.backend.mlxUrl;

    // Validate ALL endpoints on construction — fail fast
    assertLocalUrl(this.#ollamaUrl, 'tasks.json → backend.ollamaUrl');
    assertLocalUrl(this.#mlxUrl, 'tasks.json → backend.mlxUrl');
  }

  /** Run full validation (for `llm-orchestrate validate` command). */
  validate() {
    return validateAllEndpoints(this.#orchestratorConfig, this.#modelsConfig, this.#tasksConfig);
  }

  /** Get phase config from models.json. */
  getPhaseConfig(phase) {
    const cfg = this.#modelsConfig.phases[phase];
    if (!cfg) throw new Error(`No model config for phase "${phase}" in models.json`);
    return { ...cfg };
  }

  /** Check if Ollama is reachable. */
  async checkOllama() {
    try {
      const res = await fetch(`${this.#ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  }

  /** Check if MLX server is reachable. */
  async checkMlx() {
    try {
      const res = await fetch(`${this.#mlxUrl}/health`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch { return false; }
  }

  /** Health check both backends, return status object. */
  async healthCheck() {
    const [ollama, mlx] = await Promise.all([this.checkOllama(), this.checkMlx()]);
    return { ollama, mlx };
  }

  /** Resolve the backend URL for a phase, with MLX → Ollama fallback. */
  async #resolveBackend(phaseConfig) {
    if (phaseConfig.backend === 'mlx') {
      const mlxOk = await this.checkMlx();
      if (mlxOk) return { backend: 'mlx', baseUrl: this.#mlxUrl };
      process.stderr.write(`⚠️  MLX not available, falling back to Ollama for ${phaseConfig.model}\n`);
    }
    return { backend: 'ollama', baseUrl: this.#ollamaUrl };
  }

  /** Resolve MLX model name from the mlxModelMap. */
  #mlxModelName(ollamaModel) {
    return this.#modelsConfig.mlxModelMap?.[ollamaModel] || ollamaModel;
  }

  /**
   * Generate a non-streaming completion for a phase.
   * Returns the full response text.
   */
  async generate(phase, systemPrompt, userPrompt) {
    const phaseConfig = this.getPhaseConfig(phase);
    const { backend, baseUrl } = await this.#resolveBackend(phaseConfig);
    const timeout = this.#orchestratorConfig.timeouts[phase] || 900;

    const model = backend === 'mlx'
      ? this.#mlxModelName(phaseConfig.model)
      : phaseConfig.model;

    const apiUrl = backend === 'mlx'
      ? `${baseUrl}/v1/chat/completions`
      : `${baseUrl}/api/chat`;

    assertLocalUrl(apiUrl, `generate(${phase})`);

    const requestBody = backend === 'mlx'
      ? {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: phaseConfig.temperature,
          max_tokens: phaseConfig.max_tokens,
          stream: false,
        }
      : {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          think: false,
          options: {
            temperature: phaseConfig.temperature,
            num_predict: phaseConfig.max_tokens,
            num_ctx: phaseConfig.num_ctx,
          },
        };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        if (body.includes('model') && body.includes('not found')) {
          throw new Error(`Model "${model}" not found. Run: ollama pull ${phaseConfig.model}`);
        }
        throw new Error(`API error ${res.status}: ${body}`);
      }

      const json = await res.json();
      if (backend === 'mlx') {
        return json.choices?.[0]?.message?.content || '';
      }
      return json.message?.content || '';
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Timeout after ${timeout}s for phase "${phase}"`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generate a streaming completion for a phase.
   * Yields text chunks as they arrive.
   */
  async *stream(phase, systemPrompt, userPrompt) {
    const phaseConfig = this.getPhaseConfig(phase);
    const { backend, baseUrl } = await this.#resolveBackend(phaseConfig);
    const timeout = this.#orchestratorConfig.timeouts[phase] || 900;

    const model = backend === 'mlx'
      ? this.#mlxModelName(phaseConfig.model)
      : phaseConfig.model;

    const apiUrl = backend === 'mlx'
      ? `${baseUrl}/v1/chat/completions`
      : `${baseUrl}/api/chat`;

    assertLocalUrl(apiUrl, `stream(${phase})`);

    const requestBody = backend === 'mlx'
      ? {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: phaseConfig.temperature,
          max_tokens: phaseConfig.max_tokens,
          stream: true,
        }
      : {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: true,
          think: false,
          options: {
            temperature: phaseConfig.temperature,
            num_predict: phaseConfig.max_tokens,
            num_ctx: phaseConfig.num_ctx,
          },
        };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
      }

      let buffer = '';
      for await (const chunk of res.body) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          if (backend === 'mlx') {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices?.[0]?.delta?.content || '';
              if (token) yield token;
            } catch {}
          } else {
            try {
              const parsed = JSON.parse(line);
              const token = parsed.message?.content || '';
              if (token) yield token;
            } catch {}
          }
        }
      }

      // Drain remaining buffer
      if (buffer.trim()) {
        try {
          if (backend === 'mlx') {
            if (buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
              const parsed = JSON.parse(buffer.slice(6));
              const token = parsed.choices?.[0]?.delta?.content || '';
              if (token) yield token;
            }
          } else {
            const parsed = JSON.parse(buffer);
            const token = parsed.message?.content || '';
            if (token) yield token;
          }
        } catch {}
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Timeout after ${timeout}s for phase "${phase}"`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
