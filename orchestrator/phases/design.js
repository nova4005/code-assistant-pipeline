/**
 * Phase 5: Design — Produce the component/module design for implementation.
 */
export default async function run({ task, context, projectPath, client, phase }) {
  const systemPrompt = `You are a senior software designer. Based on the PRD and technical research, produce a detailed design document.

Output a markdown document with these sections:

## Design Overview
High-level description of the design approach.

## Component Design
For each new or modified component/module:
- Name and responsibility
- Public API (exports, methods, props)
- Internal logic (key algorithms, state management)
- Dependencies (imports, injected services)

## Data Flow
Describe how data flows through the system for the key use cases. Use simple text diagrams if helpful.

## File Structure
List the files to create or modify, with brief descriptions:
\`\`\`
path/to/file.js — Description of purpose
\`\`\`

## State Management
Describe any state changes, side effects, or persistence.

## Error Handling
How errors propagate and are handled at each layer.`;

  const userPrompt = `Task: ${task.title}
Type: ${task.type || 'unknown'}

## PRD
${context.prd || 'N/A'}

## Tech Research
${context['tech-research'] || 'N/A'}

## Research
${context.research || 'N/A'}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
