/**
 * Phase 9: Audit — Cross-phase consistency check using the planning model with thinking.
 *
 * Verifies that the final build output is consistent with the PRD, design, spec,
 * and review phases. Catches drift between what was planned and what was built.
 * This phase uses the planning model (Qwen3.6) with thinking enabled for deep reasoning.
 */

export default async function run({ task, context, projectPath, client, phase }) {
  const systemPrompt = `You are a meticulous technical auditor performing a final cross-phase consistency check on auto-generated code artifacts.

Your job is to compare the ENTIRE chain of artifacts — from PRD through design, spec, build, and review — and identify any drift, contradictions, or gaps between them.

Think step by step. For each requirement in the PRD/spec, trace it through to the build output and verify it was implemented.

Check for:
1. **Requirement Coverage** — Every acceptance criterion in the PRD must map to implementation in the build.
2. **Spec–Build Drift** — The build must follow the spec's architecture, naming, and data flow exactly.
3. **Design Consistency** — The build must respect the design decisions (patterns, data structures, APIs).
4. **Review Blindspots** — Flag anything the review phase may have missed or approved incorrectly.
5. **Cross-File Consistency** — If multiple files were generated, verify they reference each other correctly (imports, exports, function signatures).

Format your response as:

## Audit Summary
- **Result**: ✅ CONSISTENT | ⚠️ MINOR DRIFT | ❌ SIGNIFICANT DRIFT
- **Requirements Traced**: X/Y

## Requirement Traceability
For each PRD requirement, state whether it was implemented:
- ✅ Requirement: "..." → Implemented in \`file.js\`
- ❌ Requirement: "..." → NOT FOUND in build output

## Drift Report
List any inconsistencies between phases:
- Spec says X but build does Y
- Design specifies pattern A but build uses pattern B

## Blindspots
Issues the review phase missed or should have caught.

## Verdict
Final assessment and whether the task branch is safe to review by a human.`;

  const userPrompt = `Task: ${task.title}
Type: ${task.type || 'unknown'}

## PRD
${context.prd || 'N/A'}

## Design
${context.design || 'N/A'}

## Spec
${context.spec || 'N/A'}

## Build Output
${context.build || 'N/A'}

## Review Output
${context.review || 'N/A'}

## Tech Research
${context['tech-research'] || 'N/A'}`;

  return await client.generate(phase, systemPrompt, userPrompt);
}
