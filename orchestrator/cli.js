#!/usr/bin/env node
/**
 * cli.js — CLI entry point for the LLM orchestrator.
 *
 * Commands:
 *   llm-orchestrate run           Run orchestrator for all enabled projects
 *   llm-orchestrate run <path>    Run for a single project path
 *   llm-orchestrate scan <path>   Scan project for TODO/FIXME tasks
 *   llm-orchestrate add <path>    Add a task to a project's backlog
 *   llm-orchestrate status <path> Show task status for a project
 *   llm-orchestrate validate      Validate config and LOCAL-ONLY enforcement
 *   llm-orchestrate health        Check LLM backend health
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAll, runProject } from './orchestrator.js';
import { LlmClient } from './llm-client.js';
import { scanProject } from './scanner.js';
import { addTask, loadBacklog } from './backlog.js';
import { generateReport, writeReport } from './reporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS_DIR = path.join(__dirname, '..', 'configs');

function loadJson(filename) {
  return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, filename), 'utf-8'));
}

const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'run':
      await cmdRun(args);
      break;
    case 'scan':
      cmdScan(args);
      break;
    case 'add':
      cmdAdd(args);
      break;
    case 'status':
      cmdStatus(args);
      break;
    case 'validate':
      cmdValidate();
      break;
    case 'health':
      await cmdHealth();
      break;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function cmdRun(args) {
  const startTime = Date.now();

  if (args[0]) {
    // Single project mode
    const projectPath = path.resolve(args[0]);
    if (!fs.existsSync(projectPath)) {
      process.stderr.write(`❌ Path not found: ${projectPath}\n`);
      process.exit(1);
    }

    const orchestratorConfig = loadJson('orchestrator.json');
    const projectsConfig = loadJson('projects.json');
    const mergedConfig = { ...projectsConfig.defaults, path: projectPath };

    try {
      const results = await runProject(projectPath, mergedConfig, orchestratorConfig);
      const report = generateReport([{ project: projectPath, results }], startTime);
      process.stdout.write(report + '\n');

      const reportPath = path.join(projectPath, '.llm-orchestrator', 'reports',
        `run-${new Date().toISOString().slice(0, 10)}.md`);
      writeReport(report, reportPath);
      process.stderr.write(`📄 Report written to ${reportPath}\n`);
    } catch (err) {
      process.stderr.write(`❌ ${err.message}\n`);
      process.exit(1);
    }
  } else {
    // Multi-project mode
    try {
      const allResults = await runAll(startTime);
      const report = generateReport(allResults, startTime);
      process.stdout.write(report + '\n');

      const reportPath = path.join(__dirname, '..', 'reports',
        `run-${new Date().toISOString().slice(0, 10)}.md`);
      writeReport(report, reportPath);
      process.stderr.write(`📄 Report written to ${reportPath}\n`);
    } catch (err) {
      process.stderr.write(`❌ ${err.message}\n`);
      process.exit(1);
    }
  }
}

function cmdScan(args) {
  const projectPath = path.resolve(args[0] || '.');
  if (!fs.existsSync(projectPath)) {
    process.stderr.write(`❌ Path not found: ${projectPath}\n`);
    process.exit(1);
  }

  const tasks = scanProject(projectPath);
  process.stdout.write(`Found ${tasks.length} task(s):\n\n`);

  for (const task of tasks) {
    const pri = task.priority === 'high' ? '🔴' : '⚪';
    process.stdout.write(`${pri} [${task.type}] ${task.title}\n`);
    process.stdout.write(`  ${task.file}:${task.line}\n\n`);
  }
}

function cmdAdd(args) {
  const projectPath = path.resolve(args[0] || '.');

  // Read task details from stdin or args
  const title = args[1];
  if (!title) {
    process.stderr.write(`Usage: llm-orchestrate add <path> "<title>" [--type <type>] [--priority <priority>]\n`);
    process.exit(1);
  }

  const task = {
    title,
    type: getFlag(args, '--type') || 'feature',
    priority: getFlag(args, '--priority') || 'normal',
    description: getFlag(args, '--desc') || '',
    source: 'manual',
  };

  const added = addTask(projectPath, task);
  process.stdout.write(`✅ Added task: ${added.id} — ${added.title}\n`);
}

function cmdStatus(args) {
  const projectPath = path.resolve(args[0] || '.');
  const stateFile = path.join(projectPath, '.llm-orchestrator', 'state.json');

  if (!fs.existsSync(stateFile)) {
    process.stdout.write('No orchestrator state found for this project.\n');
    return;
  }

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  const tasks = Object.values(state.tasks || {});

  if (tasks.length === 0) {
    process.stdout.write('No tasks in state.\n');
    return;
  }

  for (const task of tasks) {
    const icon = task.status === 'complete' ? '✅' :
      task.status === 'error' ? '❌' :
      task.status === 'running' ? '⏳' : '⚪';

    process.stdout.write(`${icon} ${task.id}: ${task.title || 'Untitled'} [${task.status}]\n`);
    if (task.completedPhases?.length) {
      process.stdout.write(`   Phases: ${task.completedPhases.join(' → ')}\n`);
    }
    if (task.error) {
      process.stdout.write(`   Error: ${task.error}\n`);
    }
  }
}

function cmdValidate() {
  process.stdout.write('🔒 Validating LOCAL-ONLY enforcement...\n\n');

  try {
    const client = new LlmClient();
    const warnings = client.validate();

    if (warnings.length === 0) {
      process.stdout.write('✅ All endpoints are local. No blocked env vars detected.\n');
    } else {
      for (const w of warnings) {
        process.stdout.write(`⚠️  ${w}\n`);
      }
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`❌ Validation failed: ${err.message}\n`);
    process.exit(1);
  }
}

async function cmdHealth() {
  process.stdout.write('🏥 Checking LLM backends...\n\n');

  try {
    const client = new LlmClient();
    const health = await client.healthCheck();

    process.stdout.write(`Ollama (localhost:11434): ${health.ollama ? '✅ Online' : '❌ Offline'}\n`);
    process.stdout.write(`MLX    (localhost:8765):  ${health.mlx ? '✅ Online' : '❌ Offline'}\n`);

    if (!health.ollama && !health.mlx) {
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`❌ Health check failed: ${err.message}\n`);
    process.exit(1);
  }
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

function printUsage() {
  process.stdout.write(`
LLM Orchestrator — Overnight autonomous pipeline

Usage:
  llm-orchestrate run              Run for all enabled projects
  llm-orchestrate run <path>       Run for a single project
  llm-orchestrate scan <path>      Scan project for TODO/FIXME tasks
  llm-orchestrate add <path> "title" [--type feature] [--priority normal]
  llm-orchestrate status <path>    Show task status
  llm-orchestrate validate         Validate config and LOCAL-ONLY enforcement
  llm-orchestrate health           Check LLM backend health
`);
}

main().catch(err => {
  process.stderr.write(`❌ Fatal: ${err.message}\n`);
  process.exit(1);
});
