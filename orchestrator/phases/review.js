/**
 * Phase 8: Review — Review all generated artifacts and code.
 * Produces a final quality report. Does NOT auto-merge.
 *
 * Exports:
 *   - default (run): Phase runner
 *   - parseVerdict(reviewOutput): Extract verdict + issues from review markdown
 */
import fs from 'fs';
import path from 'path';

// ── Verdict parsing ─────────────────────────────────────────────

const VERDICT_PATTERN = /\*\*Verdict\*\*:\s*(?:✅|⚠️|❌)?\s*(PASS WITH NOTES|PASS|NEEDS REVISION)/i;
const ISSUES_SECTION_PATTERN = /## Issues Found\n([\s\S]*?)(?=\n## |$)/i;

export function parseVerdict(reviewOutput) {
  if (!reviewOutput) return { verdict: 'unknown', issues: '' };

  const verdictMatch = reviewOutput.match(VERDICT_PATTERN);
  let verdict = 'unknown';
  if (verdictMatch) {
    const raw = verdictMatch[1].toUpperCase().trim();
    if (raw === 'PASS') verdict = 'pass';
    else if (raw === 'PASS WITH NOTES') verdict = 'pass_with_notes';
    else if (raw === 'NEEDS REVISION') verdict = 'needs_revision';
  }

  const issuesMatch = reviewOutput.match(ISSUES_SECTION_PATTERN);
  const issues = issuesMatch ? issuesMatch[1].trim() : '';

  return { verdict, issues };
}

// ── Helpers ─────────────────────────────────────────────────────

function readWrittenFiles(projectPath, buildOutput) {
  const files = [];
  const regex = /- `([^`]+)`/g;
  let match;
  while ((match = regex.exec(buildOutput)) !== null) {
    const filePath = match[1];
    const fullPath = path.join(projectPath, filePath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        files.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
      } catch {}
    }
  }
  return files.join('\n\n') || 'No written files found to review.';
}

// ── Phase runner ────────────────────────────────────────────────

export default async function run({ task, context, projectPath, client, phase }) {
  const writtenCode = context.build
    ? readWrittenFiles(projectPath, context.build)
    : 'No build output available.';

  const isRevision = !!context.reviewFeedback;
  const revisionNote = isRevision
    ? `\n\nIMPORTANT: This is revision ${context.revisionIteration || '?'}. A previous review flagged issues that the build phase attempted to fix. You MUST specifically verify whether each previously reported issue has been addressed. If issues remain, return ❌ NEEDS REVISION again with only the unresolved items.`
    : '';

  const systemPrompt = `You are a senior code reviewer performing a final quality review of auto-generated code.${revisionNote}

Review the code for:
1. **Correctness** — Does it match the spec and PRD requirements?
2. **Security** — Any injection vectors, data exposure, or auth issues?
3. **Performance** — Any obvious N+1 queries, memory leaks, or blocking operations?
4. **Style** — Does it follow the project's existing conventions?
5. **Completeness** — Are all requirements from the spec addressed?
6. **Edge Cases** — Are edge cases from the tech research handled?

Format your response as:

## Review Summary
- **Verdict**: ✅ PASS | ⚠️ PASS WITH NOTES | ❌ NEEDS REVISION
- **Confidence**: high | medium | low

## Checklist
- [ ] Matches PRD acceptance criteria
- [ ] No security vulnerabilities introduced
- [ ] No performance regressions
- [ ] Follows project conventions
- [ ] Edge cases handled
- [ ] No files deleted
- [ ] Line count within limits

## Issues Found
List issues by severity (🔴 Critical, 🟠 High, 🟡 Medium, 🟢 Low).

## Suggestions
Improvements that are nice-to-have but not blocking.

## Next Steps
What a human reviewer should focus on when reviewing this branch.`;

  const previousReview = isRevision ? `\n\n## Previous Review Feedback\n${context.reviewFeedback}` : '';

  const userPrompt = `Task: ${task.title}
Type: ${task.type || 'unknown'}

## PRD
${context.prd || 'N/A'}

## Spec
${context.spec || 'N/A'}

## Build Output
${context.build || 'N/A'}

## Generated Code
${writtenCode}${previousReview}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
