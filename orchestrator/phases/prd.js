/**
 * Phase 3: PRD — Product Requirements Document.
 * Turns task + research into a structured requirements spec.
 */
export default async function run({ task, context, projectPath, client, phase }) {
  const systemPrompt = `You are a product manager writing a concise PRD (Product Requirements Document) for a single development task.

Based on the triage and research provided, produce a markdown PRD with these sections:

## Objective
One-sentence summary of what this task achieves.

## Requirements
Numbered list of functional requirements. Be specific and testable.

## Non-Functional Requirements
Performance, security, accessibility, or compatibility requirements if applicable.

## Acceptance Criteria
Specific, verifiable criteria that determine when this task is done. Use "Given/When/Then" format where appropriate.

## Out of Scope
Explicitly state what this task does NOT include.

## Dependencies
List any prerequisite tasks or external dependencies.

Keep it concise — this is a single task, not a project.`;

  const userPrompt = `Task: ${task.title}
Description: ${task.description || 'No description.'}
Type: ${task.type || 'unknown'}

## Triage
${context.triage || 'N/A'}

## Research
${context.research || 'N/A'}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
