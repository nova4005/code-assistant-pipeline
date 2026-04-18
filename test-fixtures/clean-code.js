#!/usr/bin/env node
/**
 * BENCHMARK TEST FIXTURE — Clean Code
 *
 * This file is intentionally well-written with NO security issues or
 * code quality problems. It uses patterns common to CLI/dev tools
 * (process.argv, fs, fetch) to stress-test false positive filters.
 *
 * ANY finding on this file is a false positive.
 *
 * Expected findings: NONE
 */

import fs from 'fs';
import path from 'path';
import { fetch } from 'undici';

const CONFIG_PATH = path.resolve('config.json');
const DEFAULT_TIMEOUT = 10000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ── CLI argument parsing (safe — no eval, no shell) ─────────────
function parseArgs(argv) {
  const args = { verbose: false, output: null, files: [] };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--verbose': args.verbose = true; break;
      case '--output': args.output = argv[++i]; break;
      default:
        if (!argv[i].startsWith('--')) args.files.push(argv[i]);
    }
  }
  return args;
}

// ── Config loading with validation ──────────────────────────────
function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`Config file too large: ${stat.size} bytes (max ${MAX_FILE_SIZE})`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${resolved}: ${err.message}`);
  }
}

// ── HTTP client with proper error handling ──────────────────────
async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${options.timeout || DEFAULT_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── File processing with proper bounds checking ─────────────────
function processFiles(filePaths) {
  const results = [];

  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    const ext = path.extname(resolved);

    if (!['.json', '.txt', '.csv'].includes(ext)) {
      console.warn(`Skipping unsupported file type: ${ext}`);
      continue;
    }

    if (!fs.existsSync(resolved)) {
      console.warn(`File not found: ${resolved}`);
      continue;
    }

    const stat = fs.statSync(resolved);
    if (stat.size > MAX_FILE_SIZE) {
      console.warn(`File too large, skipping: ${resolved}`);
      continue;
    }

    const content = fs.readFileSync(resolved, 'utf-8');

    if (ext === '.json') {
      try {
        const data = JSON.parse(content);
        results.push({ file: resolved, type: 'json', data });
      } catch (err) {
        console.warn(`Invalid JSON in ${resolved}: ${err.message}`);
      }
    } else {
      results.push({ file: resolved, type: ext.slice(1), data: content });
    }
  }

  return results;
}

// ── Retry with exponential backoff ──────────────────────────────
async function retry(fn, { retries = 3, baseDelay = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), 30000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ── Output formatting ───────────────────────────────────────────
function formatTable(rows, columns) {
  const widths = columns.map(col =>
    Math.max(col.length, ...rows.map(r => String(r[col] ?? '').length))
  );

  const header = columns.map((col, i) => col.padEnd(widths[i])).join(' │ ');
  const separator = widths.map(w => '─'.repeat(w)).join('─┼─');

  const body = rows.map(row =>
    columns.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join(' │ ')
  );

  return [header, separator, ...body].join('\n');
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  if (args.files.length === 0) {
    console.error('Usage: node clean-code.js [--verbose] [--output <path>] <file...>');
    process.exit(1);
  }

  const results = processFiles(args.files);

  if (args.verbose) {
    console.log(`Processed ${results.length} files`);
  }

  const summary = results.map(r => ({
    file: path.basename(r.file),
    type: r.type,
    size: typeof r.data === 'string' ? r.data.length : JSON.stringify(r.data).length,
  }));

  const table = formatTable(summary, ['file', 'type', 'size']);
  console.log(table);

  if (args.output) {
    fs.writeFileSync(args.output, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Results written to ${args.output}`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
