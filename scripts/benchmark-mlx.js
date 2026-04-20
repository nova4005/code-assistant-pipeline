#!/usr/bin/env node
/**
 * benchmark-mlx.js – Throughput benchmark for MLX models.
 *
 * Usage:
 *   node scripts/benchmark-mlx.js           # full benchmark (all scenarios)
 *   node scripts/benchmark-mlx.js --quick   # single short scenario per model
 *
 * Streams prompts of varying context sizes through each model via
 * /v1/chat/completions, counts output tokens (one per SSE chunk),
 * and reports tok/s, TTFT, and generation time per scenario.
 */

const MLX_BASE = 'http://127.0.0.1:8765';
const QUICK_MODE = process.argv.includes('--quick');
const TEMPERATURE = 0.0;

// ── Models ──────────────────────────────────────────────────────

const MODELS = [
  { id: 'mlx-community/Qwen3.6-35B-A3B-4bit-DWQ',          label: 'Qwen3.6-35B-A3B (planning)', role: 'planning' },
  { id: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',  label: 'Qwen3-Coder-30B-A3B 4bit (code)', role: 'code' },
  { id: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-6bit-DWQ-lr3e-7', label: 'Qwen3-Coder-30B-A3B 6bit-DWQ (code)', role: 'code' },
];

// ── Synthetic prompts ───────────────────────────────────────────
// Realistic content that mirrors what the orchestrator pipeline actually sends.

const SYSTEM_SHORT = 'You are a helpful coding assistant. Be concise.';

const SYSTEM_MEDIUM = `You are an expert software architect. Given the product requirements and technical research below, produce a detailed implementation specification.

Your output MUST follow this structure exactly:
## Implementation Plan
- List every file to create or modify with a one-line summary of changes.

## Constants & Configuration
- List all magic numbers, env vars, and config keys.

## Test Plan
- Unit tests: list function-level tests.
- Integration tests: list API/E2E tests.

## Migration Steps
- Database migrations, config changes, deployment steps.

## Checklist
- [ ] All new files listed
- [ ] Edge cases addressed
- [ ] Error handling specified
- [ ] Security considerations noted`;

const SYSTEM_LARGE = `You are a senior code reviewer performing a thorough review of the implementation below.

Evaluate the code against this rubric:
1. **Correctness** — Does the code implement the spec? Are edge cases handled?
2. **Security** — SQL injection, XSS, SSRF, path traversal, secrets exposure?
3. **Performance** — N+1 queries, unnecessary allocations, missing indexes?
4. **Maintainability** — Clear naming, single responsibility, no dead code?
5. **Error handling** — Graceful degradation, proper error types, no swallowed errors?
6. **Testing** — Are critical paths tested? Are mocks appropriate?
7. **Style** — Consistent formatting, idiomatic patterns for the language?

For each issue found, output:
- severity: critical | warning | suggestion
- file: relative path
- line: approximate line number
- description: one-sentence explanation
- fix: suggested code change

Verdict: APPROVE if no critical/warning issues. REQUEST_CHANGES otherwise.
Include a summary paragraph at the end.`;

const USER_SHORT = 'Write a JavaScript function that checks if a string is a palindrome. Include edge cases.';

const USER_MEDIUM = `# Product Requirements
## Overview
Build a task queue microservice that accepts jobs via REST API, persists them to PostgreSQL, and processes them asynchronously with configurable concurrency. The service must support job priorities, retries with exponential backoff, and dead-letter handling.

## Functional Requirements
1. POST /jobs — Accept a job payload with type, priority (1-10), and arbitrary JSON data. Return job ID.
2. GET /jobs/:id — Return job status, attempts, result or error.
3. GET /jobs?status=pending&type=email — List jobs with filtering and pagination.
4. DELETE /jobs/:id — Cancel a pending job.
5. Worker pool processes jobs ordered by priority DESC, created_at ASC.
6. Failed jobs retry up to 3 times with exponential backoff (1s, 4s, 16s).
7. Jobs failing all retries move to a dead-letter table with the last error.

## Technical Research
- Use pg-boss or bull for queue semantics, but we want a custom lightweight implementation.
- PostgreSQL SKIP LOCKED for concurrent job claiming without row-level contention.
- Connection pooling via pg Pool with max 20 connections.
- Graceful shutdown: stop accepting new jobs, finish in-progress ones within 30s timeout.
- Health check endpoint at GET /health returning queue depth and worker status.

## Design Decisions
- Express.js with TypeScript for the API layer.
- Drizzle ORM for schema management and queries.
- Vitest for testing with testcontainers for PostgreSQL integration tests.
- Structured JSON logging via pino.
- Docker Compose for local development with PostgreSQL 16.`;

const USER_LARGE = `# Product Requirements
${USER_MEDIUM}

# Implementation Specification
## Files to Create/Modify
- src/index.ts — Express app setup, middleware, graceful shutdown handler
- src/routes/jobs.ts — POST/GET/DELETE job endpoints with validation
- src/db/schema.ts — Drizzle schema for jobs and dead_letter tables
- src/db/migrate.ts — Migration runner
- src/queue/worker.ts — Worker pool with configurable concurrency
- src/queue/claimer.ts — SKIP LOCKED job claiming logic
- src/queue/retry.ts — Exponential backoff calculator
- src/health.ts — Health check endpoint returning queue metrics
- tests/jobs.test.ts — API endpoint tests
- tests/worker.test.ts — Worker pool unit tests
- tests/integration/queue.test.ts — Full queue lifecycle with testcontainers
- docker-compose.yml — PostgreSQL 16 + app service
- Dockerfile — Multi-stage build

## Database Schema
\`\`\`sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(100) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','completed','failed','cancelled')),
  data JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_jobs_claimable ON jobs (priority DESC, created_at ASC)
  WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now());

CREATE TABLE dead_letter (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id),
  error TEXT NOT NULL,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
\`\`\`

## Worker Implementation Notes
- Worker pool spawns N async workers (default 4, configurable via WORKER_CONCURRENCY).
- Each worker runs a claim loop: BEGIN → SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1 → process → COMMIT.
- On failure: increment attempts, calculate next_retry_at = now() + (4^attempts) seconds.
- On max attempts exceeded: INSERT into dead_letter, SET status = 'failed'.
- Graceful shutdown sets a flag; workers finish current job then exit. 30s hard timeout via SIGALRM.

## API Validation
- POST /jobs body validated with zod: { type: string, priority?: number, data?: object }
- GET /jobs query params: status (enum), type (string), page (int), limit (int, max 100)
- All endpoints return { success: boolean, data?: T, error?: string }

## Error Handling
- Database connection failures: retry 3x with 1s backoff, then crash (let orchestrator restart).
- Invalid job type: 400 with descriptive message.
- Job not found: 404.
- Concurrent modification: handled by SKIP LOCKED (no explicit error needed).

Now review this implementation of src/queue/worker.ts:
\`\`\`typescript
import { Pool } from 'pg';
import { logger } from '../logger';

interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  shutdownTimeoutMs: number;
}

export class WorkerPool {
  private workers: Promise<void>[] = [];
  private running = false;
  private pool: Pool;
  private config: WorkerConfig;

  constructor(pool: Pool, config: Partial<WorkerConfig> = {}) {
    this.pool = pool;
    this.config = {
      concurrency: config.concurrency ?? 4,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      shutdownTimeoutMs: config.shutdownTimeoutMs ?? 30000,
    };
  }

  async start(): Promise<void> {
    this.running = true;
    for (let i = 0; i < this.config.concurrency; i++) {
      this.workers.push(this.runWorker(i));
    }
    logger.info({ concurrency: this.config.concurrency }, 'Worker pool started');
  }

  async stop(): Promise<void> {
    this.running = false;
    const timeout = setTimeout(() => {
      logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, this.config.shutdownTimeoutMs);
    await Promise.allSettled(this.workers);
    clearTimeout(timeout);
    logger.info('Worker pool stopped gracefully');
  }

  private async runWorker(id: number): Promise<void> {
    while (this.running) {
      const claimed = await this.claimAndProcess(id);
      if (!claimed) {
        await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
      }
    }
  }

  private async claimAndProcess(workerId: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(\`
        SELECT * FROM jobs
        WHERE status = 'pending'
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY priority DESC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      \`);
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const job = result.rows[0];
      await client.query("UPDATE jobs SET status = 'active', updated_at = now() WHERE id = $1", [job.id]);
      await client.query('COMMIT');

      try {
        const jobResult = await this.processJob(job);
        await client.query(
          "UPDATE jobs SET status = 'completed', result = $1, completed_at = now(), updated_at = now() WHERE id = $2",
          [JSON.stringify(jobResult), job.id]
        );
      } catch (err) {
        const attempts = job.attempts + 1;
        if (attempts >= job.max_attempts) {
          await client.query("UPDATE jobs SET status = 'failed', error = $1, attempts = $2, updated_at = now() WHERE id = $3",
            [err.message, attempts, job.id]);
          await client.query("INSERT INTO dead_letter (job_id, error) VALUES ($1, $2)", [job.id, err.message]);
        } else {
          const backoff = Math.pow(4, attempts);
          await client.query(
            "UPDATE jobs SET status = 'pending', attempts = $1, next_retry_at = now() + interval '1 second' * $2, error = $3, updated_at = now() WHERE id = $4",
            [attempts, backoff, err.message, job.id]
          );
        }
      }
      return true;
    } finally {
      client.release();
    }
  }

  private async processJob(job: any): Promise<any> {
    logger.info({ jobId: job.id, type: job.type }, 'Processing job');
    // Job type dispatch would go here
    return { processed: true };
  }
}
\`\`\``;

// ── Scenarios ───────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'Short context',
    system: SYSTEM_SHORT,
    user: USER_SHORT,
    maxTokens: 512,
    enableThinking: false,
    roles: ['planning', 'code'],
  },
  {
    name: 'Short + thinking',
    system: SYSTEM_SHORT,
    user: USER_SHORT,
    maxTokens: 512,
    enableThinking: true,
    roles: ['planning'],  // only planning model uses thinking
  },
  {
    name: 'Medium context',
    system: SYSTEM_MEDIUM,
    user: USER_MEDIUM,
    maxTokens: 1024,
    enableThinking: false,
    roles: ['planning', 'code'],
  },
  {
    name: 'Large context',
    system: SYSTEM_LARGE,
    user: USER_LARGE,
    maxTokens: 2048,
    enableThinking: false,
    roles: ['planning', 'code'],
  },
];

// ── Helpers ─────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const res = await fetch(`${MLX_BASE}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    console.log(`MLX server healthy – loaded models: ${data.models_loaded ?? '?'}\n`);
  } catch (err) {
    console.error(`✗ MLX server not reachable at ${MLX_BASE}`);
    console.error(`  Start it first:  python3 scripts/mlx-server.py\n`);
    process.exit(1);
  }
}

async function benchmarkModel(model, scenario) {
  const t0 = performance.now();

  const res = await fetch(`${MLX_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      messages: [
        { role: 'system', content: scenario.system },
        { role: 'user',   content: scenario.user },
      ],
      temperature: TEMPERATURE,
      max_tokens: scenario.maxTokens,
      stream: true,
      enable_thinking: scenario.enableThinking,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  let tFirstToken = null;
  let outputTokens = 0;
  let buffer = '';
  let fullText = '';

  for await (const chunk of res.body) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim() || !line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          if (tFirstToken === null) tFirstToken = performance.now();
          outputTokens++;
          fullText += token;
        }
      } catch {}
    }
  }

  // Drain remaining buffer
  if (buffer.trim() && buffer.startsWith('data: ') && buffer.slice(6) !== '[DONE]') {
    try {
      const parsed = JSON.parse(buffer.slice(6));
      const token = parsed.choices?.[0]?.delta?.content;
      if (token) {
        if (tFirstToken === null) tFirstToken = performance.now();
        outputTokens++;
        fullText += token;
      }
    } catch {}
  }

  const tEnd = performance.now();
  const ttft = tFirstToken !== null ? (tFirstToken - t0) / 1000 : null;
  const genTime = tFirstToken !== null ? (tEnd - tFirstToken) / 1000 : null;
  const totalTime = (tEnd - t0) / 1000;
  const tokPerSec = genTime > 0 ? outputTokens / genTime : 0;

  return { model, scenario: scenario.name, outputTokens, ttft, genTime, totalTime, tokPerSec, fullText };
}

function printResults(results) {
  const colWidths = { label: 38, scenario: 20, tokens: 8, ttft: 10, genTime: 10, tokSec: 10, total: 10 };
  const totalWidth = colWidths.label + colWidths.scenario + colWidths.tokens + colWidths.ttft + colWidths.genTime + colWidths.tokSec + colWidths.total + 18;
  const sep = '─'.repeat(totalWidth);

  console.log(sep);
  console.log(
    'Model'.padEnd(colWidths.label) + ' │ ' +
    'Scenario'.padEnd(colWidths.scenario) + ' │ ' +
    'Tokens'.padStart(colWidths.tokens) + ' │ ' +
    'TTFT (s)'.padStart(colWidths.ttft) + ' │ ' +
    'Gen (s)'.padStart(colWidths.genTime) + ' │ ' +
    'tok/s'.padStart(colWidths.tokSec) + ' │ ' +
    'Total (s)'.padStart(colWidths.total)
  );
  console.log(sep);

  // Group results by model
  const byModel = new Map();
  for (const r of results) {
    const key = r.model.label;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(r);
  }

  for (const [modelLabel, rows] of byModel) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const label = i === 0 ? modelLabel : '';
      console.log(
        label.padEnd(colWidths.label) + ' │ ' +
        r.scenario.padEnd(colWidths.scenario) + ' │ ' +
        String(r.outputTokens).padStart(colWidths.tokens) + ' │ ' +
        (r.ttft !== null ? r.ttft.toFixed(2) : 'N/A').padStart(colWidths.ttft) + ' │ ' +
        (r.genTime !== null ? r.genTime.toFixed(2) : 'N/A').padStart(colWidths.genTime) + ' │ ' +
        r.tokPerSec.toFixed(1).padStart(colWidths.tokSec) + ' │ ' +
        r.totalTime.toFixed(2).padStart(colWidths.total)
      );
    }
    // Average row
    const validRows = rows.filter(r => r.tokPerSec > 0);
    if (validRows.length > 1) {
      const avgTokSec = validRows.reduce((s, r) => s + r.tokPerSec, 0) / validRows.length;
      console.log(
        ''.padEnd(colWidths.label) + ' │ ' +
        '→ average'.padEnd(colWidths.scenario) + ' │ ' +
        ''.padStart(colWidths.tokens) + ' │ ' +
        ''.padStart(colWidths.ttft) + ' │ ' +
        ''.padStart(colWidths.genTime) + ' │ ' +
        avgTokSec.toFixed(1).padStart(colWidths.tokSec) + ' │ ' +
        ''.padStart(colWidths.total)
      );
    }
    console.log(sep);
  }
}

function printComparison(results) {
  // Compare coder models if both are present
  const coder4bit = results.filter(r => r.model.label.includes('4bit'));
  const coder8bit = results.filter(r => r.model.label.includes('8bit'));
  if (coder4bit.length === 0 || coder8bit.length === 0) return;

  console.log('\n  Coder Model Comparison (4bit vs 8bit):');

  // Match by scenario name
  for (const r4 of coder4bit) {
    const r8 = coder8bit.find(r => r.scenario === r4.scenario);
    if (!r8 || r4.tokPerSec === 0 || r8.tokPerSec === 0) continue;
    const delta = ((r8.tokPerSec - r4.tokPerSec) / r4.tokPerSec * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    console.log(`    ${r4.scenario}: 4bit ${r4.tokPerSec.toFixed(1)} tok/s → 8bit ${r8.tokPerSec.toFixed(1)} tok/s (${sign}${delta}%)`);
  }

  const avg4 = coder4bit.filter(r => r.tokPerSec > 0);
  const avg8 = coder8bit.filter(r => r.tokPerSec > 0);
  if (avg4.length && avg8.length) {
    const a4 = avg4.reduce((s, r) => s + r.tokPerSec, 0) / avg4.length;
    const a8 = avg8.reduce((s, r) => s + r.tokPerSec, 0) / avg8.length;
    const delta = ((a8 - a4) / a4 * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    console.log(`    Overall avg: 4bit ${a4.toFixed(1)} tok/s → 8bit ${a8.toFixed(1)} tok/s (${sign}${delta}%)`);
  }
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const mode = QUICK_MODE ? 'quick' : 'full';
  const activeScenarios = QUICK_MODE
    ? SCENARIOS.filter(s => s.name === 'Short context')
    : SCENARIOS;

  console.log(`MLX Model Throughput Benchmark (${mode} mode)`);
  console.log(`Scenarios: ${activeScenarios.map(s => s.name).join(', ')}`);
  console.log(`Temperature: ${TEMPERATURE}\n`);

  await checkHealth();

  const results = [];

  for (const model of MODELS) {
    const modelScenarios = activeScenarios.filter(s => s.roles.includes(model.role));
    console.log(`\n── ${model.label} (${modelScenarios.length} scenario${modelScenarios.length !== 1 ? 's' : ''}) ──`);

    for (const scenario of modelScenarios) {
      process.stdout.write(`  ${scenario.name} (max ${scenario.maxTokens} tok)… `);
      try {
        const result = await benchmarkModel(model, scenario);
        results.push(result);
        console.log(`${result.outputTokens} tokens, ${result.tokPerSec.toFixed(1)} tok/s (TTFT ${result.ttft?.toFixed(1) ?? '?'}s)`);
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        results.push({
          model,
          scenario: scenario.name,
          outputTokens: 0,
          ttft: null,
          genTime: null,
          totalTime: 0,
          tokPerSec: 0,
          fullText: '',
        });
      }
    }
  }

  console.log('\n');
  printResults(results);
  printComparison(results);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
