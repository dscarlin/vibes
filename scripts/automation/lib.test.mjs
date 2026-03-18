import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRunBranchName, extractJsonPayload, renderReviewEmail } from './lib.mjs';

test('extractJsonPayload supports fenced json output', () => {
  const payload = extractJsonPayload('```json\n{"ok":true,"items":[1,2]}\n```');
  assert.deepEqual(payload, { ok: true, items: [1, 2] });
});

test('renderReviewEmail includes candidate details', () => {
  const body = renderReviewEmail(
    {
      meetingId: 'meeting-123',
      title: 'Planning',
      generatedAt: '2026-03-18T12:00:00Z',
      source: { name: 'planning.m4a' }
    },
    [
      {
        title: 'Improve auth errors',
        type: 'bug',
        why_it_exists: 'Users cannot tell what failed',
        user_business_value: 'Higher conversion',
        tentative_implementation_summary: 'Refine modal notices',
        confidence: 'high',
        ambiguity_notes: 'Need copy review'
      }
    ]
  );
  assert.match(body, /Improve auth errors/);
  assert.match(body, /Higher conversion/);
  assert.match(body, /Need copy review/);
});

test('buildRunBranchName uses ai run namespace', () => {
  assert.equal(buildRunBranchName(new Date('2026-03-18T00:00:00Z'), 'Morning Batch'), 'ai/run/2026-03-18-morning-batch');
});
