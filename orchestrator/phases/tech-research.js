/**
 * Phase 4: Tech Research — Deep technical investigation based on PRD requirements.
 */
import fs from 'fs';
import path from 'path';

function readRelevantFiles(projectPath, task) {
  const files = [];
  const stateDir = path.join(projectPath, '.llm-orchestrator', 'tasks', task.id);

  // Try to find files mentioned in previous phases
  for (const phase of ['triage', 'research', 'prd']) {
    const phasePath = path.join(stateDir, `${phase}.md`);
    if (fs.existsSync(phasePath)) {
      const content = fs.readFileSync(phasePath, 'utf-8');
      // Extract file paths mentioned (simple heuristic)
      const pathMatches = content.match(/(?:src|lib|app|pages|components|routes)\/[\w/.-]+/g);
      if (pathMatches) {
        for (const p of new Set(pathMatches)) {
          const fullPath = path.join(projectPath, p);
          if (fs.existsSync(fullPath)) {
            try {
              const fileContent = fs.readFileSync(fullPath, 'utf-8');
              if (fileContent.length < 10000) {
                files.push(`### ${p}\n\`\`\`\n${fileContent}\n\`\`\``);
              } else {
                files.push(`### ${p} (truncated to 10k chars)\n\`\`\`\n${fileContent.slice(0, 10000)}\n\`\`\``);
              }
            } catch {}
          }
        }
      }
    }
  }

  return files.length > 0 ? files.join('\n\n') : 'No relevant source files identified.';
}

export default async function run({ task, context, projectPath, client, phase }) {
  const relevantCode = readRelevantFiles(projectPath, task);

  const systemPrompt = `You are a senior software architect performing deep technical research for an implementation task.

Based on the PRD and research provided, investigate the technical approach in detail.

Output a markdown document with these sections:

## Architecture Decision
Describe the chosen approach and why. Reference specific patterns from the codebase.

## API / Interface Design
Define the key interfaces, function signatures, or data structures needed.

## Implementation Strategy
Step-by-step technical plan, including file changes and their order.

## Edge Cases
List edge cases to handle and how to handle them.

## Testing Strategy
Describe what tests are needed (unit, integration, e2e).

## Risks & Mitigations
Technical risks and how to mitigate them.`;

  const userPrompt = `Task: ${task.title}
Type: ${task.type || 'unknown'}

## PRD
${context.prd || 'N/A'}

## Research
${context.research || 'N/A'}

## Relevant Source Code
${relevantCode}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
