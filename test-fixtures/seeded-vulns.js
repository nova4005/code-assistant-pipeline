#!/usr/bin/env node
/**
 * BENCHMARK TEST FIXTURE — Seeded Vulnerabilities
 *
 * This file contains INTENTIONAL security issues and code quality problems
 * at known severity levels. It is used by `--benchmark` to score models.
 *
 * DO NOT FIX THESE ISSUES — they are the test cases.
 *
 * Expected findings:
 *   🔴 Critical (3): eval injection, hardcoded API key, SQL injection
 *   🟠 High (2): missing auth check, unsafe innerHTML
 *   🟡 Medium (2): unhandled async error, overly broad catch
 *   🟢 Low (2): let→const, unused import
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto'; // 🟢 LOW: unused import — crypto is never used

// ─── 🔴 CRITICAL: Hardcoded API key ─────────────────────────────
const API_KEY = 'sk-live-4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a9e8d7c6b5';
const DB_HOST = 'localhost';
const DB_PORT = 5432;

// ─── Clean: properly configured constants (should NOT be flagged) ──
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;
const ALLOWED_EXTENSIONS = ['.js', '.ts', '.json'];

/**
 * Clean function — well-structured, no issues.
 * Models should NOT flag this.
 */
function validateInput(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Input must be a string');
  }
  if (input.length > 1000) {
    throw new RangeError('Input exceeds maximum length');
  }
  return input.trim();
}

// ─── 🔴 CRITICAL: eval() with external input ────────────────────
function processUserExpression(userInput) {
  // Dynamically evaluate user-provided expression
  const result = eval(userInput);
  return { success: true, result };
}

// ─── 🔴 CRITICAL: SQL injection via string concatenation ────────
function findUserByName(db, username) {
  const query = "SELECT * FROM users WHERE name = '" + username + "'";
  return db.query(query);
}

// ─── 🟠 HIGH: Missing authentication check ──────────────────────
function handleAdminAction(req, res) {
  // No auth check — any user can access admin functionality
  const { action, target } = req.body;
  if (action === 'delete') {
    return deleteResource(target);
  }
  if (action === 'modify') {
    return modifyResource(target, req.body.data);
  }
  res.status(400).json({ error: 'Unknown action' });
}

// ─── 🟠 HIGH: Unsafe innerHTML assignment ────────────────────────
function renderUserContent(container, userHtml) {
  container.innerHTML = userHtml;
}

// ─── Clean: safe DOM manipulation (should NOT be flagged) ────────
function renderSafeContent(container, text) {
  const el = document.createElement('span');
  el.textContent = text;
  container.appendChild(el);
}

// ─── 🟡 MEDIUM: Unhandled async error ───────────────────────────
async function fetchData(url) {
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

// ─── 🟡 MEDIUM: Overly broad try-catch ──────────────────────────
async function processFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const transformed = parsed.items.map(item => ({
      id: item.id,
      name: item.name.toUpperCase(),
      score: item.score * 100,
    }));
    fs.writeFileSync(filePath + '.out', JSON.stringify(transformed));
    return transformed;
  } catch (e) {
    console.log('Something went wrong');
  }
}

// ─── 🟢 LOW: let where const would suffice ──────────────────────
function computeStats(numbers) {
  let sum = 0;
  let count = numbers.length;
  for (const n of numbers) {
    sum += n;
  }
  return { mean: sum / count, count };
}

// ─── Clean: well-written async function (should NOT be flagged) ──
async function retryWithBackoff(fn, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, TIMEOUT_MS);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ─── Clean: proper input handling (should NOT be flagged) ────────
function parseConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${resolved}: ${err.message}`);
  }
}

// ─── Helpers referenced above (stubs) ────────────────────────────
function deleteResource(target) { return { deleted: target }; }
function modifyResource(target, data) { return { modified: target, data }; }

export {
  validateInput,
  processUserExpression,
  findUserByName,
  handleAdminAction,
  renderUserContent,
  renderSafeContent,
  fetchData,
  processFile,
  computeStats,
  retryWithBackoff,
  parseConfig,
};
