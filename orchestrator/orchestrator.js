#!/usr/bin/env node
/**
 * orchestrator.js — Core state machine for the overnight autonomous pipeline.
 *
 * Flow per task:
 *   1. Stash uncommitted changes
 *   2. Checkout base branch (main/master), create task branch
 *   3. Advance through phases: triage → research → prd → tech-research → design → spec → build → review
 *   4. Commit artifacts after each phase
 *   5. Restore stash when done
 *
 * Supports multi-project via projects.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
import { LlmClient } from './llm-client.js';
import { parseVerdict } from './phases/review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, '..', 'configs');

// ── Config loading ──────────────────────────────────────────────

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, filename), 'utf-8'));
}

// ── Git helpers (never auto-merge, never push) ──────────────────

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000 }).trim();
}

function gitQuiet(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function getDefaultBranch(cwd) {
  // First check if main or master branch exists locally (works without remotes)
  try { gitQuiet(['rev-parse', '--verify', 'main'], cwd); return 'main'; } catch {}
  try { gitQuiet(['rev-parse', '--verify', 'master'], cwd); return 'master'; } catch {}
  // Fall back to remote HEAD if available
  try {
    const symbolic = gitQuiet(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd);
    return symbolic.replace('origin/', '');
  } catch {}
  return 'main';
}

function stashChanges(cwd) {
  // Commit any pending .llm-orchestrator/ state first so it's excluded from
  // the stash — prevents conflicts on pop when state.json is updated mid-run.
  try {
    git(['add', '.llm-orchestrator/'], cwd);
    const orchStatus = git(['status', '--porcelain', '--', '.llm-orchestrator/'], cwd);
    if (orchStatus) {
      git(['commit', '-m', 'chore(llm-orchestrator): save state before run', '--no-verify'], cwd);
    }
  } catch {}

  // Stash remaining user changes (tracked files only; untracked survive branch
  // switches and git stash push without -u won't touch them).
  const status = git(['status', '--porcelain'], cwd);
  if (!status) return false;
  const hasTrackedChanges = status.split('\n').some(
    line => line.trim() && line.slice(0, 2) !== '??'
  );
  if (!hasTrackedChanges) return false;
  git(['stash', 'push', '-m', 'llm-orchestrator: pre-run stash'], cwd);
  return true;
}

function restoreStash(cwd) {
  try {
    const list = git(['stash', 'list'], cwd);
    if (list.includes('llm-orchestrator: pre-run stash')) {
      git(['stash', 'pop'], cwd);
      return true;
    }
  } catch {}
  return false;
}

function currentBranch(cwd) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

function branchExists(branchName, cwd) {
  try {
    git(['rev-parse', '--verify', branchName], cwd);
    return true;
  } catch { return false; }
}

function ensureStateGitignore(cwd) {
  const gitignorePath = path.join(cwd, STATE_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.mkdirSync(path.join(cwd, STATE_DIR), { recursive: true });
    fs.writeFileSync(gitignorePath, 'state.json\n');
  }
  // Untrack state.json if it was previously committed
  try {
    gitQuiet(['rm', '--cached', path.join(STATE_DIR, 'state.json')], cwd);
    git(['add', path.join(STATE_DIR, '.gitignore')], cwd);
    const status = git(['status', '--porcelain', '--', STATE_DIR], cwd);
    if (status) {
      git(['commit', '-m', 'chore(llm-orchestrator): untrack state.json (persist locally)', '--no-verify'], cwd);
    }
  } catch {
    // state.json wasn't tracked — nothing to do
  }
}

function createTaskBranch(branchName, baseBranch, cwd) {
  // Commit any pending state changes before switching branches
  try {
    git(['add', '.llm-orchestrator/'], cwd);
    const status = git(['status', '--porcelain', '--', '.llm-orchestrator/'], cwd);
    if (status) {
      git(['commit', '-m', 'chore(llm-orchestrator): save state before branch switch', '--no-verify'], cwd);
    }
  } catch {}
  git(['checkout', baseBranch], cwd);
  try {
    execFileSync('git', ['pull', '--ff-only'], { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {} // best-effort pull; suppress stdout+stderr for repos without remotes
  if (branchExists(branchName, cwd)) {
    try {
      git(['checkout', branchName], cwd);
    } catch {
      // Working tree may be dirty from a previous run — force checkout
      git(['checkout', '-f', branchName], cwd);
    }
  } else {
    git(['checkout', '-b', branchName], cwd);
  }
}

function commitPhaseArtifacts(phase, taskId, cwd, baseBranch) {
  try {
    // For build phase, stage all files (build writes to the project dir);
    // for other phases, only stage .llm-orchestrator/ metadata.
    if (phase === 'build') {
      git(['add', '-A'], cwd);
    } else {
      git(['add', '.llm-orchestrator/'], cwd);
    }
    const status = git(['status', '--porcelain'], cwd);
    if (status) {
      git(['commit', '-m', `chore(llm-orchestrator): ${phase} complete for ${taskId}`, '--no-verify'], cwd);
    }
  } catch (err) {
    process.stderr.write(`⚠️  Could not commit phase ${phase}: ${err.message}\n`);
  }

  // After the last planning phase (spec), squash all planning commits into one
  if (phase === 'spec' && baseBranch) {
    try {
      const mergeBase = git(['merge-base', 'HEAD', baseBranch], cwd);
      git(['reset', '--soft', mergeBase], cwd);
      git(['commit', '-m', `chore(llm-orchestrator): planning complete for ${taskId} [triage→spec]`, '--no-verify'], cwd);
    } catch (err) {
      process.stderr.write(`⚠️  Could not squash planning commits: ${err.message}\n`);
    }
  }
}

function finalizeTaskBranch(taskId, title, baseBranch, cwd) {
  try {
    // Commit any remaining uncommitted work on the task branch
    git(['add', '-A'], cwd);
    const status = git(['status', '--porcelain'], cwd);
    if (status) {
      git(['commit', '-m', `chore(llm-orchestrator): finalize ${taskId}`, '--no-verify'], cwd);
    }
  } catch (err) {
    process.stderr.write(`⚠️  Could not finalize task branch: ${err.message}\n`);
  }

  // Squash all execution-phase commits (build→review→audit + revisions) into one
  // The planning commit is the first commit after the merge base; keep it and
  // squash everything after it into a single execution commit.
  try {
    const mergeBase = git(['merge-base', 'HEAD', baseBranch], cwd);
    // Count commits since merge base
    const commitCount = parseInt(git(['rev-list', '--count', `${mergeBase}..HEAD`], cwd), 10);
    if (commitCount > 1) {
      // The first commit after mergeBase is the planning commit — find its SHA
      const planningCommit = git(['rev-list', '--ancestry-path', `${mergeBase}..HEAD`, '--reverse'], cwd)
        .split('\n')[0];
      git(['reset', '--soft', planningCommit], cwd);
      git(['commit', '-m', `feat(llm-orchestrator): task ${taskId} — ${title}`, '--no-verify'], cwd);
    } else if (commitCount === 1) {
      // Only planning commit exists (no execution phases ran); amend its message
      git(['commit', '--amend', '-m', `feat(llm-orchestrator): task ${taskId} — ${title}`, '--no-verify'], cwd);
    }
  } catch (err) {
    process.stderr.write(`⚠️  Could not squash execution commits: ${err.message}\n`);
  }
  // Do NOT checkout baseBranch or commit to it — the user reviews and merges.
}

// ── State persistence ───────────────────────────────────────────

const STATE_DIR = '.llm-orchestrator';
const STATE_FILE = 'state.json';

function getStateDir(projectPath) {
  return path.join(projectPath, STATE_DIR);
}

function loadState(projectPath) {
  const stateFile = path.join(getStateDir(projectPath), STATE_FILE);
  if (fs.existsSync(stateFile)) {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  }
  return { tasks: {}, lastRun: null };
}

function saveState(projectPath, state) {
  const dir = getStateDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

function savePhaseOutput(projectPath, taskId, phase, output) {
  const dir = path.join(getStateDir(projectPath), 'tasks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${phase}.md`), output);
}

function loadPhaseOutput(projectPath, taskId, phase) {
  const filePath = path.join(getStateDir(projectPath), 'tasks', taskId, `${phase}.md`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
}

function saveRevisionOutput(projectPath, taskId, phase, iteration) {
  const dir = path.join(getStateDir(projectPath), 'tasks', taskId);
  const src = path.join(dir, `${phase}.md`);
  if (fs.existsSync(src)) {
    const dest = path.join(dir, `${phase}-r${iteration}.md`);
    fs.copyFileSync(src, dest);
  }
}

// ── Phase runners ───────────────────────────────────────────────

async function loadPhaseRunner(phase) {
  const mod = await import(`./phases/${phase}.js`);
  return mod.default || mod.run;
}

// ── Memory pressure check ───────────────────────────────────────

function checkMemoryPressure(threshold) {
  try {
    const output = execSync('memory_pressure', { encoding: 'utf-8', timeout: 5000 });
    // Parse "System-wide memory free percentage: 15%" from output
    const match = output.match(/memory free percentage:\s*(\d+)%/i);
    if (match) {
      const freePercent = parseInt(match[1], 10);
      const usedPercent = 100 - freePercent;
      if (usedPercent >= threshold) return true;
    }
    // Fallback: treat WARNING/CRITICAL as pressure regardless of threshold
    if (output.includes('WARNING') || output.includes('CRITICAL')) {
      return true;
    }
  } catch {
    // memory_pressure not available or error — proceed anyway
  }
  return false;
}

// ── Time budget check ───────────────────────────────────────────

function isWithinTimeBudget(startTime, maxHours) {
  const elapsed = (Date.now() - startTime) / (1000 * 60 * 60);
  return elapsed < maxHours;
}

// ── Core orchestration ──────────────────────────────────────────

export async function runTask(projectPath, task, client, orchestratorConfig) {
  const phases = orchestratorConfig.pipeline.phases;
  const skipPhases = orchestratorConfig.pipeline.skipPhasesForTypes[task.type] || [];
  const branchPrefix = orchestratorConfig.branchPrefix;

  const state = loadState(projectPath);
  const taskId = task.id;

  // Initialize task state if needed
  if (!state.tasks[taskId]) {
    state.tasks[taskId] = {
      id: taskId,
      title: task.title,
      type: task.type,
      status: 'pending',
      currentPhase: null,
      completedPhases: [],
      phaseTiming: {},
      startedAt: new Date().toISOString(),
      error: null,
    };
    saveState(projectPath, state);
  }

  const taskState = state.tasks[taskId];

  // Create/resume task branch
  const branchName = `${branchPrefix}/${taskId}`;
  const baseBranch = task.baseBranch || getDefaultBranch(projectPath);
  try {
    createTaskBranch(branchName, baseBranch, projectPath);
  } catch (err) {
    taskState.status = 'error';
    taskState.error = `Branch creation failed: ${err.message}`;
    saveState(projectPath, state);
    return taskState;
  }

  try {
  // Build context from completed phases
  const context = {};
  for (const p of taskState.completedPhases) {
    context[p] = loadPhaseOutput(projectPath, taskId, p);
  }

  // Run remaining phases
  for (const phase of phases) {
    if (skipPhases.includes(phase)) continue;
    if (taskState.completedPhases.includes(phase)) continue;

    taskState.currentPhase = phase;
    taskState.status = 'running';
    saveState(projectPath, state);

    // Check memory pressure before each phase
    if (checkMemoryPressure(orchestratorConfig.guardrails.memoryPressureThreshold)) {
      taskState.status = 'error';
      taskState.error = `Memory pressure exceeded ${orchestratorConfig.guardrails.memoryPressureThreshold}% before phase "${phase}"`;
      taskState.currentPhase = null;
      saveState(projectPath, state);
      process.stderr.write(`  ⚠️  ${taskId} → memory pressure too high, stopping before ${phase}\n`);
      return taskState;
    }

    process.stderr.write(`  ⏳ ${taskId} → ${phase}...\n`);

    const retryConfig = orchestratorConfig.retry;
    let lastErr;

    for (let attempt = 0; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        const runner = await loadPhaseRunner(phase);
        const phaseStart = Date.now();
        const output = await runner({ task, context, projectPath, client, phase });
        const phaseElapsed = ((Date.now() - phaseStart) / 1000).toFixed(1);

        // Save phase output
        savePhaseOutput(projectPath, taskId, phase, output);
        context[phase] = output;

        taskState.completedPhases.push(phase);
        taskState.currentPhase = null;
        if (!taskState.phaseTiming) taskState.phaseTiming = {};
        taskState.phaseTiming[phase] = parseFloat(phaseElapsed);
        saveState(projectPath, state);

        // Track files written during build phase
        if (phase === 'build') {
          const fileListMatch = output.match(/Files written \(\d+\):\n((?:- `[^`]+`\n?)*)/);
          if (fileListMatch) {
            const files = [...fileListMatch[1].matchAll(/- `([^`]+)`/g)].map(m => m[1]);
            taskState.filesWritten = files;
            saveState(projectPath, state);
          }
        }

        // Commit artifacts
        commitPhaseArtifacts(phase, taskId, projectPath, baseBranch);
        process.stderr.write(`  ✅ ${taskId} → ${phase} complete (${phaseElapsed}s)\n`);

        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < retryConfig.maxAttempts) {
          process.stderr.write(
            `  ⚠️  ${phase} attempt ${attempt + 1} failed: ${err.message} — retrying in ${retryConfig.backoffMs}ms\n`
          );
          await new Promise(r => setTimeout(r, retryConfig.backoffMs));
        }
      }
    }

    if (lastErr) {
      taskState.status = 'error';
      taskState.error = `Phase "${phase}" failed: ${lastErr.message}`;
      taskState.currentPhase = null;
      saveState(projectPath, state);
      process.stderr.write(`  ❌ ${taskId} → ${phase} failed: ${lastErr.message}\n`);
      return taskState;
    }
  }

  // ── Revision loop: build → review ──────────────────────────────
  const revisionConfig = orchestratorConfig.revision || { maxIterations: 0, retryOnVerdict: [] };
  const maxRevisions = revisionConfig.maxIterations || 0;
  const retryVerdicts = new Set((revisionConfig.retryOnVerdict || []).map(v => v.toUpperCase()));

  if (!taskState.revisionCount) taskState.revisionCount = 0;
  if (!taskState.revisionHistory) taskState.revisionHistory = [];

  while (taskState.revisionCount < maxRevisions) {
    // Only check if review phase actually completed
    if (!context.review) break;

    const { verdict, issues } = parseVerdict(context.review);
    taskState.revisionHistory.push({
      iteration: taskState.revisionCount + 1,
      verdict,
      timestamp: new Date().toISOString(),
    });
    saveState(projectPath, state);

    // Check if verdict triggers revision
    if (!retryVerdicts.has(verdict.toUpperCase().replace(/_/g, ' '))) {
      process.stderr.write(`  📋 Review verdict: ${verdict} — no revision needed\n`);
      break;
    }

    taskState.revisionCount++;
    const iteration = taskState.revisionCount;
    process.stderr.write(`  🔄 Review verdict: NEEDS REVISION — starting revision ${iteration}/${maxRevisions}\n`);

    // Archive current build + review outputs before overwriting
    saveRevisionOutput(projectPath, taskId, 'build', iteration);
    saveRevisionOutput(projectPath, taskId, 'review', iteration);

    // Remove build + review from completed phases so they re-run
    taskState.completedPhases = taskState.completedPhases.filter(p => p !== 'build' && p !== 'review');

    // Inject review feedback into context for build + review phases
    context.reviewFeedback = issues || context.review;
    context.revisionIteration = iteration;
    delete context.build;
    delete context.review;

    saveState(projectPath, state);

    // Re-run build and review phases
    for (const phase of ['build', 'review']) {
      if (skipPhases.includes(phase)) continue;

      taskState.currentPhase = phase;
      taskState.status = 'running';
      saveState(projectPath, state);

      process.stderr.write(`  ⏳ ${taskId} → ${phase} (revision ${iteration})...\n`);

      const retryConfig = orchestratorConfig.retry;
      let lastErr;

      for (let attempt = 0; attempt <= retryConfig.maxAttempts; attempt++) {
        try {
          const runner = await loadPhaseRunner(phase);
          const phaseStart = Date.now();
          const output = await runner({ task, context, projectPath, client, phase });
          const phaseElapsed = ((Date.now() - phaseStart) / 1000).toFixed(1);

          savePhaseOutput(projectPath, taskId, phase, output);
          context[phase] = output;

          taskState.completedPhases.push(phase);
          taskState.currentPhase = null;
          if (!taskState.phaseTiming) taskState.phaseTiming = {};
          taskState.phaseTiming[`${phase}-r${iteration}`] = parseFloat(phaseElapsed);
          saveState(projectPath, state);

          commitPhaseArtifacts(phase, taskId, projectPath, baseBranch);
          process.stderr.write(`  ✅ ${taskId} → ${phase} (revision ${iteration}) complete (${phaseElapsed}s)\n`);

          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < retryConfig.maxAttempts) {
            process.stderr.write(
              `  ⚠️  ${phase} revision ${iteration} attempt ${attempt + 1} failed: ${err.message} — retrying in ${retryConfig.backoffMs}ms\n`
            );
            await new Promise(r => setTimeout(r, retryConfig.backoffMs));
          }
        }
      }

      if (lastErr) {
        taskState.status = 'error';
        taskState.error = `Phase "${phase}" revision ${iteration} failed: ${lastErr.message}`;
        taskState.currentPhase = null;
        saveState(projectPath, state);
        process.stderr.write(`  ❌ ${taskId} → ${phase} revision ${iteration} failed: ${lastErr.message}\n`);
        return taskState;
      }
    }
  }

  // Log final verdict if revisions were attempted
  if (taskState.revisionCount > 0 && context.review) {
    const { verdict } = parseVerdict(context.review);
    process.stderr.write(`  📋 Final verdict after ${taskState.revisionCount} revision(s): ${verdict}\n`);
  }

  taskState.status = 'complete';
  taskState.completedAt = new Date().toISOString();
  saveState(projectPath, state);
  process.stderr.write(`  🏁 ${taskId} complete\n`);
  return taskState;

  } finally {
    // Always commit task work and return to base branch
    finalizeTaskBranch(taskId, task.title, baseBranch, projectPath);
  }
}

export async function runProject(projectPath, projectConfig, orchestratorConfig) {
  const client = new LlmClient();

  // Health check
  const health = await client.healthCheck();
  if (!health.mlx) {
    throw new Error('MLX server is not reachable at localhost:8765');
  }
  if (!health.ollama) {
    process.stderr.write('⚠️  Ollama not reachable — Ollama fallback unavailable\n');
  }

  // Load backlog
  const { loadBacklog } = await import('./backlog.js');
  const tasks = loadBacklog(projectPath, projectConfig);

  if (tasks.length === 0) {
    process.stderr.write(`📭 No tasks for ${projectConfig.path || projectPath}\n`);
    return [];
  }

  const maxTasks = projectConfig.maxTasksPerRun || 5;
  const tasksToRun = tasks.slice(0, maxTasks);

  process.stderr.write(`\n📋 ${tasks.length} task(s) in backlog, running ${tasksToRun.length} (maxTasksPerRun: ${maxTasks})\n`);
  process.stderr.write(`📋 Running for ${path.basename(projectPath)}\n`);

  // Stash uncommitted changes
  const originalBranch = currentBranch(projectPath);
  const stashed = stashChanges(projectPath);
  if (stashed) {
    process.stderr.write('📦 Stashed uncommitted changes\n');
  }

  // Ensure state.json is gitignored so it persists across branch switches
  ensureStateGitignore(projectPath);

  const results = [];

  try {
    for (const task of tasksToRun) {
      // Memory pressure check
      if (checkMemoryPressure(orchestratorConfig.guardrails.memoryPressureThreshold)) {
        process.stderr.write('⚠️  Memory pressure detected — stopping early\n');
        break;
      }

      const result = await runTask(projectPath, task, client, orchestratorConfig);
      results.push(result);
    }
  } finally {
    // Update lastRun timestamp on state (state.json is gitignored, persists on disk)
    try {
      const state = loadState(projectPath);
      state.lastRun = new Date().toISOString();
      saveState(projectPath, state);
    } catch {}

    // Restore original branch and stash
    try {
      git(['checkout', originalBranch], projectPath);
    } catch {
      process.stderr.write(`⚠️  Could not restore branch ${originalBranch}\n`);
    }
    if (stashed) {
      restoreStash(projectPath);
      process.stderr.write('📦 Restored stashed changes\n');
    }
  }

  return results;
}

export async function runAll(startTime) {
  const orchestratorConfig = loadJson('orchestrator.json');
  const projectsConfig = loadJson('projects.json');

  const client = new LlmClient();
  const warnings = client.validate();
  if (warnings.length > 0) {
    for (const w of warnings) process.stderr.write(`${w}\n`);
  }

  const allResults = [];

  for (const project of projectsConfig.projects) {
    if (!project.enabled && project.enabled !== undefined) continue;

    // Time budget check
    if (!isWithinTimeBudget(startTime, orchestratorConfig.schedule.maxHours)) {
      process.stderr.write('⏰ Time budget exceeded — stopping\n');
      break;
    }

    const projectPath = path.resolve(project.path);
    if (!fs.existsSync(projectPath)) {
      process.stderr.write(`⚠️  Project path not found: ${projectPath}\n`);
      continue;
    }

    const mergedConfig = { ...projectsConfig.defaults, ...project };

    try {
      const results = await runProject(projectPath, mergedConfig, orchestratorConfig);
      allResults.push({ project: project.path, results });
    } catch (err) {
      process.stderr.write(`❌ Project ${project.path} failed: ${err.message}\n`);
      allResults.push({ project: project.path, error: err.message });
    }
  }

  return allResults;
}
