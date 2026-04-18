/**
 * reporter.js — Generates human-readable reports from orchestrator run results.
 */
import fs from 'fs';
import path from 'path';

export function generateReport(allResults, startTime) {
  const elapsed = ((Date.now() - startTime) / (1000 * 60)).toFixed(1);
  const lines = [];

  lines.push(`# 🤖 LLM Orchestrator Report`);
  lines.push(`**Run completed:** ${new Date().toISOString()}`);
  lines.push(`**Duration:** ${elapsed} minutes`);
  lines.push('');

  let totalTasks = 0;
  let completedTasks = 0;
  let failedTasks = 0;

  for (const projectResult of allResults) {
    lines.push(`## 📁 ${projectResult.project}`);

    if (projectResult.error) {
      lines.push(`❌ **Error:** ${projectResult.error}`);
      lines.push('');
      continue;
    }

    const results = projectResult.results || [];
    lines.push(`Tasks processed: ${results.length}`);
    lines.push('');

    for (const task of results) {
      totalTasks++;
      const icon = task.status === 'complete' ? '✅' : task.status === 'error' ? '❌' : '⏳';

      if (task.status === 'complete') completedTasks++;
      if (task.status === 'error') failedTasks++;

      lines.push(`### ${icon} ${task.id}: ${task.title || 'Untitled'}`);
      lines.push(`- Status: **${task.status}**`);
      lines.push(`- Phases completed: ${(task.completedPhases || []).join(' → ')}`);

      if (task.error) {
        lines.push(`- Error: ${task.error}`);
      }

      if (task.status === 'complete') {
        lines.push(`- Branch: \`llm-orchestrator/${task.id}\``);
      }

      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`## Summary`);
  lines.push(`- Total tasks: ${totalTasks}`);
  lines.push(`- Completed: ${completedTasks}`);
  lines.push(`- Failed: ${failedTasks}`);
  lines.push(`- Duration: ${elapsed} min`);

  return lines.join('\n');
}

export function writeReport(reportContent, outputPath) {
  const reportDir = path.dirname(outputPath);
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(outputPath, reportContent);
}
