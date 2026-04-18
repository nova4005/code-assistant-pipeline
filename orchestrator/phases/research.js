/**
 * Phase 2: Research — Gather context from the codebase to understand what exists.
 */
import fs from 'fs';
import path from 'path';

function gatherProjectContext(projectPath) {
  const context = [];

  // Read package.json if it exists
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      context.push(`## package.json\n- name: ${pkg.name}\n- dependencies: ${Object.keys(pkg.dependencies || {}).join(', ')}\n- devDependencies: ${Object.keys(pkg.devDependencies || {}).join(', ')}`);
    } catch {}
  }

  // Read composer.json if it exists
  const composerPath = path.join(projectPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
      context.push(`## composer.json\n- name: ${composer.name}\n- require: ${Object.keys(composer.require || {}).join(', ')}`);
    } catch {}
  }

  // List top-level directory structure
  try {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor')
      .map(e => `${e.name}/`);
    const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => e.name);
    context.push(`## Project Structure\nDirectories: ${dirs.join(', ')}\nRoot files: ${files.join(', ')}`);
  } catch {}

  // Read README if it exists
  for (const readme of ['README.md', 'readme.md', 'README.txt']) {
    const readmePath = path.join(projectPath, readme);
    if (fs.existsSync(readmePath)) {
      const content = fs.readFileSync(readmePath, 'utf-8').slice(0, 2000);
      context.push(`## README (first 2000 chars)\n${content}`);
      break;
    }
  }

  return context.join('\n\n');
}

export default async function run({ task, context, projectPath, client, phase }) {
  const projectContext = gatherProjectContext(projectPath);
  const triageOutput = context.triage || 'No triage output available.';

  const systemPrompt = `You are a senior software engineer performing research for a development task. You have access to the project's structure and triage analysis.

Your goal is to produce a research document that will inform the PRD and design phases.

Output a markdown document with these sections:
## Existing Code Analysis
Describe the relevant existing code, patterns, and architecture.

## Dependencies & Constraints
List relevant libraries, APIs, or system constraints.

## Similar Patterns
Identify how similar features/fixes have been implemented in this codebase.

## Technical Notes
Any important technical considerations (performance, compatibility, edge cases).

## Recommended Approach
Suggest 1-2 approaches for implementing the task, with pros/cons.`;

  const userPrompt = `Task: ${task.title}
Description: ${task.description || 'No description.'}

## Triage Analysis
${triageOutput}

## Project Context
${projectContext}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
