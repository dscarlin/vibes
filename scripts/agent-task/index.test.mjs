import test from 'node:test';
import assert from 'node:assert/strict';

import {
  agentTaskGuardEnv,
  buildTaskContext,
  cleanupValidation,
  cleanupCompletedCleanly,
  domainFromEmailAddress,
  dropDatabases,
  deriveTaskSlug,
  ensureManifestDefaults,
  normalizeNotifyOn,
  notificationShouldSend,
  overallRunStatus,
  parseArgs,
  resolveNotificationSettings,
  resolveTaskDatabaseCleanupPlan,
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
  assert.equal(notificationShouldSend('published_with_validation_failures', 'failure'), true);
  assert.equal(notificationShouldSend('published_with_validation_failures', 'success'), false);
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

test('overallRunStatus reports published_with_validation_failures after a pushed branch and failed feature validation', () => {
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
      'feature-validation': { status: 'failed' },
      publish: { status: 'completed' },
      cleanup: { status: 'completed' }
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  assert.equal(overallRunStatus(manifest, { warnings: [] }), 'published_with_validation_failures');
});

test('overallRunStatus still fails when a non-validation stage fails even if publish succeeded', () => {
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
      codex: { status: 'failed' },
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

test('resolveTaskDatabaseCleanupPlan prefers validation summary databases', async () => {
  const manifest = ensureManifestDefaults({
    cleanup: {},
    status: {
      overlayReady: true
    },
    task: {
      projectDatabasePrefix: 'vibes_task_demo'
    },
    database: {
      customerAdminUrl: 'postgresql://user:pass@example.com:5432/postgres'
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  const plan = await resolveTaskDatabaseCleanupPlan(manifest, {
    summary: {
      project: {
        databases: [
          { db_name: 'vibes_task_demo_abcd_development' },
          { db_name: 'vibes_task_demo_abcd_development' },
          { db_name: 'other_project_abcd_development' }
        ]
      }
    },
    listDatabasesByPrefix: async () => {
      throw new Error('prefix scan should not run when validation summary databases are present');
    }
  });

  assert.deepEqual(plan, {
    attempted: true,
    source: 'summary',
    databases: ['vibes_task_demo_abcd_development']
  });
});

test('resolveTaskDatabaseCleanupPlan falls back to prefix scan without validation metadata', async () => {
  const manifest = ensureManifestDefaults({
    cleanup: {},
    status: {
      overlayReady: true
    },
    task: {
      projectDatabasePrefix: 'vibes_task_demo'
    },
    database: {
      customerAdminUrl: 'postgresql://user:pass@example.com:5432/postgres'
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  const plan = await resolveTaskDatabaseCleanupPlan(manifest, {
    listDatabasesByPrefix: async () => ['vibes_task_demo_abcd_testing']
  });

  assert.deepEqual(plan, {
    attempted: true,
    source: 'prefix_scan',
    databases: ['vibes_task_demo_abcd_testing']
  });
});

test('resolveTaskDatabaseCleanupPlan filters prefix-scan results to task databases only', async () => {
  const manifest = ensureManifestDefaults({
    cleanup: {},
    status: {
      overlayReady: true
    },
    task: {
      projectDatabasePrefix: 'vibes_task_demo'
    },
    database: {
      customerAdminUrl: 'postgresql://user:pass@example.com:5432/postgres'
    },
    paths: {
      runDir: '/tmp/run'
    }
  });

  const plan = await resolveTaskDatabaseCleanupPlan(manifest, {
    listDatabasesByPrefix: async () => [
      'vibes_task_demo_abcd_development',
      'vibes_task_demo_abcd_development',
      'vibes_task_demo_abcd_staging',
      'vibes_task_demo',
      'other_task_abcd_development',
      'vibes_task_demo_abcd_production'
    ]
  });

  assert.deepEqual(plan.databases, [
    'vibes_task_demo_abcd_development',
    'vibes_task_demo_abcd_production'
  ]);
});

test('dropDatabases fails cleanup when a database cannot be dropped after both attempts', async () => {
  const calls = [];
  await assert.rejects(
    () =>
      dropDatabases(
        {
          cluster: {
            sharedPlatformNamespace: 'vibes-platform'
          }
        },
        'postgresql://user:pass@example.com:5432/postgres',
        ['good_db', 'bad_db', 'bad_db'],
        {
          runSql: async (_manifest, _adminUrl, sql) => {
            calls.push(sql);
            if (sql.includes('"bad_db"')) {
              throw new Error('drop failed');
            }
            return '';
          }
        }
      ),
    (error) => {
      assert.match(error.message, /Failed to drop task databases: bad_db/);
      assert.deepEqual(error.failedDatabases, ['bad_db']);
      return true;
    }
  );

  assert.equal(calls.filter((sql) => sql.includes('"bad_db"')).length, 2);
});

test('cleanupValidation records prefix-scan cleanup details even without validation artifacts', async () => {
  const manifest = ensureManifestDefaults({
    cleanup: {},
    status: {
      overlayReady: true
    },
    task: {
      projectDatabasePrefix: 'vibes_task_demo',
      schema: 'task_demo'
    },
    database: {
      customerAdminUrl: 'postgresql://user:pass@example.com:5432/postgres',
      baseDatabaseUrl: 'postgresql://user:pass@example.com:5432/postgres'
    },
    paths: {
      runDir: '/tmp/run',
      manifestPath: '/tmp/run/manifest.json'
    }
  });

  const saveSnapshots = [];
  const dropCalls = [];
  await cleanupValidation(manifest, {
    listDatabasesByPrefix: async () => [],
    dropTaskDatabases: async (_manifest, _adminUrl, databases) => {
      dropCalls.push([...databases]);
    },
    save: async (nextManifest) => {
      saveSnapshots.push(JSON.parse(JSON.stringify(nextManifest.cleanup.validation || null)));
    }
  });

  assert.deepEqual(dropCalls, [[]]);
  assert.equal(manifest.cleanup.validation.databaseSource, 'prefix_scan');
  assert.deepEqual(manifest.cleanup.validation.databases, []);
  assert.deepEqual(manifest.cleanup.validation.failedDatabases, []);
  assert.ok(manifest.cleanup.validation.completedAt);
  assert.ok(saveSnapshots.length >= 2);
});
