/**
 * Phase 1: Triage — Classify the task, estimate complexity, decide if it's actionable.
 */
export default async function run({ task, context, projectPath, client, phase }) {
  const systemPrompt = `You are a senior engineering triage bot. Your job is to analyze a task description and produce a structured triage assessment.

Output a markdown document with exactly these sections:
## Task Classification
- Type: (feature | bugfix | refactor | docs | test | chore)
- Complexity: (XS | S | M | L | XL)
- Confidence: (high | medium | low)

## Scope Analysis
Describe what parts of the codebase are likely affected. Be specific about directories, files, or modules.

## Risk Assessment
Identify potential risks: breaking changes, performance impact, security considerations.

## Recommendation
State whether this task should proceed to the next phase, and list any blockers or prerequisites.

## Key Questions
List 1-3 questions that need answering during the research phase.`;

  const userPrompt = `Task ID: ${task.id}
Title: ${task.title}
Description: ${task.description || 'No description provided.'}
Project path: ${projectPath}
Task type hint: ${task.type || 'unknown'}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
