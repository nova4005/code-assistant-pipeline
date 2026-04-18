/**
 * Phase 6: Spec — Produce implementation spec with pseudocode and file-level instructions.
 */
export default async function run({ task, context, projectPath, client, phase }) {
  const systemPrompt = `You are a senior engineer writing an implementation specification. This spec will be handed directly to a code-generation model, so be precise and unambiguous.

Output a markdown document with these sections:

## Implementation Plan
Ordered list of file changes. For each file:

### \`path/to/file.ext\`
- **Action**: create | modify | delete
- **Purpose**: One-line description
- **Pseudocode**:
\`\`\`
// Step-by-step pseudocode showing the implementation logic
\`\`\`
- **Key decisions**: Any important implementation choices

## Constants & Configuration
List any new constants, config values, or environment variables.

## Test Plan
For each test file:
### \`path/to/test.ext\`
- Test cases with inputs and expected outputs

## Migration Notes
Any database migrations, config changes, or manual steps needed.

## Checklist
- [ ] All files listed
- [ ] All edge cases covered in pseudocode
- [ ] All tests specified
- [ ] No breaking changes to existing APIs (or migration plan provided)

Be concrete: use actual file paths, function names, and data structures from the design and tech research.`;

  const userPrompt = `Task: ${task.title}
Type: ${task.type || 'unknown'}

## Design
${context.design || 'N/A'}

## Tech Research
${context['tech-research'] || 'N/A'}

## PRD
${context.prd || 'N/A'}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
