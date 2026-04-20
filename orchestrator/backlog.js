/**
 * backlog.js — Manages the task backlog for a project.
 *
 * Tasks come from two sources:
 *   1. Manual: .llm-orchestrator/backlog.json in the project directory
 *   2. Scanned: auto-generated from TODOs/FIXMEs via scanner.js
 *
 * Tasks are deduplicated, prioritized, and filtered by complexity ceiling.
 */
import fs from 'fs';
import path from 'path';
import { scanProject } from './scanner.js';

const COMPLEXITY_ORDER = ['XS', 'S', 'M', 'L', 'XL'];
const PRIORITY_ORDER = ['critical', 'high', 'normal', 'low'];

function loadManualBacklog(projectPath) {
  const backlogFile = path.join(projectPath, '.llm-orchestrator', 'backlog.json');
  if (fs.existsSync(backlogFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(backlogFile, 'utf-8'));
      return Array.isArray(data) ? data : data.tasks || [];
    } catch {
      return [];
    }
  }
  return [];
}

function loadCompletedTasks(projectPath) {
  const stateFile = path.join(projectPath, '.llm-orchestrator', 'state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      return new Set(
        Object.entries(state.tasks || {})
          .filter(([, t]) => t.status === 'complete')
          .map(([id]) => id)
      );
    } catch {}
  }
  return new Set();
}

function deduplicateTasks(tasks) {
  const seen = new Map();
  for (const task of tasks) {
    if (!seen.has(task.id)) {
      seen.set(task.id, task);
    } else {
      // Manual tasks take priority over scanned
      const existing = seen.get(task.id);
      if (task.source !== 'scan' && existing.source === 'scan') {
        seen.set(task.id, task);
      }
    }
  }
  return Array.from(seen.values());
}

function prioritizeTasks(tasks) {
  return tasks.sort((a, b) => {
    const aPri = PRIORITY_ORDER.indexOf(a.priority || 'normal');
    const bPri = PRIORITY_ORDER.indexOf(b.priority || 'normal');
    if (aPri !== bPri) return aPri - bPri;

    const aComp = COMPLEXITY_ORDER.indexOf(a.complexity || 'M');
    const bComp = COMPLEXITY_ORDER.indexOf(b.complexity || 'M');
    return aComp - bComp;
  });
}

function filterByComplexity(tasks, ceiling) {
  const maxIndex = COMPLEXITY_ORDER.indexOf(ceiling);
  if (maxIndex === -1) return tasks;
  return tasks.filter(t => {
    const taskIndex = COMPLEXITY_ORDER.indexOf(t.complexity || 'M');
    return taskIndex <= maxIndex;
  });
}

export function loadBacklog(projectPath, projectConfig) {
  const manual = loadManualBacklog(projectPath);
  const scanned = projectConfig.scanOnRun !== false ? scanProject(projectPath) : [];
  const completed = loadCompletedTasks(projectPath);

  // Merge, deduplicate, remove completed
  let tasks = deduplicateTasks([...manual, ...scanned]);
  const beforeCompleted = tasks.length;
  tasks = tasks.filter(t => !completed.has(t.id));
  const removedCompleted = beforeCompleted - tasks.length;
  if (removedCompleted > 0) {
    process.stderr.write(`  📋 Filtered ${removedCompleted} already-completed task(s)\n`);
  }

  // Filter by complexity ceiling
  const ceiling = projectConfig.complexityCeiling || 'M';
  const beforeCeiling = tasks.length;
  tasks = filterByComplexity(tasks, ceiling);
  const removedCeiling = beforeCeiling - tasks.length;
  if (removedCeiling > 0) {
    process.stderr.write(`  📋 Filtered ${removedCeiling} task(s) above complexity ceiling "${ceiling}"\n`);
  }

  // Prioritize
  tasks = prioritizeTasks(tasks);

  return tasks;
}

export function addTask(projectPath, task) {
  const backlogFile = path.join(projectPath, '.llm-orchestrator', 'backlog.json');
  const dir = path.dirname(backlogFile);
  fs.mkdirSync(dir, { recursive: true });

  let tasks = [];
  if (fs.existsSync(backlogFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(backlogFile, 'utf-8'));
      tasks = Array.isArray(data) ? data : data.tasks || [];
    } catch {}
  }

  // Generate ID if not provided
  if (!task.id) {
    task.id = `manual-${Date.now().toString(36)}`;
  }

  tasks.push(task);
  fs.writeFileSync(backlogFile, JSON.stringify(tasks, null, 2));
  return task;
}
