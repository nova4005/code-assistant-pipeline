/**
 * Phase 7: Build — Generate the actual code based on the spec.
 *
 * This phase writes files to the project. It operates within guardrails:
 * - Never deletes files (configurable)
 * - Respects maxLinesChangedPerTask
 * - Only writes to the project directory
 */
import fs from 'fs';
import path from 'path';

function parseFileBlocks(buildOutput) {
  const blocks = [];
  const regex = /### `([^`]+)`\s*\n```[\w]*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(buildOutput)) !== null) {
    blocks.push({ filePath: match[1], content: match[2] });
  }
  return blocks;
}

function countLines(content) {
  return content.split('\n').length;
}

function isPathSafe(filePath, projectPath) {
  const resolved = path.resolve(projectPath, filePath);
  return resolved.startsWith(path.resolve(projectPath));
}

export default async function run({ task, context, projectPath, client, phase }) {
  // Load guardrails
  const orchestratorConfig = JSON.parse(
    fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'configs', 'orchestrator.json'), 'utf-8')
  );
  const guardrails = orchestratorConfig.guardrails;

  const systemPrompt = `You are a senior software engineer implementing code based on a detailed specification.

RULES:
1. Output ONLY the code files. No explanations outside of code blocks.
2. For each file, use this exact format:

### \`path/to/file.ext\`
\`\`\`language
// full file contents here
\`\`\`

3. Include ALL necessary imports and exports.
4. Follow existing code style and conventions in the project.
5. Include inline comments for complex logic.
6. Do NOT generate test files — those come in a separate phase.
7. Do NOT delete any existing files.
8. Maximum ${guardrails.maxLinesChangedPerTask} total lines of new/changed code.

Output ONLY the files. Start directly with the first ### heading.`;

  const feedbackSection = context.reviewFeedback
    ? `\n\n## Previous Review Feedback (Revision ${context.revisionIteration || '?'})\nThe previous build was reviewed and these issues MUST be fixed:\n${context.reviewFeedback}`
    : '';

  const userPrompt = `Task: ${task.title}
Type: ${task.type || 'unknown'}

## Spec
${context.spec || 'N/A'}

## Design
${context.design || 'N/A'}

## Tech Research
${context['tech-research'] || 'N/A'}${feedbackSection}`;

  const buildOutput = await client.generate(phase, systemPrompt, userPrompt);

  // Parse and write files
  const files = parseFileBlocks(buildOutput);
  let totalLines = 0;
  const writtenFiles = [];

  for (const file of files) {
    if (!isPathSafe(file.filePath, projectPath)) {
      process.stderr.write(`  ⚠️  Skipping unsafe path: ${file.filePath}\n`);
      continue;
    }

    const lines = countLines(file.content);
    if (totalLines + lines > guardrails.maxLinesChangedPerTask) {
      process.stderr.write(`  ⚠️  Line limit reached (${guardrails.maxLinesChangedPerTask}), skipping ${file.filePath}\n`);
      break;
    }

    const fullPath = path.join(projectPath, file.filePath);

    // Never delete — only create or overwrite
    if (guardrails.neverDeleteFiles && !file.content.trim()) {
      process.stderr.write(`  ⚠️  Skipping empty file: ${file.filePath}\n`);
      continue;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
    totalLines += lines;
    writtenFiles.push(file.filePath);
  }

  // Return summary + raw output for review phase
  const summary = `## Build Summary\n\nFiles written (${writtenFiles.length}):\n${writtenFiles.map(f => `- \`${f}\``).join('\n')}\n\nTotal lines: ${totalLines}\n\n---\n\n## Raw Build Output\n\n${buildOutput}`;

  return summary;
}
