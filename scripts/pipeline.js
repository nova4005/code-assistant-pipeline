#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = process.env.LLM_TEMPLATES_DIR || path.join(__dirname, '..', 'prompts');
const CONFIG_PATH = path.join(__dirname, '..', 'configs', 'tasks.json');

// ── Load config ─────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// ── CLI argument parsing ────────────────────────────────────────
function parseArgs(argv) {
  const args = { mode: 'review', backend: 'ollama', ctx: null, compare: false, benchmark: false, triage: false, files: [] };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--mode': args.mode = argv[++i]; break;
      case '--backend': args.backend = argv[++i]; break;
      case '--compare': args.compare = true; break;
      case '--benchmark': args.benchmark = true; break;
      case '--triage': args.triage = true; break;
      case '--ctx': {
        const raw = argv[++i];
        if (!raw || !/^\d+$/.test(raw)) throw new Error('--ctx requires a positive integer');
        args.ctx = parseInt(raw, 10);
        break;
      }
      default:
        if (!argv[i].startsWith('--')) args.files.push(argv[i]);
    }
  }
  return args;
}

// ── Framework detection ─────────────────────────────────────────
function detectFramework(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  const ext = path.extname(filePath);

  for (let i = 0; i < 5; i++) {
    const parentDir = path.join(dir, ...Array(i).fill('..'));

    // WordPress takes priority — check first
    if (
      fs.existsSync(path.join(parentDir, 'wp-config.php')) ||
      fs.existsSync(path.join(parentDir, 'wp-content'))
    ) {
      return 'wordpress';
    }

    // composer.json → Laravel
    const composerPath = path.join(parentDir, 'composer.json');
    if (fs.existsSync(composerPath)) {
      try {
        const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
        if (composer.require?.['laravel/framework']) return 'laravel';
      } catch {}
    }

    // package.json
    const pkgPath = path.join(parentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        // Electron (check before generic web frameworks)
        if (allDeps.electron) return 'electron';

        // React Native / Expo
        if (allDeps['react-native'] || allDeps.expo) return 'react-native';

        // Next.js
        if (allDeps.next) return 'nextjs';

        // Express / Fastify / Hono / Koa / NestJS (API server)
        if (
          (allDeps.express || allDeps.fastify || allDeps.hono || allDeps.koa || allDeps['@nestjs/core']) &&
          !allDeps['react-dom'] && !allDeps.next && !allDeps.vite
        ) return 'express';

        // Vite (generic SPA / frontend)
        if (allDeps.vite) return 'vite';
      } catch {}
    }

    // next.config.*
    if (
      fs.existsSync(path.join(parentDir, 'next.config.js')) ||
      fs.existsSync(path.join(parentDir, 'next.config.mjs')) ||
      fs.existsSync(path.join(parentDir, 'next.config.ts'))
    ) {
      return 'nextjs';
    }

    // vite.config.*
    if (
      fs.existsSync(path.join(parentDir, 'vite.config.js')) ||
      fs.existsSync(path.join(parentDir, 'vite.config.ts'))
    ) {
      return 'vite';
    }
  }

  // Extension fallback
  if (['.php'].includes(ext)) return 'wordpress';
  return 'tsjs';
}

// ── Prompt template resolution ──────────────────────────────────
function loadPrompt(framework, mode) {
  // Try framework-specific first, then general fallback
  const candidates = [
    path.join(TEMPLATES_DIR, framework, `${mode}.md`),
    path.join(TEMPLATES_DIR, 'general', `${mode}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  }
  throw new Error(`No prompt template found for ${framework}/${mode}. Tried:\n  ${candidates.join('\n  ')}`);
}

// ── Severity parsing (format-aware) ─────────────────────────────
// Matches severity ONLY when an actual finding accompanies it:
//   Inline format:  "- 🔴 **Critical**: finding text"  (colon required)
//   Checklist format: "### 🔴 Critical" followed by at least one "- [ ]" item
// Does NOT match bare headings or "no issues" bullets.
const INLINE_SEVERITY = {
  critical: /- \s*(?:\[[ xX]?\]\s*)?🔴\s*\*{0,2}Critical\*{0,2}\s*:/gi,
  high:     /- \s*(?:\[[ xX]?\]\s*)?🟠\s*\*{0,2}High\*{0,2}\s*:/gi,
  medium:   /- \s*(?:\[[ xX]?\]\s*)?🟡\s*\*{0,2}Medium\*{0,2}\s*:/gi,
  low:      /- \s*(?:\[[ xX]?\]\s*)?🟢\s*\*{0,2}Low\*{0,2}\s*:/gi,
};

const SECTION_HEADING = {
  critical: /^###\s*🔴\s*(?:\*{0,2})?Critical/gim,
  high:     /^###\s*🟠\s*(?:\*{0,2})?High/gim,
  medium:   /^###\s*🟡\s*(?:\*{0,2})?Medium/gim,
  low:      /^###\s*🟢\s*(?:\*{0,2})?Low/gim,
};

function parseSeverities(output) {
  const found = new Set();

  // 1. Inline format: "- 🔴 **Critical**: finding" → always a real finding
  for (const [level, regex] of Object.entries(INLINE_SEVERITY)) {
    if (regex.test(output)) found.add(level);
    regex.lastIndex = 0;
  }

  // 2. Section-heading format: "### 🔴 Critical" → only if followed by - [ ] items
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [level, regex] of Object.entries(SECTION_HEADING)) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      // Scan lines below this heading until next ### or end
      let hasFinding = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^###/.test(lines[j])) break;
        if (/^\s*-\s*\[[ x]\]/.test(lines[j])) { hasFinding = true; break; }
      }
      if (hasFinding) found.add(level);
    }
  }

  return found;
}

// ── False positive filter (safety net for CLI tools) ────────────
// These patterns match text that is ALWAYS a false positive in CLI/dev-tool context.
// Tested against the ENTIRE finding block (heading + continuation lines joined).
const FP_PATTERNS = [
  /process\.env.*(?:supply.chain|injection|attacker|environment.variable)/i,
  /(?:supply.chain|injection|attacker).*process\.env/i,
  /ollama\s+pull/i,
  /JSON\.parse.*(?:prototype.pollution|__proto__)/i,
  /(?:prototype.pollution|__proto__).*JSON\.parse/i,
  /\bSSRF\b/i,
  /\bprototype.pollution\b/i,
  /\bpath.traversal\b|\bdirectory.traversal\b/i,
  /\bsupply.chain\b/i,
  /detectedFrameworks.*spread|spread.*detectedFrameworks|\[\. \.\.\w/i,
  /npm\s+install.*(?:integrity|compromised)/i,
  /error.message.*(?:information.disclosure|data.exposure|leak)/i,
  /(?:double|properly).quoted.*(?:command.injection|shell.injection|injection)/i,
  /verbose.error|information.disclosure|data.exposure/i,
  /JSON\.parse.*(?:stream|network|response\.body|fetch)/i,
  /(?:stream|network|response\.body|fetch).*JSON\.parse/i,
  /\bcommand.injection\b.*\benvironment.variable\b/i,
  /\benvironment.variable\b.*\bcommand.injection\b/i,
  /\bunvalidated\b.*\bfile.?path\b|\bfile.?path\b.*\b(?:unvalidated|injection)\b/i,
  /process\.argv.*(?:unvalidated|inject|traversal)/i,
  /(?:unvalidated|inject|traversal).*process\.argv/i,
  /\bOOM\b|\bmemory.exhaustion\b|\bheap.out.of.memory\b/i,
  /\bunbounded\b.*\breadFileSync\b|\breadFileSync\b.*\bunbounded\b/i,
  /\buser.provided\b.*\bpath\b.*\b(?:input|inject)|\bpath\b.*\buser.provided\b/i,
  /LLM_SCRIPT.*(?:injection|shell|metachar|bypass|insufficient)/i,
  /LLM_PIPELINE_SCRIPT.*(?:injection|bypass|insufficient|exploit)/i,
  /(?:injection|shell|bypass).*LLM_SCRIPT/i,
  /\binsufficient\b.*\bregex\b|\bregex\b.*\binsufficient\b/i,
];

/**
 * Splits LLM output into finding blocks, tests each block as a whole
 * against FP patterns, and removes matched blocks before severity parsing.
 * Only active for non-server frameworks (CLI tools, libraries, etc.).
 */
function filterFalsePositives(output, framework) {
  if (['express', 'nextjs', 'vite', 'laravel', 'wordpress'].includes(framework)) return output;

  const lines = output.split('\n');
  const result = [];
  let block = [];      // accumulates lines for the current finding
  let blockStart = -1; // index where current block started

  function flushBlock() {
    if (block.length === 0) return;
    const blockText = block.join(' ');
    const isFP = FP_PATTERNS.some(rx => rx.test(blockText));
    if (!isFP) {
      result.push(...block);
    }
    block = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match both checklist (- [ ] ...) and inline-severity (- 🔴 **Critical**: ...) formats
    const isFindingStart = /^\s*-\s*(?:\[[ x]\]|[🔴🟠🟡🟢])/.test(line);
    const isSectionHeading = /^###/.test(line);

    if (isFindingStart) {
      // Flush previous finding block
      flushBlock();
      block = [line];
    } else if (isSectionHeading) {
      // Flush previous finding block, then keep heading as-is
      flushBlock();
      result.push(line);
    } else if (block.length > 0) {
      // Continuation of current finding block
      block.push(line);
    } else {
      // Non-finding line outside a block — still test against FP patterns
      const isFP = FP_PATTERNS.some(rx => rx.test(line));
      if (!isFP) result.push(line);
    }
  }
  flushBlock(); // flush last block

  return result.join('\n');
}

// ── Ollama health check ─────────────────────────────────────────
async function checkOllama(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Token estimation & chunking ─────────────────────────────────
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function chunkByFunctions(code, ext) {
  // Split on function/class/method boundaries
  let pattern;
  if (['.php'].includes(ext)) {
    pattern = /^(?=\s*(?:public|protected|private|static|function|class|interface|trait|abstract)\b)/gm;
  } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    pattern = /^(?=\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:\(|async))|(?=\s*(?:public|private|protected|static|async)\s+\w+\s*\())/gm;
  } else {
    // Fallback: split at empty lines
    pattern = /\n\n+/g;
  }

  const parts = code.split(pattern).filter(p => p.trim());
  if (parts.length <= 1) return [code];
  return parts;
}

// ── Main pipeline ───────────────────────────────────────────────
async function runPipeline(targetFile, mode, config, backendType, ctxOverride, triageEnabled = false, quiet = false) {
  const taskConfig = config.tasks[mode];
  if (!taskConfig) throw new Error(`Unknown task mode: ${mode}. Available: ${Object.keys(config.tasks).join(', ')}`);

  // When quiet, buffer all output instead of writing directly
  const stdoutBuf = [];
  const stderrBuf = [];
  const out = quiet ? (s) => stdoutBuf.push(s) : (s) => process.stdout.write(s);
  const err = quiet ? (s) => stderrBuf.push(s) : (s) => process.stderr.write(s);
  const mkResult = (exitCode) => quiet
    ? { exitCode, stdout: stdoutBuf.join(''), stderr: stderrBuf.join('') }
    : exitCode;

  const baseUrl = backendType === 'mlx'
    ? config.backend.mlxUrl
    : config.backend.ollamaUrl;
  const apiUrl = backendType === 'mlx'
    ? `${baseUrl}/v1/chat/completions`
    : `${baseUrl}/api/chat`;

  // Health check
  const isHealthy = await checkOllama(baseUrl);
  if (!isHealthy) {
    throw new Error(
      `Cannot connect to ${backendType} at ${baseUrl}.\n` +
      (backendType === 'ollama'
        ? 'Run: brew services start ollama'
        : 'Run: python scripts/mlx-server.py')
    );
  }

  const code = fs.readFileSync(path.resolve(targetFile), 'utf-8');
  const ext = path.extname(targetFile);
  const framework = detectFramework(targetFile);
  const template = loadPrompt(framework, mode);

  const numCtx = ctxOverride || taskConfig.num_ctx;
  const tokenEstimate = estimateTokens(code);

  // Chunk if file exceeds ~60K tokens (leave room for prompt + output)
  const maxInputTokens = numCtx - taskConfig.max_tokens - 2000; // reserve for prompt overhead
  let codeSegments;
  if (tokenEstimate > maxInputTokens) {
    codeSegments = chunkByFunctions(code, ext);
    err(`⚠️  File is ~${tokenEstimate} tokens, splitting into ${codeSegments.length} chunks\n`);
  } else {
    codeSegments = [code];
  }

  let fullOutput = '';

  for (let i = 0; i < codeSegments.length; i++) {
    const segment = codeSegments[i];
    const chunkLabel = codeSegments.length > 1 ? ` (chunk ${i + 1}/${codeSegments.length})` : '';

    const systemPrompt = template + `\n\n---\n**File:** \`${targetFile}\`${chunkLabel}\n\`\`\`${ext.slice(1)}\n${segment}\n\`\`\``;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), taskConfig.timeout * 1000);

    try {
      const requestBody = backendType === 'mlx'
        ? {
            model: taskConfig.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Analyze this ${mode === 'review' ? 'code' : mode === 'security' ? 'code for security vulnerabilities' : mode === 'tests' ? 'code and generate tests' : 'code and generate documentation'}: ${targetFile}${chunkLabel}` },
            ],
            temperature: taskConfig.temperature,
            max_tokens: taskConfig.max_tokens,
            stream: true,
          }
        : {
            model: taskConfig.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Analyze this ${mode === 'review' ? 'code' : mode === 'security' ? 'code for security vulnerabilities' : mode === 'tests' ? 'code and generate tests' : 'code and generate documentation'}: ${targetFile}${chunkLabel}` },
            ],
            stream: true,
            think: false,
            options: {
              temperature: taskConfig.temperature,
              num_predict: taskConfig.max_tokens,
              num_ctx: numCtx,
            },
          };

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text();
        if (body.includes('model') && body.includes('not found')) {
          throw new Error(`Model "${taskConfig.model}" not found. Run: ollama pull ${taskConfig.model}`);
        }
        throw new Error(`API error ${res.status}: ${body}`);
      }

      err(`\n🔄 Streaming ${mode} for ${targetFile} (${framework}, ctx=${numCtx})...\n`);

      // Stream response — different formats for Ollama native vs OpenAI-compat
      let buffer = '';
      for await (const chunk of res.body) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;

          if (backendType === 'mlx') {
            // OpenAI SSE format: data: {...}
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices?.[0]?.delta?.content || '';
              if (token) { out(token); fullOutput += token; }
            } catch {}
          } else {
            // Ollama native NDJSON: {"message":{"content":"..."},"done":false}
            try {
              const parsed = JSON.parse(line);
              const token = parsed.message?.content || '';
              if (token) { out(token); fullOutput += token; }
            } catch {}
          }
        }
      }

      // Drain any partial final line remaining in buffer
      if (buffer.trim()) {
        try {
          if (backendType === 'mlx') {
            if (buffer.startsWith('data: ')) {
              const data = buffer.slice(6);
              if (data !== '[DONE]') {
                const parsed = JSON.parse(data);
                const token = parsed.choices?.[0]?.delta?.content || '';
                if (token) { out(token); fullOutput += token; }
              }
            }
          } else {
            const parsed = JSON.parse(buffer);
            const token = parsed.message?.content || '';
            if (token) { out(token); fullOutput += token; }
          }
        } catch {}
      }

      if (codeSegments.length > 1) {
        out('\n\n---\n\n');
        fullOutput += '\n\n---\n\n';
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        throw new Error(
          `Timeout after ${taskConfig.timeout}s for ${mode} on ${targetFile}.\n` +
          `  The model may still be cold-loading. Try again (model stays warm for ${process.env.OLLAMA_KEEP_ALIVE || '5m'}).\n` +
          `  Or increase timeout in configs/tasks.json → tasks.${mode}.timeout`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  out('\n');

  // Write draft file if configured
  if (taskConfig.writeDraft) {
    const draftPath = path.resolve(targetFile) + `.${mode}.llm-draft`;
    fs.writeFileSync(draftPath, fullOutput, 'utf-8');
    err(`📝 Draft written to: ${draftPath}\n`);
  }

  // Severity check for commit blocking
  if (taskConfig.blockOnSeverity?.length > 0) {
    let filtered = filterFalsePositives(fullOutput, framework);

    // AI triage pass — only call when blocking severities are actually present
    if (triageEnabled && filtered.trim() && filtered.trim() !== 'No actionable findings.') {
      const preTriageSeverities = parseSeverities(filtered);
      const wouldBlock = taskConfig.blockOnSeverity.some(s => preTriageSeverities.has(s));
      if (wouldBlock) {
        filtered = await runTriage(filtered, framework, targetFile, config, backendType);
      }
    }

    if (filtered.trim() === 'No actionable findings.') {
      err('✅ Triage: all findings confirmed as false positives\n');
      return mkResult(0);
    }

    const severities = parseSeverities(filtered);
    const blocked = taskConfig.blockOnSeverity.filter(s => severities.has(s));
    if (blocked.length > 0) {
      err(`\n🚫 Commit blocked — found severity: ${blocked.join(', ')}\n`);
      err('   Fix the issues above or use --no-verify to bypass.\n');
      return mkResult(1);
    }
  }

  return mkResult(0);
}

// ── AI Triage pass ──────────────────────────────────────────────
async function runTriage(findings, framework, targetFile, config, backendType) {
  const triageConfig = config.triage;
  if (!triageConfig) return findings; // no triage config → pass through

  const triagePrompt = loadPrompt(framework, 'triage');
  const baseUrl = backendType === 'mlx'
    ? config.backend.mlxUrl
    : config.backend.ollamaUrl;
  const apiUrl = backendType === 'mlx'
    ? `${baseUrl}/v1/chat/completions`
    : `${baseUrl}/api/chat`;

  const systemPrompt = triagePrompt + `\n\n---\n**Project type detected:** ${framework}\n**File:** \`${targetFile}\`\n\n**Findings to triage:**\n${findings}`;

  const requestBody = backendType === 'mlx'
    ? {
        model: triageConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Triage these findings. Remove false positives. Return only genuine findings.' },
        ],
        temperature: triageConfig.temperature,
        max_tokens: triageConfig.max_tokens,
        stream: false,
      }
    : {
        model: triageConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Triage these findings. Remove false positives. Return only genuine findings.' },
        ],
        stream: false,
        think: false,
        options: {
          temperature: triageConfig.temperature,
          num_predict: triageConfig.max_tokens,
          num_ctx: triageConfig.num_ctx,
        },
      };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), triageConfig.timeout * 1000);

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      process.stderr.write(`⚠️  Triage API error ${res.status}, skipping triage\n`);
      return findings;
    }

    const json = await res.json();
    let triaged;
    if (backendType === 'mlx') {
      triaged = json.choices?.[0]?.message?.content || findings;
    } else {
      triaged = json.message?.content || findings;
    }

    process.stderr.write(`🔬 Triage complete — AI reviewed findings\n`);
    return triaged.trim();
  } catch (err) {
    process.stderr.write(`⚠️  Triage failed (${err.message}), using original findings\n`);
    return findings;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Benchmark: extract individual findings from LLM output ──────
function extractFindings(output) {
  const findings = [];
  const lines = output.split('\n');
  const claimed = new Set(); // line indices already extracted by inline match

  // Pass 1: Inline format — "- [ ] 🔴 **Critical**: finding text"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [severity, regex] of Object.entries(INLINE_SEVERITY)) {
      regex.lastIndex = 0;
      if (regex.test(line)) {
        let text = line;
        claimed.add(i);
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*-\s|^###|^\s*$/.test(lines[j])) break;
          text += ' ' + lines[j].trim();
          claimed.add(j);
        }
        findings.push({ severity, text });
      }
    }
  }

  // Pass 2: Section-heading format — "### 🔴 Critical" + checklist items
  for (let i = 0; i < lines.length; i++) {
    for (const [severity, regex] of Object.entries(SECTION_HEADING)) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^###/.test(lines[j])) break;
        if (claimed.has(j)) continue; // already extracted in pass 1
        if (/^\s*-\s*\[[ xX]?\]/.test(lines[j])) {
          let text = lines[j];
          claimed.add(j);
          for (let k = j + 1; k < lines.length; k++) {
            if (/^\s*-\s|^###|^\s*$/.test(lines[k])) break;
            text += ' ' + lines[k].trim();
            claimed.add(k);
          }
          findings.push({ severity, text });
        }
      }
    }
  }
  return findings;
}

// ── Benchmark: score findings against expected ground truth ─────
function scoreBenchmark(findings, expected) {
  const matched = new Set();
  let truePositives = 0;
  let severityCorrect = 0;

  for (const exp of expected) {
    let bestMatch = null;
    let bestScore = 0;

    for (let i = 0; i < findings.length; i++) {
      if (matched.has(i)) continue;
      const textLower = findings[i].text.toLowerCase();
      const hits = exp.keywords.filter(kw => textLower.includes(kw.toLowerCase()));
      const score = hits.length / exp.keywords.length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = i;
      }
    }

    // Require at least 40% keyword match to count as a TP
    if (bestMatch !== null && bestScore >= 0.4) {
      matched.add(bestMatch);
      truePositives++;
      if (findings[bestMatch].severity === exp.severity) {
        severityCorrect++;
      }
    }
  }

  const falsePositives = findings.length - matched.size;
  const falseNegatives = expected.length - truePositives;

  const precision = findings.length > 0 ? truePositives / (truePositives + falsePositives) : (expected.length === 0 ? 1 : 0);
  const recall = expected.length > 0 ? truePositives / expected.length : 1;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const severityAccuracy = truePositives > 0 ? severityCorrect / truePositives : (expected.length === 0 ? 1 : 0);

  return { truePositives, falsePositives, falseNegatives, precision, recall, f1, severityAccuracy };
}

// ── Benchmark mode ──────────────────────────────────────────────
async function runBenchmark(config, backendType, ctxOverride) {
  const models = config.compareModels || [];
  if (models.length === 0) {
    process.stderr.write('❌ No compareModels defined in configs/tasks.json\n');
    return 1;
  }

  const FIXTURES_DIR = path.join(__dirname, '..', 'test-fixtures');
  const expectedPath = path.join(FIXTURES_DIR, 'expected.json');
  if (!fs.existsSync(expectedPath)) {
    process.stderr.write('❌ test-fixtures/expected.json not found\n');
    return 1;
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'));
  const fixtureEntries = Object.entries(expected.fixtures);
  const RUNS = 3;
  const tasks = ['review', 'security'];

  // Create output capture directory
  const outputsDir = path.join(FIXTURES_DIR, 'benchmark-outputs');
  fs.mkdirSync(outputsDir, { recursive: true });

  process.stderr.write(`\n🏋️ Benchmark: ${models.length} models × ${fixtureEntries.length} fixtures × ${tasks.length} tasks × ${RUNS} runs\n\n`);

  const modelScores = {};

  for (const model of models) {
    process.stderr.write(`\n━━ ${model} ━━\n`);
    const safeModel = model.replace(/[/:]/g, '-');
    const modelDir = path.join(outputsDir, safeModel);
    fs.mkdirSync(modelDir, { recursive: true });

    modelScores[model] = { runs: [], detail: [], avgF1: 0, avgPrecision: 0, avgRecall: 0, avgSeverityAcc: 0 };

    for (let run = 1; run <= RUNS; run++) {
      process.stderr.write(`  Run ${run}/${RUNS}...\n`);
      const runResults = [];
      const runDetail = [];

      for (const [fixturePath, taskExpectations] of fixtureEntries) {
        const absPath = path.join(__dirname, '..', fixturePath);
        const fixture = path.basename(absPath, '.js');
        const framework = detectFramework(absPath);

        for (const task of tasks) {
          const exp = taskExpectations[task] || [];
          const tempConfig = JSON.parse(JSON.stringify(config));
          tempConfig.tasks[task] = { ...tempConfig.tasks[task], model, writeDraft: false, blockOnSeverity: [] };

          let captured = '';
          try {
            const result = await runPipeline(absPath, task, tempConfig, backendType, ctxOverride, false, true);
            captured = result.stdout || '';
          } catch (err) {
            process.stderr.write(`    ❌ ${task} on ${fixture}: ${err.message}\n`);
            runResults.push({ truePositives: 0, falsePositives: 0, falseNegatives: exp.length, precision: 0, recall: 0, f1: 0, severityAccuracy: 0 });
            runDetail.push({ fixture, task, run, error: err.message });
            continue;
          }

          // Save raw output for diagnostics
          const outFile = path.join(modelDir, `${fixture}-${task}-run${run}.md`);
          fs.writeFileSync(outFile, captured, 'utf-8');

          const filtered = filterFalsePositives(captured, framework);
          const findings = extractFindings(filtered);
          const score = scoreBenchmark(findings, exp);

          process.stderr.write(`    ${task} ${fixture}: F1=${score.f1.toFixed(2)} P=${score.precision.toFixed(2)} R=${score.recall.toFixed(2)} TP=${score.truePositives} FP=${score.falsePositives} FN=${score.falseNegatives}\n`);
          runResults.push(score);
          runDetail.push({ fixture, task, run, findings: findings.length, ...score });
        }
      }
      modelScores[model].runs.push(runResults);
      modelScores[model].detail.push(...runDetail);
    }

    // Average across all runs and fixture/task combos
    const allScores = modelScores[model].runs.flat();
    const n = allScores.length || 1;
    modelScores[model].avgF1 = allScores.reduce((s, r) => s + r.f1, 0) / n;
    modelScores[model].avgPrecision = allScores.reduce((s, r) => s + r.precision, 0) / n;
    modelScores[model].avgRecall = allScores.reduce((s, r) => s + r.recall, 0) / n;
    modelScores[model].avgSeverityAcc = allScores.reduce((s, r) => s + r.severityAccuracy, 0) / n;
  }

  // ── Print summary table ─────────────────────────────────────
  process.stderr.write('\n\n📊 Benchmark Results (averaged over all runs)\n\n');
  const pad = (s, n) => String(s).padEnd(n);
  const padr = (s, n) => String(s).padStart(n);
  const hdr = `│ ${pad('Model', 36)} │ ${padr('F1', 5)} │ ${padr('Prec', 5)} │ ${padr('Rec', 5)} │ ${padr('SevAcc', 6)} │`;
  const sep = `├${'─'.repeat(38)}┼${'─'.repeat(7)}┼${'─'.repeat(7)}┼${'─'.repeat(7)}┼${'─'.repeat(8)}┤`;
  process.stderr.write(`┌${'─'.repeat(38)}┬${'─'.repeat(7)}┬${'─'.repeat(7)}┬${'─'.repeat(7)}┬${'─'.repeat(8)}┐\n`);
  process.stderr.write(`${hdr}\n`);
  process.stderr.write(`${sep}\n`);

  // Sort by F1 descending
  const sorted = Object.entries(modelScores).sort((a, b) => b[1].avgF1 - a[1].avgF1);
  for (const [model, s] of sorted) {
    const row = `│ ${pad(model, 36)} │ ${padr(s.avgF1.toFixed(2), 5)} │ ${padr(s.avgPrecision.toFixed(2), 5)} │ ${padr(s.avgRecall.toFixed(2), 5)} │ ${padr(s.avgSeverityAcc.toFixed(2), 6)} │`;
    process.stderr.write(`${row}\n`);
  }
  process.stderr.write(`└${'─'.repeat(38)}┴${'─'.repeat(7)}┴${'─'.repeat(7)}┴${'─'.repeat(7)}┴${'─'.repeat(8)}┘\n`);

  // Write detailed results to JSON
  const outPath = path.join(FIXTURES_DIR, 'benchmark-results.json');
  fs.writeFileSync(outPath, JSON.stringify(modelScores, null, 2), 'utf-8');
  process.stderr.write(`\n📝 Detailed results saved to ${outPath}\n`);

  return 0;
}

// ── Model comparison mode ───────────────────────────────────────
async function runCompare(targetFile, mode, config, backendType, ctxOverride) {
  const models = config.compareModels || [];
  if (models.length === 0) {
    process.stderr.write('❌ No compareModels defined in configs/tasks.json\n');
    return 1;
  }

  const framework = detectFramework(targetFile);
  process.stderr.write(`\n📊 Comparing ${models.length} models for ${mode} on ${targetFile} (${framework})\n\n`);

  const results = [];

  for (const model of models) {
    process.stderr.write(`⏳ Running ${model}...\n`);
    // Create a temporary config override with this model
    const tempConfig = JSON.parse(JSON.stringify(config));
    tempConfig.tasks[mode] = { ...tempConfig.tasks[mode], model, writeDraft: false, blockOnSeverity: [] };

    // Capture output by temporarily replacing process.stdout.write
    let captured = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { captured += chunk; return true; };

    try {
      await runPipeline(targetFile, mode, tempConfig, backendType, ctxOverride);
    } catch (err) {
      captured = `❌ Error: ${err.message}`;
    } finally {
      process.stdout.write = origWrite;
    }

    // Parse severities from output
    const filtered = filterFalsePositives(captured, framework);
    const severities = parseSeverities(filtered);

    results.push({ model, output: captured, severities });

    // Write draft for manual comparison
    const safeModel = model.replace(/[/:]/g, '-');
    const draftPath = path.resolve(targetFile) + `.${mode}.${safeModel}.llm-draft`;
    fs.writeFileSync(draftPath, captured, 'utf-8');
    process.stderr.write(`   📝 Saved to ${draftPath}\n`);
  }

  // Print summary table
  process.stderr.write('\n');
  const pad = (s, n) => String(s).padEnd(n);
  const hdr = `│ ${pad('Model', 24)} │ 🔴  │ 🟠  │ 🟡  │ 🟢  │`;
  const sep = `├${'─'.repeat(26)}┼─────┼─────┼─────┼─────┤`;
  process.stderr.write(`┌${'─'.repeat(26)}┬─────┬─────┬─────┬─────┐\n`);
  process.stderr.write(`${hdr}\n`);
  process.stderr.write(`${sep}\n`);
  for (const r of results) {
    const c = r.severities.has('critical') ? '  ✓ ' : '    ';
    const h = r.severities.has('high')     ? '  ✓ ' : '    ';
    const m = r.severities.has('medium')   ? '  ✓ ' : '    ';
    const l = r.severities.has('low')      ? '  ✓ ' : '    ';
    process.stderr.write(`│ ${pad(r.model, 24)} │${c}│${h}│${m}│${l}│\n`);
  }
  process.stderr.write(`└${'─'.repeat(26)}┴─────┴─────┴─────┴─────┘\n`);
  process.stderr.write(`\nDraft files written for manual comparison.\n`);

  return 0;
}

// ── Parallel commit hook mode ───────────────────────────────────
async function runCommitHook(files, config, backendType, triageEnabled) {
  const hookConfig = config.commitHook;
  const tasks = hookConfig.tasks;
  // Enable triage from config OR CLI flag
  triageEnabled = triageEnabled || (hookConfig.triageEnabled ?? false);

  let maxExitCode = 0;

  for (const file of files) {
    if (hookConfig.parallelTasks) {
      const settled = await Promise.allSettled(
        tasks.map(mode => runPipeline(file, mode, config, backendType, null, triageEnabled, true))
      );
      // Print buffered output sequentially — no interleaving
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        if (result.status === 'fulfilled') {
          const { exitCode, stdout, stderr } = result.value;
          if (stderr) process.stderr.write(stderr);
          if (stdout) process.stdout.write(stdout);
          maxExitCode = Math.max(maxExitCode, exitCode);
        } else {
          process.stderr.write(`❌ ${tasks[i]} failed for ${file}: ${result.reason?.message || result.reason}\n`);
          maxExitCode = 1;
        }
      }
    } else {
      for (const mode of tasks) {
        try {
          const code = await runPipeline(file, mode, config, backendType, null, triageEnabled);
          maxExitCode = Math.max(maxExitCode, code);
        } catch (err) {
          process.stderr.write(`❌ ${mode} failed for ${file}: ${err.message}\n`);
          maxExitCode = 1;
        }
      }
    }
  }

  return maxExitCode;
}

// ── Entry point ─────────────────────────────────────────────────
const args = parseArgs(process.argv);
const config = loadConfig();

// Benchmark mode — no files needed, uses test-fixtures/
const isCommitHook = args.mode === 'review' && args.files.length >= 1 && !process.argv.includes('--mode');

if (args.benchmark) {
  runBenchmark(config, args.backend, args.ctx)
    .then(code => process.exit(code))
    .catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
} else if (args.files.length === 0) {
  console.error('Usage: node pipeline.js [--mode review|security|tests|docs] [--backend ollama|mlx] [--ctx <num>] [--compare] [--benchmark] [--triage] <file...>');
  process.exit(1);
} else if (args.compare) {
  (async () => {
    let maxCode = 0;
    for (const file of args.files) {
      try {
        const code = await runCompare(file, args.mode, config, args.backend, args.ctx);
        maxCode = Math.max(maxCode, code);
      } catch (err) {
        console.error(`❌ ${err.message}`);
        maxCode = 1;
      }
    }
    process.exit(maxCode);
  })();
} else if (isCommitHook && args.files.length > 0) {
  runCommitHook(args.files, config, args.backend, args.triage)
    .then(code => process.exit(code))
    .catch(err => { console.error(err); process.exit(1); });
} else {
  // Run each file with specified mode
  (async () => {
    let maxCode = 0;
    for (const file of args.files) {
      try {
        const code = await runPipeline(file, args.mode, config, args.backend, args.ctx, args.triage);
        maxCode = Math.max(maxCode, code);
      } catch (err) {
        console.error(`❌ ${err.message}`);
        maxCode = 1;
      }
    }
    process.exit(maxCode);
  })();
}
