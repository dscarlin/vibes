import test from 'node:test';
import assert from 'node:assert/strict';

import {
  atlassianDocToText,
  buildIssueBranchName,
  buildPostDeployTestDesignPrompt,
  buildReconciledBranchName,
  classifyIssueOutcome
} from './index.mjs';

test('atlassianDocToText flattens nested content', () => {
  const text = atlassianDocToText({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Line 2' }
        ]
      }
    ]
  });
  assert.match(text, /Line 1/);
  assert.match(text, /Line 2/);
});

test('classifyIssueOutcome fails when required setup step fails', () => {
  const outcome = classifyIssueOutcome(
    'ABC-1',
    [
      {
        issueKey: 'ABC-1',
        setupStepIds: ['seed-db'],
        checks: [{ id: 'check-1', ok: true }]
      }
    ],
    [{ id: 'seed-db', ok: false }]
  );
  assert.equal(outcome.status, 'AI Build Failed');
});

test('branch names follow issue and reconciled conventions', () => {
  assert.equal(buildIssueBranchName('ABC-123', 'Implement parent orchestrator'), 'ai/issue/ABC-123-implement-parent-orchest');
  assert.equal(buildReconciledBranchName('ABC-123', 'run-2026-03-18-abcdef'), 'ai/reconciled/ABC-123-run-2026-03-18-abcde');
});

test('post deploy prompt includes diff and urls', () => {
  const prompt = buildPostDeployTestDesignPrompt({
    runBranch: 'ai/run/2026-03-18-batch',
    baseSha: 'abc123',
    appUrl: 'https://app.example.com',
    apiUrl: 'https://api.example.com',
    rootHost: 'root.example.com',
    diffPath: '/tmp/run.diff',
    liveStatePath: '/tmp/live.json',
    acceptedIssues: [{ issueKey: 'ABC-1' }]
  });
  assert.match(prompt, /app\.example\.com/);
  assert.match(prompt, /run\.diff/);
  assert.match(prompt, /ABC-1/);
});
