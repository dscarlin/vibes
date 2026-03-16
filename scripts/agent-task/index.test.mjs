import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTaskContext,
  cleanupCompletedCleanly,
  deriveTaskSlug,
  ensureManifestDefaults,
  overallRunStatus,
  parseArgs,
  shouldRunCleanupStage,
  validationWarningsFromArtifacts
} from './index.mjs';

test('parseArgs handles resume and feature validation flags', () => {
  const args = parseArgs([
    'resume',
    '--manifest',
    '/tmp/run/manifest.json',
    '--feature-validation-cmd',
    'npm run test:e2e',
    '--skip-cleanup'
  ]);
  assert.equal(args._[0], 'resume');
  assert.equal(args.manifest, '/tmp/run/manifest.json');
  assert.equal(args.featureValidationCmd, 'npm run test:e2e');
  assert.equal(args.skipCleanup, true);
});

test('deriveTaskSlug falls back to branch and run suffix', () => {
  const slug = deriveTaskSlug('Feature/Big-Thing', '', '2026-03-16T00-00-00Z-abcdef');
  assert.match(slug, /^feature-big-thing-/);
  assert.ok(slug.length <= 28);
});

test('buildTaskContext produces namespaced hosts and runtime namespaces', () => {
  const context = buildTaskContext(
    {
      ROOT_HOST: 'vibesplatform.ai',
      PROJECT_HOST_DOMAIN: 'vibesplatform.ai',
      AWS_REGION: 'us-east-1'
    },
    'feature-branch',
    'task-demo'
  );
  assert.equal(context.schema, 'task_task_demo');
  assert.equal(context.hosts.api, 'api-task-demo.vibesplatform.ai');
  assert.equal(context.namespaces.platform, 'vibes-task-task-demo');
  assert.equal(context.namespaces.development, 'vibes-task-task-demo-dev');
  assert.equal(context.projectDatabasePrefix, 'vibes_task_task_demo');
});

test('validationWarningsFromArtifacts fails closed for workspace preview leftovers', () => {
  const warnings = validationWarningsFromArtifacts({
    summary: {
      task: {
        id: 'task-1',
        status: 'completed',
        commit_hash: 'abc123'
      },
      full_build: {
        id: 'build-1',
        status: 'live',
        ref_commit: 'abc123'
      }
    },
    routeState: {
      project: {
        environments: {
          development: {
            build_status: 'live',
            preview_mode: 'workspace',
            selected_mode: 'verified',
            live_task_id: 'task-1',
            live_commit_sha: 'abc123'
          }
        }
      }
    },
    runtimeLogs: {
      body: {
        attempt_id: 'build-1',
        logs: '[system] Workspace preview running from commit abc123.\n'
      }
    },
    verifiedMatch: {
      matched_in: 'resource'
    },
    repoMarkerText: '/tmp/repo/web/src/App.jsx:1:abc123'
  });

  assert.deepEqual(
    warnings.sort(),
    ['verified_preview_mode_missing', 'verified_runtime_still_workspace_preview'].sort()
  );
});

test('validationWarningsFromArtifacts accepts a fully verified result', () => {
  const warnings = validationWarningsFromArtifacts({
    summary: {
      task: {
        id: 'task-1',
        status: 'completed',
        commit_hash: 'abc123'
      },
      full_build: {
        id: 'build-1',
        status: 'live',
        ref_commit: 'abc123'
      }
    },
    routeState: {
      project: {
        environments: {
          development: {
            build_status: 'live',
            preview_mode: 'verified',
            selected_mode: 'verified',
            live_task_id: 'task-1',
            live_commit_sha: 'abc123'
          }
        }
      }
    },
    runtimeLogs: {
      body: {
        attempt_id: 'build-1',
        logs: '2026-03-16T00:00:00Z server listening on http://localhost:3000\n'
      }
    },
    verifiedMatch: {
      matched_in: 'resource'
    },
    repoMarkerText: '/tmp/repo/web/src/App.jsx:1:abc123'
  });

  assert.deepEqual(warnings, []);
});

test('overallRunStatus reports success only after verified push and clean cleanup', () => {
  const manifest = ensureManifestDefaults({
    cleanup: {
      completedAt: '2026-03-16T00:00:00Z',
      errors: []
    },
    status: {
      publish: {
        skipPush: false,
        remoteVerifiedAt: '2026-03-16T00:00:00Z'
      }
    },
    stages: {
      publish: { status: 'completed' },
      cleanup: { status: 'completed' }
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  assert.equal(overallRunStatus(manifest, { warnings: [] }), 'succeeded');
});

test('overallRunStatus fails when push verification is missing', () => {
  const manifest = ensureManifestDefaults({
    cleanup: {
      completedAt: '2026-03-16T00:00:00Z',
      errors: []
    },
    status: {
      publish: {
        skipPush: false,
        remoteVerifiedAt: null
      }
    },
    stages: {
      publish: { status: 'completed' },
      cleanup: { status: 'completed' }
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  assert.equal(overallRunStatus(manifest, { warnings: [] }), 'failed');
});

test('shouldRunCleanupStage skips cleanup for a successful terminal manifest', () => {
  const manifest = ensureManifestDefaults({
    cleanup: {
      completedAt: '2026-03-16T00:00:00Z',
      errors: []
    },
    status: {
      publish: {
        skipPush: false,
        remoteVerifiedAt: '2026-03-16T00:00:00Z'
      }
    },
    stages: {
      cleanup: {
        status: 'completed'
      }
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  assert.equal(cleanupCompletedCleanly(manifest), true);
  assert.equal(shouldRunCleanupStage(manifest, null), false);
});

test('shouldRunCleanupStage reruns cleanup when the previous cleanup was incomplete', () => {
  const manifest = ensureManifestDefaults({
    cleanup: {
      completedAt: null,
      errors: []
    },
    status: {
      publish: {
        skipPush: false,
        remoteVerifiedAt: '2026-03-16T00:00:00Z'
      }
    },
    stages: {
      cleanup: {
        status: 'running'
      }
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  assert.equal(cleanupCompletedCleanly(manifest), false);
  assert.equal(shouldRunCleanupStage(manifest, null), true);
});

test('overallRunStatus reports cleaning_up when cleanup stage is active', () => {
  const manifest = ensureManifestDefaults({
    cleanup: {
      completedAt: '2026-03-16T00:00:00Z',
      errors: []
    },
    status: {
      publish: {
        skipPush: false,
        remoteVerifiedAt: '2026-03-16T00:00:00Z'
      }
    },
    stages: {
      cleanup: {
        status: 'running'
      }
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  assert.equal(overallRunStatus(manifest, { warnings: [] }), 'cleaning_up');
});
