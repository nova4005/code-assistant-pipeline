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

function getDefaultBranch(cwd) {
  try {
    const symbolic = git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd);
    return symbolic.replace('origin/', '');
  } catch {
    // Fall back to checking if main or master exists
    try { git(['rev-parse', '--verify', 'main'], cwd); return 'main'; } catch {}
    try { git(['rev-parse', '--verify', 'master'], cwd); return 'master'; } catch {}
    return 'main';
  }
}

function stashChanges(cwd) {
  const status = git(['status', '--porcelain'], cwd);
  if (!status) return false;
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

function createTaskBranch(branchName, baseBranch, cwd) {
  git(['checkout', baseBranch], cwd);
  try { git(['pull', '--ff-only'], cwd); } catch {} // best-effort pull
  if (branchExists(branchName, cwd)) {
    git(['checkout', branchName], cwd);
  } else {
    git(['checkout', '-b', branchName], cwd);
  }
}

function commitPhaseArtifacts(phase, taskId, cwd) {
  try {
    git(['add', '.llm-orchestrator/'], cwd);
    const status = git(['status', '--porcelain'], cwd);
    if (status) {
      git(['commit', '-m', `chore(llm-orchestrator): ${phase} complete for ${taskId}`, '--no-verify'], cwd);
    }
  } catch (err) {
    process.stderr.write(`⚠️  Could not commit phase ${phase}: ${err.message}\n`);
  }
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
      startedAt: new Date().toISOString(),
      error: null,
    };
    saveState(projectPath, state);
  }

  const taskState = state.tasks[taskId];

  // Create/resume task branch
  const branchName = `${branchPrefix}/${taskId}`;
  try {
    createTaskBranch(branchName, task.baseBranch || getDefaultBranch(projectPath), projectPath);
  } catch (err) {
    taskState.status = 'error';
    taskState.error = `Branch creation failed: ${err.message}`;
    saveState(projectPath, state);
    return taskState;
  }

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

    process.stderr.write(`  ⏳ ${taskId} → ${phase}...\n`);

    const retryConfig = orchestratorConfig.retry;
    let lastErr;

    for (let attempt = 0; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        const runner = await loadPhaseRunner(phase);
        const output = await runner({ task, context, projectPath, client, phase });

        // Save phase output
        savePhaseOutput(projectPath, taskId, phase, output);
        context[phase] = output;

        taskState.completedPhases.push(phase);
        taskState.currentPhase = null;
        saveState(projectPath, state);

        // Commit artifacts
        commitPhaseArtifacts(phase, taskId, projectPath);
        process.stderr.write(`  ✅ ${taskId} → ${phase} complete\n`);

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
          const output = await runner({ task, context, projectPath, client, phase });

          savePhaseOutput(projectPath, taskId, phase, output);
          context[phase] = output;

          taskState.completedPhases.push(phase);
          taskState.currentPhase = null;
          saveState(projectPath, state);

          commitPhaseArtifacts(phase, taskId, projectPath);
          process.stderr.write(`  ✅ ${taskId} → ${phase} (revision ${iteration}) complete\n`);

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
}

export async function runProject(projectPath, projectConfig, orchestratorConfig) {
  const client = new LlmClient();

  // Health check
  const health = await client.healthCheck();
  if (!health.ollama) {
    throw new Error('Ollama is not reachable at ' + 'localhost:11434');
  }
  if (!health.mlx) {
    process.stderr.write('⚠️  MLX server not reachable — will fall back to Ollama for MLX phases\n');
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

  process.stderr.write(`\n📋 Running ${tasksToRun.length} task(s) for ${path.basename(projectPath)}\n`);

  // Stash uncommitted changes
  const originalBranch = currentBranch(projectPath);
  const stashed = stashChanges(projectPath);
  if (stashed) {
    process.stderr.write('📦 Stashed uncommitted changes\n');
  }

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
