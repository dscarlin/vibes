import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentTaskGuardEnv,
  buildTaskContext,
  cleanupCompletedCleanly,
  domainFromEmailAddress,
  deriveTaskSlug,
  ensureManifestDefaults,
  normalizeNotifyOn,
  notificationShouldSend,
  overallRunStatus,
  parseArgs,
  resolveNotificationSettings,
  sesSenderIdentityCandidates,
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
    '--notify-email',
    'alerts@example.com',
    '--notify-on',
    'failure',
    '--skip-cleanup'
  ]);
  assert.equal(args._[0], 'resume');
  assert.equal(args.manifest, '/tmp/run/manifest.json');
  assert.equal(args.featureValidationCmd, 'npm run test:e2e');
  assert.equal(args.notifyEmail, 'alerts@example.com');
  assert.equal(args.notifyOn, 'failure');
  assert.equal(args.skipCleanup, true);
});

test('resolveNotificationSettings defaults to ottobotowner always', () => {
  assert.deepEqual(resolveNotificationSettings({}, {}), {
    email: 'ottobotowner@gmail.com',
    notifyOn: 'always',
    fromEmail: 'noreply@vibesplatform.ai',
    replyTo: 'ottobotowner@gmail.com',
    region: 'us-east-1'
  });
});

test('resolveNotificationSettings honors explicit args', () => {
  assert.deepEqual(
    resolveNotificationSettings(
      { notifyEmail: 'alerts@example.com', notifyOn: 'failure' },
      { notifyEmail: 'stored@example.com', notifyOn: 'success' }
    ),
    {
      email: 'alerts@example.com',
      notifyOn: 'failure',
      fromEmail: 'noreply@vibesplatform.ai',
      replyTo: 'ottobotowner@gmail.com',
      region: 'us-east-1'
    }
  );
});

test('notificationShouldSend matches requested mode', () => {
  assert.equal(notificationShouldSend('succeeded', 'always'), true);
  assert.equal(notificationShouldSend('succeeded', 'success'), true);
  assert.equal(notificationShouldSend('failed', 'success'), false);
  assert.equal(notificationShouldSend('failed', 'failure'), true);
  assert.equal(notificationShouldSend('succeeded', 'failure'), false);
  assert.equal(notificationShouldSend('failed', 'never'), false);
});

test('normalizeNotifyOn rejects invalid values', () => {
  assert.throws(() => normalizeNotifyOn('sometimes'), /Invalid --notify-on value/);
});

test('sesSenderIdentityCandidates falls back to the sender domain', () => {
  assert.equal(domainFromEmailAddress('noreply@vibesplatform.ai'), 'vibesplatform.ai');
  assert.deepEqual(sesSenderIdentityCandidates('noreply@vibesplatform.ai'), [
    'noreply@vibesplatform.ai',
    'vibesplatform.ai'
  ]);
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

test('agentTaskGuardEnv encodes the expected task target contract', () => {
  const manifest = {
    task: {
      namespaces: {
        platform: 'vibes-task-demo'
      },
      workloads: {
        server: 'vibes-server-demo',
        web: 'vibes-web-demo',
        worker: 'vibes-worker-demo',
        redis: 'redis-demo'
      },
      hosts: {
        root: 'task-demo.vibesplatform.ai',
        app: 'app-task-demo.vibesplatform.ai',
        api: 'api-task-demo.vibesplatform.ai'
      }
    }
  };

  assert.deepEqual(agentTaskGuardEnv(manifest), {
    AGENT_TASK_STRICT: 'true',
    AGENT_TASK_EXPECTED_PLATFORM_NAMESPACE: 'vibes-task-demo',
    AGENT_TASK_EXPECTED_PLATFORM_SERVER_NAME: 'vibes-server-demo',
    AGENT_TASK_EXPECTED_PLATFORM_WEB_NAME: 'vibes-web-demo',
    AGENT_TASK_EXPECTED_PLATFORM_WORKER_NAME: 'vibes-worker-demo',
    AGENT_TASK_EXPECTED_PLATFORM_REDIS_NAME: 'redis-demo',
    AGENT_TASK_EXPECTED_ROOT_HOST: 'task-demo.vibesplatform.ai',
    AGENT_TASK_EXPECTED_APP_HOST: 'app-task-demo.vibesplatform.ai',
    AGENT_TASK_EXPECTED_API_HOST: 'api-task-demo.vibesplatform.ai'
  });
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
