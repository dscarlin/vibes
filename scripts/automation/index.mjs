#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTaskOverlay,
  cleanupManifest,
  deployPlatform,
  ensureKubeAccess,
  ensureManifestDefaults,
  normalizeExecutionMode
} from '../agent-task/index.mjs';
import {
  ensureDir,
  pathExists,
  readJson,
  removePath,
  runCommand,
  shortRandom
} from '../agent-task/lib.mjs';
import { runCodexJson, runCodexText } from './codex.mjs';
import { fetchGmailThread, listDriveAudioFiles, downloadDriveFile, sendGmailMessage } from './google.mjs';
import {
  addComment,
  createIssue,
  downloadAttachment,
  getIssue,
  getIssueComments,
  searchIssues,
  transitionIssue
} from './jira.mjs';
import {
  assertConfig,
  automationConfig,
  buildIssueBranchName,
  buildMeetingId,
  buildReconciledBranchName,
  buildRunBranchName,
  buildRunId,
  cloneWorkspace,
  createRemoteBranch,
  currentOriginUrl,
  ensureWorkspaceBranch,
  extractJsonPayload,
  findMeetingByDriveId,
  findMeetingManifests,
  gitSha,
  jiraDir,
  loadAutomationEnv,
  meetingDir,
  parseArgs,
  readJsonIfExists,
  readTextIfExists,
  renderReviewEmail,
  repoRoot,
  runDir,
  runLoggedCommand,
  writeManifest,
  writeText
} from './lib.mjs';
import { transcribeAudio } from './openai.mjs';

function usage() {
  console.error(
    [
      'Usage:',
      '  node scripts/automation/index.mjs meeting-plans',
      '  node scripts/automation/index.mjs jira-stories',
      '  node scripts/automation/index.mjs jira-plans',
      '  node scripts/automation/index.mjs jira-build [--keep-validation-env]',
      '',
      'Optional flags:',
      '  --meeting-id <id>',
      '  --issue-key <ISSUE-KEY>',
      '  --run-id <id>',
      '  --dry-run'
    ].join('\n')
  );
}

function atlassianDocToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((entry) => atlassianDocToText(entry)).join('');
  if (node.type === 'text') return String(node.text || '');
  if (!Array.isArray(node.content)) return '';
  const parts = node.content.map((entry) => atlassianDocToText(entry));
  if (node.type === 'paragraph') return `${parts.join('')}\n\n`;
  if (node.type === 'hardBreak') return '\n';
  return parts.join('');
}

function sanitizeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function issueArtifactPaths(config, issueKey) {
  const baseDir = jiraDir(config.aiWorkRoot, issueKey);
  return {
    baseDir,
    manifestPath: path.join(baseDir, 'manifest.json'),
    issuePackPath: path.join(baseDir, 'issue-pack.json'),
    planPath: path.join(baseDir, 'plan.md'),
    featureValidationPath: path.join(baseDir, 'feature-validation.txt'),
    buildReportPath: path.join(baseDir, 'build-report.md'),
    planningDir: path.join(baseDir, 'planning'),
    attachmentsDir: path.join(baseDir, 'attachments')
  };
}

function acceptedReportStatus(status) {
  return ['succeeded', 'published_with_validation_failures'].includes(String(status || ''));
}

function buildMeetingExtractionPrompt(meeting, transcriptText) {
  return [
    'You are extracting candidate product work items from a meeting transcript.',
    'Return JSON only with this shape:',
    '{"items":[{"title":"","type":"feature|bug","why_it_exists":"","user_business_value":"","tentative_implementation_summary":"","confidence":"high|medium|low","ambiguity_notes":""}]}',
    'Do not include anything outside JSON.',
    '',
    `Meeting ID: ${meeting.meetingId}`,
    `Source file: ${meeting.source?.name || ''}`,
    '',
    'Transcript:',
    transcriptText
  ].join('\n');
}

function buildStoryNormalizationPrompt(meeting, extractedItems, threadText) {
  return [
    'You are converting reviewed meeting candidates into final Jira-ready work items.',
    'Return JSON only with this shape:',
    '{"items":[{"title":"","type":"Feature|Bug","summary":"","description":"","acceptance_criteria":[""],"implementation_notes":[""]}]}',
    'Only include items the review thread clearly approves or materially scopes.',
    '',
    `Meeting ID: ${meeting.meetingId}`,
    '',
    'Original extracted items JSON:',
    JSON.stringify({ items: extractedItems }, null, 2),
    '',
    'Review thread text:',
    threadText
  ].join('\n');
}

function buildPlanGenerationPrompt(issuePack) {
  return [
    'You are planning implementation work inside the Vibes Platform repository.',
    'Read the repository before answering.',
    'Return JSON only with this shape:',
    '{"plan_markdown":"","feature_validation_command":""}',
    'The plan markdown must include:',
    '- intended behavior',
    '- regression-sensitive areas',
    '- notes on retained existing functionality',
    '- likely affected surfaces',
    'The validation command must be a single repo-local shell command.',
    '',
    'Issue pack:',
    JSON.stringify(issuePack, null, 2)
  ].join('\n');
}

function buildConflictResolutionPrompt(context) {
  return [
    'You are resolving a cherry-pick conflict while preserving intended functionality from both the run branch and the child issue branch.',
    'Do not run git commands. Edit files to resolve the conflict.',
    'Prefer the smallest coherent merge that retains behavior from both sides.',
    '',
    `Issue: ${context.issueKey}`,
    `Run branch: ${context.runBranch}`,
    `Child branch: ${context.childBranch}`,
    `Conflicted files: ${context.conflictedFiles.join(', ')}`,
    '',
    'Issue pack:',
    JSON.stringify(context.issuePack, null, 2),
    '',
    'Implementation plan:',
    context.planMarkdown,
    '',
    `Accepted run diff path: ${context.acceptedDiffPath}`,
    `Child diff path: ${context.childDiffPath}`
  ].join('\n');
}

function buildValidationRepairPrompt(context) {
  return [
    'You are repairing a reconciled issue branch after repo-local validation failed.',
    'Do not run git commands. Edit the code so validation passes while preserving functionality from the integrated run branch and the child issue change.',
    '',
    `Issue: ${context.issueKey}`,
    `Validation command: ${context.validationCommand}`,
    `Validation stdout: ${context.stdoutPath}`,
    `Validation stderr: ${context.stderrPath}`,
    '',
    'Issue pack:',
    JSON.stringify(context.issuePack, null, 2),
    '',
    'Implementation plan:',
    context.planMarkdown
  ].join('\n');
}

function buildPostDeployTestDesignPrompt(context) {
  return [
    'You are designing post-deploy cluster validation and demo scenarios for an integrated AI build run.',
    'Return JSON only with this shape:',
    '{"run_test_plan_markdown":"","test_data_plan":{"steps":[{"id":"","description":"","scriptable":true,"command":"","issue_keys":[""]}]},"per_issue_demo_scenarios":[{"issue_key":"","title":"","summary":"","setup_step_ids":[""],"expected_results":[""],"scriptable_checks":[{"id":"","description":"","scriptable":true,"command":""}],"manual_demo_steps":[""]}]}',
    'Use shell commands only for scriptable commands.',
    'If a step is not safely scriptable, omit the command and represent it in manual_demo_steps instead.',
    '',
    `Run branch: ${context.runBranch}`,
    `Base sha: ${context.baseSha}`,
    `App URL: ${context.appUrl}`,
    `API URL: ${context.apiUrl}`,
    `Root host: ${context.rootHost}`,
    '',
    `Integrated diff path: ${context.diffPath}`,
    `Live state path: ${context.liveStatePath}`,
    '',
    'Accepted issues:',
    JSON.stringify(context.acceptedIssues, null, 2)
  ].join('\n');
}

async function saveMeetingManifest(config, manifest) {
  const manifestPath = path.join(meetingDir(config.aiWorkRoot, manifest.meetingId), 'manifest.json');
  await writeManifest(manifestPath, manifest);
}

async function saveIssueManifest(config, issueKey, manifest) {
  await writeManifest(issueArtifactPaths(config, issueKey).manifestPath, manifest);
}

async function listMeetingsToProcess(config, meetingId = '') {
  if (meetingId) {
    const manifest = await readJson(path.join(meetingDir(config.aiWorkRoot, meetingId), 'manifest.json'));
    return [manifest];
  }
  return findMeetingManifests(config.aiWorkRoot);
}

async function commandMeetingPlans(args, config) {
  assertConfig(config, ['driveFolderId', 'openAiApiKey']);
  if (!config.reviewEmailTo.length) {
    throw new Error('AUTOMATION_REVIEW_EMAIL_TO must be configured for meeting-plans');
  }
  const driveFiles = await listDriveAudioFiles(config);
  for (const driveFile of driveFiles) {
    const existing = await findMeetingByDriveId(config.aiWorkRoot, driveFile.id);
    if (existing?.status?.reviewEmailSentAt) continue;
    const meetingId = existing?.meetingId || buildMeetingId(driveFile.name);
    const meetingBaseDir = meetingDir(config.aiWorkRoot, meetingId);
    const rawDir = path.join(meetingBaseDir, 'raw');
    await ensureDir(rawDir);
    const manifest = existing || {
      version: 1,
      meetingId,
      createdAt: new Date().toISOString(),
      source: {
        driveFileId: driveFile.id,
        name: driveFile.name,
        modifiedTime: driveFile.modifiedTime,
        fileExtension: driveFile.fileExtension
      },
      status: {}
    };
    manifest.generatedAt = new Date().toISOString();
    const rawPath = path.join(rawDir, driveFile.name);
    if (!(await pathExists(rawPath))) {
      const bytes = await downloadDriveFile(config, driveFile.id);
      await fs.writeFile(rawPath, bytes);
    }
    manifest.paths = {
      ...(manifest.paths || {}),
      rawPath,
      transcriptPath: path.join(meetingBaseDir, 'transcript.md'),
      extractedItemsPath: path.join(meetingBaseDir, 'extracted-items.json'),
      reviewEmailPath: path.join(meetingBaseDir, 'review-email.md')
    };
    if (!(await pathExists(manifest.paths.transcriptPath))) {
      const transcript = await transcribeAudio(config, rawPath);
      await writeText(manifest.paths.transcriptPath, sanitizeText(transcript));
      manifest.status.transcribedAt = new Date().toISOString();
    }
    const transcriptText = await fs.readFile(manifest.paths.transcriptPath, 'utf8');
    if (!(await pathExists(manifest.paths.extractedItemsPath))) {
      const extraction = await runCodexJson({
        cwd: repoRoot,
        prompt: buildMeetingExtractionPrompt(manifest, transcriptText),
        model: config.codexModel,
        outputDir: path.join(meetingBaseDir, 'codex'),
        label: 'meeting-extraction',
        authMode: config.codexAuthMode
      });
      await writeManifest(manifest.paths.extractedItemsPath, extraction);
      manifest.status.extractedAt = new Date().toISOString();
    }
    const extracted = await readJson(manifest.paths.extractedItemsPath);
    const emailBody = renderReviewEmail(manifest, ensureArray(extracted.items));
    await writeText(manifest.paths.reviewEmailPath, emailBody);
    if (!args.dryRun) {
      const message = await sendGmailMessage(config, {
        to: config.reviewEmailTo,
        cc: config.reviewEmailCc,
        subject: `[meeting-review] ${driveFile.name}`,
        bodyText: emailBody
      });
      manifest.reviewEmail = {
        threadId: message.threadId,
        id: message.id,
        to: config.reviewEmailTo,
        cc: config.reviewEmailCc
      };
      manifest.status.reviewEmailSentAt = new Date().toISOString();
    }
    await saveMeetingManifest(config, manifest);
  }
}

async function commandJiraStories(args, config) {
  assertConfig(config, ['jiraBaseUrl', 'jiraProjectKey', 'jiraEmail', 'jiraApiToken']);
  const meetings = await listMeetingsToProcess(config, args.meetingId);
  for (const meeting of meetings) {
    if (!meeting.reviewEmail?.threadId) continue;
    if (meeting.status?.jiraStoriesCreatedAt) continue;
    const thread = await fetchGmailThread(config, meeting.reviewEmail.threadId);
    const meetingBaseDir = meetingDir(config.aiWorkRoot, meeting.meetingId);
    const reviewThreadPath = path.join(meetingBaseDir, 'review-thread.json');
    await writeManifest(reviewThreadPath, thread);
    const extracted = await readJson(path.join(meetingBaseDir, 'extracted-items.json'));
    const normalized = await runCodexJson({
      cwd: repoRoot,
      prompt: buildStoryNormalizationPrompt(meeting, ensureArray(extracted.items), thread.normalizedText),
      model: config.codexModel,
      outputDir: path.join(meetingBaseDir, 'codex'),
      label: 'jira-story-normalization',
      authMode: config.codexAuthMode
    });
    const createdIssues = [];
    for (const item of ensureArray(normalized.items)) {
      const description = [
        item.description || '',
        '',
        'Acceptance criteria:',
        ...ensureArray(item.acceptance_criteria).map((criterion) => `- ${criterion}`),
        '',
        'Implementation notes:',
        ...ensureArray(item.implementation_notes).map((note) => `- ${note}`),
        '',
        `Origin meeting: ${meeting.meetingId}`
      ].join('\n');
      let issueRecord = {
        key: `DRYRUN-${shortRandom(4)}`,
        self: ''
      };
      if (!args.dryRun) {
        issueRecord = await createIssue(config, item.type || 'Feature', item.summary || item.title, description);
        await transitionIssue(config, issueRecord.key, config.statuses.aiDrafted).catch(() => null);
      }
      const artifactPaths = issueArtifactPaths(config, issueRecord.key);
      await ensureDir(artifactPaths.baseDir);
      const issuePack = {
        meetingId: meeting.meetingId,
        sourceThreadId: meeting.reviewEmail.threadId,
        issueKey: issueRecord.key,
        issueType: item.type || 'Feature',
        title: item.title || item.summary,
        summary: item.summary || item.title,
        description,
        acceptanceCriteria: ensureArray(item.acceptance_criteria),
        implementationNotes: ensureArray(item.implementation_notes)
      };
      await writeManifest(artifactPaths.issuePackPath, issuePack);
      await saveIssueManifest(config, issueRecord.key, {
        version: 1,
        issueKey: issueRecord.key,
        createdAt: new Date().toISOString(),
        sourceMeetingId: meeting.meetingId,
        status: {
          jiraCreatedAt: new Date().toISOString()
        }
      });
      createdIssues.push(issueRecord.key);
    }
    meeting.status.jiraStoriesCreatedAt = new Date().toISOString();
    meeting.createdIssues = createdIssues;
    await saveMeetingManifest(config, meeting);
  }
}

async function loadAttachmentText(config, issueKey, attachment, artifactPaths) {
  await ensureDir(artifactPaths.attachmentsDir);
  const targetPath = path.join(artifactPaths.attachmentsDir, attachment.filename);
  if (!(await pathExists(targetPath))) {
    const content = await downloadAttachment(config, attachment.content);
    await fs.writeFile(targetPath, content);
  }
  const textLike = /(?:text|json|markdown|xml)/i.test(String(attachment.mimeType || ''));
  return {
    fileName: attachment.filename,
    mimeType: attachment.mimeType,
    path: targetPath,
    text: textLike ? await fs.readFile(targetPath, 'utf8').catch(() => '') : ''
  };
}

async function hydrateIssuePackFromJira(config, issue) {
  const artifactPaths = issueArtifactPaths(config, issue.key);
  await ensureDir(artifactPaths.baseDir);
  const fullIssue = await getIssue(
    config,
    issue.key,
    ['summary', 'description', 'comment', 'attachment', 'issuetype', 'priority', 'status']
  );
  const comments = await getIssueComments(config, issue.key);
  const attachments = [];
  for (const attachment of ensureArray(fullIssue.fields?.attachment)) {
    attachments.push(await loadAttachmentText(config, issue.key, attachment, artifactPaths));
  }
  const pack = {
    issueKey: issue.key,
    summary: fullIssue.fields?.summary || '',
    issueType: fullIssue.fields?.issuetype?.name || '',
    priority: fullIssue.fields?.priority?.name || '',
    status: fullIssue.fields?.status?.name || '',
    description: sanitizeText(atlassianDocToText(fullIssue.fields?.description)),
    comments: comments.map((comment) => sanitizeText(atlassianDocToText(comment.body))),
    attachments
  };
  await writeManifest(artifactPaths.issuePackPath, pack);
  return { pack, artifactPaths };
}

async function commandJiraPlans(args, config) {
  assertConfig(config, ['jiraBaseUrl', 'jiraProjectKey', 'jiraEmail', 'jiraApiToken']);
  const jql = args.issueKey
    ? `project = ${config.jiraProjectKey} AND key = ${args.issueKey}`
    : `project = ${config.jiraProjectKey} AND status = "${config.statuses.readyForPlan}"`;
  const issues = await searchIssues(config, jql, ['summary', 'status']);
  for (const issue of issues) {
    const { pack, artifactPaths } = await hydrateIssuePackFromJira(config, issue);
    const planningWorkspace = path.join(artifactPaths.planningDir, 'workspace');
    if (!(await pathExists(planningWorkspace))) {
      await cloneWorkspace({
        cloneDir: planningWorkspace,
        branch: config.baseBranch,
        originUrl: await currentOriginUrl(repoRoot)
      });
    } else {
      await ensureWorkspaceBranch(planningWorkspace, config.baseBranch);
    }
    const planPayload = await runCodexJson({
      cwd: planningWorkspace,
      prompt: buildPlanGenerationPrompt(pack),
      model: config.codexModel,
      outputDir: artifactPaths.planningDir,
      label: 'plan-generation',
      authMode: config.codexAuthMode
    });
    await writeText(artifactPaths.planPath, String(planPayload.plan_markdown || '').trim());
    await writeText(artifactPaths.featureValidationPath, String(planPayload.feature_validation_command || '').trim());
    await saveIssueManifest(config, issue.key, {
      version: 1,
      issueKey: issue.key,
      plannedAt: new Date().toISOString(),
      status: {
        planGeneratedAt: new Date().toISOString()
      }
    });
    if (!args.dryRun) {
      await addComment(
        config,
        issue.key,
        [
          'AI plan generated.',
          `Local plan: ${artifactPaths.planPath}`,
          `Feature validation: ${artifactPaths.featureValidationPath}`
        ].join('\n')
      );
      await transitionIssue(config, issue.key, config.statuses.aiPlanGenerated).catch(() => null);
    }
  }
}

async function runChildBuild(config, runManifest, issue, dryRun = false) {
  const artifactPaths = issueArtifactPaths(config, issue.key);
  const buildDir = path.join(artifactPaths.baseDir, 'build');
  await ensureDir(buildDir);
  const childRunId = `${runManifest.runId}-${issue.key.toLowerCase()}-${shortRandom(4)}`;
  const childBranch = buildIssueBranchName(issue.key, issue.fields?.summary || issue.key);
  const reportPath = path.join(repoRoot, 'validation', 'evidence', 'agent-cli', childRunId, 'final-report.json');
  const commandArgs = [
    './scripts/agent-task/index.mjs',
    'run',
    '--execution-mode',
    normalizeExecutionMode('repo-only'),
    '--base',
    runManifest.runBranch,
    '--branch',
    childBranch,
    '--prompt-file',
    artifactPaths.planPath,
    '--feature-validation-file',
    artifactPaths.featureValidationPath,
    '--issue-key',
    issue.key,
    '--parent-run-id',
    runManifest.runId,
    '--run-id',
    childRunId,
    '--notify-on',
    'never'
  ];
  let commandError = null;
  if (!dryRun) {
    try {
      await runLoggedCommand({
        cmd: 'node',
        args: commandArgs,
        cwd: repoRoot,
        env: process.env,
        stdoutPath: path.join(buildDir, 'child-build.stdout.log'),
        stderrPath: path.join(buildDir, 'child-build.stderr.log'),
        timeoutMs: 3 * 60 * 60 * 1000
      });
    } catch (error) {
      commandError = error;
    }
  }
  const report = await readJsonIfExists(reportPath, {
    status: dryRun ? 'succeeded' : 'failed',
    lastError: commandError ? { message: commandError.message } : null,
    publish: {
      remoteVerifiedAt: dryRun ? new Date().toISOString() : null
    }
  });
  const buildReportMarkdown = [
    `# ${issue.key} build`,
    '',
    `Run ID: ${childRunId}`,
    `Branch: ${childBranch}`,
    `Status: ${report.status || 'unknown'}`,
    `Report: ${reportPath}`
  ].join('\n');
  await writeText(artifactPaths.buildReportPath, buildReportMarkdown);
  return {
    issueKey: issue.key,
    childRunId,
    childBranch,
    reportPath,
    report,
    commandError: commandError ? commandError.message : '',
    artifactPaths,
    acceptedForReconciliation: acceptedReportStatus(report.status)
  };
}

async function gitDiffToFile(cwd, refSpec, outputPath) {
  const { stdout } = await runCommand('git', ['diff', refSpec], { cwd });
  await writeText(outputPath, stdout);
}

async function runValidationCommands(cloneDir, commands, outputDir) {
  await ensureDir(outputDir);
  const results = [];
  for (const [index, command] of commands.entries()) {
    const label = `validation-${index + 1}`;
    const stdoutPath = path.join(outputDir, `${label}.stdout.log`);
    const stderrPath = path.join(outputDir, `${label}.stderr.log`);
    try {
      await runLoggedCommand({
        cmd: 'sh',
        args: ['-lc', command],
        cwd: cloneDir,
        env: process.env,
        stdoutPath,
        stderrPath,
        timeoutMs: 30 * 60 * 1000
      });
      results.push({ command, ok: true, stdoutPath, stderrPath });
    } catch (error) {
      results.push({ command, ok: false, stdoutPath, stderrPath, error: error.message });
      return results;
    }
  }
  return results;
}

async function reconcileIssue(config, runManifest, integrationWorkspace, buildResult, acceptedBuilds) {
  const issuePack = await readJson(buildResult.artifactPaths.issuePackPath);
  const planMarkdown = await fs.readFile(buildResult.artifactPaths.planPath, 'utf8');
  const validationCommand = sanitizeText(await readTextIfExists(buildResult.artifactPaths.featureValidationPath));
  const reconciliationDir = path.join(runDir(config.aiWorkRoot, runManifest.runId), 'integration', buildResult.issueKey);
  await ensureDir(reconciliationDir);
  await ensureWorkspaceBranch(integrationWorkspace, runManifest.runBranch);
  const reconciledBranch = buildReconciledBranchName(buildResult.issueKey, runManifest.runId);
  await runCommand('git', ['checkout', '-B', reconciledBranch, `origin/${runManifest.runBranch}`], { cwd: integrationWorkspace });
  const { stdout: commitListText } = await runCommand(
    'git',
    ['rev-list', '--reverse', `${runManifest.initialBaseSha}..origin/${buildResult.childBranch}`],
    { cwd: integrationWorkspace }
  );
  const commits = commitListText.split('\n').map((entry) => entry.trim()).filter(Boolean);
  const acceptedDiffPath = path.join(reconciliationDir, 'accepted.diff');
  const childDiffPath = path.join(reconciliationDir, 'child.diff');
  await gitDiffToFile(integrationWorkspace, `${runManifest.initialBaseSha}..origin/${runManifest.runBranch}`, acceptedDiffPath);
  await gitDiffToFile(integrationWorkspace, `${runManifest.initialBaseSha}..origin/${buildResult.childBranch}`, childDiffPath);
  const applyCommit = async (commitSha, attempt) => {
    try {
      await runCommand('git', ['cherry-pick', commitSha], { cwd: integrationWorkspace });
      return;
    } catch {
      const { stdout: conflicted } = await runCommand('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: integrationWorkspace
      });
      const conflictedFiles = conflicted.split('\n').map((entry) => entry.trim()).filter(Boolean);
      await runCodexText({
        cwd: integrationWorkspace,
        prompt: buildConflictResolutionPrompt({
          issueKey: buildResult.issueKey,
          runBranch: runManifest.runBranch,
          childBranch: buildResult.childBranch,
          conflictedFiles,
          issuePack,
          planMarkdown,
          acceptedDiffPath,
          childDiffPath
        }),
        model: config.codexModel,
        outputDir: reconciliationDir,
        label: `conflict-repair-${attempt}`,
        authMode: config.codexAuthMode
      });
      const { stdout: unresolved } = await runCommand('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: integrationWorkspace
      });
      if (unresolved.trim()) {
        throw new Error(`Unresolved conflicts remain for ${buildResult.issueKey}: ${unresolved.trim()}`);
      }
      await runCommand('git', ['add', '-A'], { cwd: integrationWorkspace });
      await runCommand('git', ['cherry-pick', '--continue'], { cwd: integrationWorkspace });
    }
  };
  try {
    for (const [index, commitSha] of commits.entries()) {
      await applyCommit(commitSha, index + 1);
    }
    const validationCommands = Array.from(
      new Set(
        acceptedBuilds
          .concat([buildResult])
          .map((entry) => sanitizeText(entry.validationCommand || validationCommand))
          .filter(Boolean)
      )
    );
    const firstPass = await runValidationCommands(integrationWorkspace, validationCommands, path.join(reconciliationDir, 'validation-first'));
    const firstFailure = firstPass.find((entry) => !entry.ok);
    if (firstFailure) {
      await runCodexText({
        cwd: integrationWorkspace,
        prompt: buildValidationRepairPrompt({
          issueKey: buildResult.issueKey,
          validationCommand: firstFailure.command,
          stdoutPath: firstFailure.stdoutPath,
          stderrPath: firstFailure.stderrPath,
          issuePack,
          planMarkdown
        }),
        model: config.codexModel,
        outputDir: reconciliationDir,
        label: 'validation-repair',
        authMode: config.codexAuthMode
      });
      const { stdout: changed } = await runCommand('git', ['status', '--porcelain'], { cwd: integrationWorkspace });
      if (changed.trim()) {
        await runCommand('git', ['add', '-A'], { cwd: integrationWorkspace });
        await runCommand('git', ['commit', '-m', `fix: reconcile ${buildResult.issueKey}`], { cwd: integrationWorkspace });
      }
      const secondPass = await runValidationCommands(integrationWorkspace, validationCommands, path.join(reconciliationDir, 'validation-second'));
      if (secondPass.some((entry) => !entry.ok)) {
        throw new Error(`Validation still failing for ${buildResult.issueKey}`);
      }
    }
    await runCommand('git', ['push', 'origin', `HEAD:refs/heads/${reconciledBranch}`], { cwd: integrationWorkspace });
    await runCommand('git', ['push', 'origin', `HEAD:refs/heads/${runManifest.runBranch}`], { cwd: integrationWorkspace });
    return {
      ok: true,
      issueKey: buildResult.issueKey,
      childBranch: buildResult.childBranch,
      reconciledBranch,
      childRunId: buildResult.childRunId,
      validationCommand
    };
  } catch (error) {
    await runCommand('git', ['cherry-pick', '--abort'], { cwd: integrationWorkspace }).catch(() => null);
    await ensureWorkspaceBranch(integrationWorkspace, runManifest.runBranch).catch(() => null);
    return {
      ok: false,
      issueKey: buildResult.issueKey,
      childBranch: buildResult.childBranch,
      error: error.message,
      childRunId: buildResult.childRunId,
      validationCommand
    };
  }
}

function buildValidationManifest(runManifest, validationCloneDir, validationDir, originUrl) {
  const manifest = ensureManifestDefaults({
    version: 3,
    runId: `${runManifest.runId}-validation`,
    createdAt: new Date().toISOString(),
    request: {
      prompt: '',
      executionMode: 'full',
      keepClone: false,
      skipCleanup: false,
      skipPush: true
    },
    repo: {
      sourceRoot: repoRoot,
      originUrl,
      baseBranch: runManifest.baseBranch,
      featureBranch: runManifest.runBranch,
      cloneDir: validationCloneDir
    },
    paths: {
      runDir: validationDir,
      manifestPath: path.join(validationDir, 'agent-task-manifest.json'),
      reportPath: path.join(validationDir, 'agent-task-report.json'),
      generatedDir: path.join(validationDir, 'generated', 'replica'),
      metadataSnapshotPath: path.join(validationDir, 'metadata.snapshot.json')
    },
    task: {
      slug: `run-${runManifest.runId}`.slice(0, 28)
    },
    resources: {
      platformImages: []
    },
    cleanup: {},
    status: {},
    stages: {}
  });
  return manifest;
}

async function deployRunValidation(config, runManifest) {
  const validationDir = path.join(runDir(config.aiWorkRoot, runManifest.runId), 'validation');
  const validationCloneDir = path.join(validationDir, 'clone');
  const originUrl = await currentOriginUrl(repoRoot);
  await ensureDir(validationDir);
  if (!(await pathExists(validationCloneDir))) {
    await cloneWorkspace({
      cloneDir: validationCloneDir,
      branch: runManifest.runBranch,
      originUrl
    });
  } else {
    await ensureWorkspaceBranch(validationCloneDir, runManifest.runBranch);
  }
  const manifest = buildValidationManifest(runManifest, validationCloneDir, validationDir, originUrl);
  await writeManifest(manifest.paths.manifestPath, manifest);
  await ensureKubeAccess();
  await buildTaskOverlay(manifest);
  await deployPlatform(manifest, 'run-validation');
  return manifest;
}

async function fetchLiveState(validationManifest, validationDir) {
  const apiUrl = `https://${validationManifest.task.hosts.api}`;
  const appUrl = `https://${validationManifest.task.hosts.app}`;
  const liveState = {
    fetchedAt: new Date().toISOString(),
    apiUrl,
    appUrl,
    health: '',
    appHtmlPreview: ''
  };
  try {
    liveState.health = await (await fetch(`${apiUrl}/health`)).text();
  } catch (error) {
    liveState.health = `ERROR: ${error.message}`;
  }
  try {
    const html = await (await fetch(appUrl)).text();
    liveState.appHtmlPreview = html.slice(0, 5000);
  } catch (error) {
    liveState.appHtmlPreview = `ERROR: ${error.message}`;
  }
  const liveStatePath = path.join(validationDir, 'live-state.json');
  await writeManifest(liveStatePath, liveState);
  return liveStatePath;
}

async function executeShellStep(step, cwd, env, outputDir) {
  const safeId = String(step.id || `step-${shortRandom(4)}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const stdoutPath = path.join(outputDir, `${safeId}.stdout.log`);
  const stderrPath = path.join(outputDir, `${safeId}.stderr.log`);
  try {
    await runLoggedCommand({
      cmd: 'sh',
      args: ['-lc', step.command],
      cwd,
      env,
      stdoutPath,
      stderrPath,
      timeoutMs: 20 * 60 * 1000
    });
    return { id: step.id, ok: true, stdoutPath, stderrPath, command: step.command };
  } catch (error) {
    return { id: step.id, ok: false, stdoutPath, stderrPath, command: step.command, error: error.message };
  }
}

async function designAndExecutePostDeploy(config, runManifest, validationManifest, acceptedIssues) {
  const validationDir = path.join(runDir(config.aiWorkRoot, runManifest.runId), 'validation');
  const diffPath = path.join(validationDir, 'integrated.diff');
  await gitDiffToFile(validationManifest.repo.cloneDir, `${runManifest.initialBaseSha}..HEAD`, diffPath);
  const liveStatePath = await fetchLiveState(validationManifest, validationDir);
  const acceptedIssuePayload = await Promise.all(
    acceptedIssues.map(async (issueResult) => ({
      issueKey: issueResult.issueKey,
      issuePack: await readJson(issueArtifactPaths(config, issueResult.issueKey).issuePackPath),
      planMarkdown: await fs.readFile(issueArtifactPaths(config, issueResult.issueKey).planPath, 'utf8'),
      buildReportPath: issueArtifactPaths(config, issueResult.issueKey).buildReportPath,
      childRunId: issueResult.childRunId,
      childBranch: issueResult.childBranch,
      reconciledBranch: issueResult.reconciledBranch || '',
      validationCommand: issueResult.validationCommand || ''
    }))
  );
  const payload = await runCodexJson({
    cwd: validationManifest.repo.cloneDir,
    prompt: buildPostDeployTestDesignPrompt({
      runBranch: runManifest.runBranch,
      baseSha: runManifest.initialBaseSha,
      appUrl: `https://${validationManifest.task.hosts.app}`,
      apiUrl: `https://${validationManifest.task.hosts.api}`,
      rootHost: validationManifest.task.hosts.root,
      diffPath,
      liveStatePath,
      acceptedIssues: acceptedIssuePayload
    }),
    model: config.codexModel,
    outputDir: validationDir,
    label: 'post-deploy-test-design',
    authMode: config.codexAuthMode
  });
  await writeText(path.join(runDir(config.aiWorkRoot, runManifest.runId), 'post-deploy-test-plan.md'), payload.run_test_plan_markdown || '');
  await writeManifest(path.join(runDir(config.aiWorkRoot, runManifest.runId), 'test-data-plan.json'), payload.test_data_plan || { steps: [] });
  await writeManifest(
    path.join(runDir(config.aiWorkRoot, runManifest.runId), 'per-issue-demo-scenarios.json'),
    payload.per_issue_demo_scenarios || []
  );
  const shellEnv = {
    ...process.env,
    RUN_APP_URL: `https://${validationManifest.task.hosts.app}`,
    RUN_API_URL: `https://${validationManifest.task.hosts.api}`,
    RUN_ROOT_HOST: validationManifest.task.hosts.root,
    RUN_BRANCH: runManifest.runBranch
  };
  const setupOutputDir = path.join(validationDir, 'test-data');
  await ensureDir(setupOutputDir);
  const setupResults = [];
  for (const step of ensureArray(payload.test_data_plan?.steps)) {
    if (!step.scriptable || !step.command) {
      setupResults.push({ id: step.id, ok: true, manual: true, issueKeys: ensureArray(step.issue_keys) });
      continue;
    }
    setupResults.push({
      ...(await executeShellStep(step, validationManifest.repo.cloneDir, shellEnv, setupOutputDir)),
      issueKeys: ensureArray(step.issue_keys)
    });
  }
  const scenarioResults = [];
  const scenarioOutputDir = path.join(validationDir, 'scenario-checks');
  await ensureDir(scenarioOutputDir);
  for (const scenario of ensureArray(payload.per_issue_demo_scenarios)) {
    const checks = [];
    for (const check of ensureArray(scenario.scriptable_checks)) {
      if (!check.scriptable || !check.command) {
        checks.push({ id: check.id, ok: true, manual: true });
        continue;
      }
      checks.push(await executeShellStep(check, validationManifest.repo.cloneDir, shellEnv, scenarioOutputDir));
    }
    scenarioResults.push({
      issueKey: scenario.issue_key,
      title: scenario.title,
      setupStepIds: ensureArray(scenario.setup_step_ids),
      checks,
      manualDemoSteps: ensureArray(scenario.manual_demo_steps),
      expectedResults: ensureArray(scenario.expected_results)
    });
  }
  const result = {
    generatedAt: new Date().toISOString(),
    setupResults,
    scenarioResults
  };
  await writeManifest(path.join(runDir(config.aiWorkRoot, runManifest.runId), 'integration-validation.json'), result);
  return result;
}

function classifyIssueOutcome(issueKey, scenarioResults, setupResults) {
  const relevantScenario = scenarioResults.find((entry) => entry.issueKey === issueKey);
  if (!relevantScenario) {
    return { status: 'AI Review Ready', reason: 'No issue-specific scenario failed' };
  }
  const failedSetupIds = new Set(
    setupResults.filter((entry) => entry.ok === false).map((entry) => entry.id)
  );
  if (relevantScenario.setupStepIds.some((stepId) => failedSetupIds.has(stepId))) {
    return { status: 'AI Build Failed', reason: 'Required scripted test data setup failed' };
  }
  if (relevantScenario.checks.some((entry) => entry.ok === false)) {
    return { status: 'AI Build Failed', reason: 'A scripted post-deploy scenario check failed' };
  }
  return { status: 'AI Review Ready', reason: 'Post-deploy scenario checks passed or were manual only' };
}

async function postIssueComment(config, issueKey, commentBody, desiredStatus) {
  await addComment(config, issueKey, commentBody).catch(() => null);
  await transitionIssue(
    config,
    issueKey,
    desiredStatus === 'AI Review Ready' ? config.statuses.aiReviewReady : config.statuses.aiBuildFailed
  ).catch(() => null);
}

async function commandJiraBuild(args, config) {
  assertConfig(config, ['jiraBaseUrl', 'jiraProjectKey', 'jiraEmail', 'jiraApiToken']);
  const jql = args.issueKey
    ? `project = ${config.jiraProjectKey} AND key = ${args.issueKey}`
    : `project = ${config.jiraProjectKey} AND status = "${config.statuses.readyForBuild}"`;
  const issues = await searchIssues(config, jql, ['summary', 'status']);
  if (!issues.length) return;
  const runId = args.runId || buildRunId('ai');
  const runBranch = buildRunBranchName(new Date(), args.issueKey || runId);
  const artifactDir = runDir(config.aiWorkRoot, runId);
  await ensureDir(artifactDir);
  const originUrl = await currentOriginUrl(repoRoot);
  const baseSha = await gitSha(repoRoot, `origin/${config.baseBranch}`);
  if (!args.dryRun) {
    await createRemoteBranch({
      repoPath: repoRoot,
      localRef: baseSha,
      remoteBranch: runBranch
    });
  }
  const runManifest = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    baseBranch: config.baseBranch,
    initialBaseSha: baseSha,
    runBranch,
    issues: issues.map((issue) => issue.key),
    branchMap: {},
    acceptedIssues: [],
    failedIssues: [],
    deploymentError: ''
  };
  await writeManifest(path.join(artifactDir, 'manifest.json'), runManifest);
  const childResults = [];
  for (const issue of issues) {
    const artifactPaths = issueArtifactPaths(config, issue.key);
    if (!(await pathExists(artifactPaths.planPath))) {
      throw new Error(`Missing plan for ${issue.key}: ${artifactPaths.planPath}`);
    }
    if (!args.dryRun) {
      await transitionIssue(config, issue.key, config.statuses.aiBuilding).catch(() => null);
    }
    const buildResult = await runChildBuild(config, runManifest, issue, Boolean(args.dryRun));
    buildResult.validationCommand = sanitizeText(await readTextIfExists(artifactPaths.featureValidationPath));
    childResults.push(buildResult);
    runManifest.branchMap[issue.key] = {
      childBranch: buildResult.childBranch,
      childRunId: buildResult.childRunId,
      reportStatus: buildResult.report.status
    };
    if (!buildResult.acceptedForReconciliation) {
      runManifest.failedIssues.push(issue.key);
    }
    await writeManifest(path.join(artifactDir, 'manifest.json'), runManifest);
  }
  const integrationWorkspace = path.join(artifactDir, 'integration', 'workspace');
  if (!(await pathExists(integrationWorkspace))) {
    await cloneWorkspace({
      cloneDir: integrationWorkspace,
      branch: runBranch,
      originUrl
    });
  } else {
    await ensureWorkspaceBranch(integrationWorkspace, runBranch);
  }
  const acceptedReconciled = [];
  for (const buildResult of childResults.filter((entry) => entry.acceptedForReconciliation)) {
    const reconciliation = await reconcileIssue(config, runManifest, integrationWorkspace, buildResult, acceptedReconciled);
    runManifest.branchMap[buildResult.issueKey] = {
      ...runManifest.branchMap[buildResult.issueKey],
      reconciledBranch: reconciliation.reconciledBranch || '',
      reconciliationStatus: reconciliation.ok ? 'accepted' : 'failed',
      reconciliationError: reconciliation.error || ''
    };
    if (reconciliation.ok) {
      acceptedReconciled.push(reconciliation);
      runManifest.acceptedIssues.push(buildResult.issueKey);
    } else if (!runManifest.failedIssues.includes(buildResult.issueKey)) {
      runManifest.failedIssues.push(buildResult.issueKey);
    }
    await writeManifest(path.join(artifactDir, 'manifest.json'), runManifest);
  }
  await writeManifest(path.join(artifactDir, 'branch-map.json'), runManifest.branchMap);
  let validationManifest = null;
  let integrationValidation = { setupResults: [], scenarioResults: [] };
  let deploymentError = '';
  if (acceptedReconciled.length) {
    try {
      validationManifest = await deployRunValidation(
        {
          ...config,
          keepValidationEnv: Boolean(args.keepValidationEnv || config.keepValidationEnv)
        },
        runManifest
      );
      integrationValidation = await designAndExecutePostDeploy(config, runManifest, validationManifest, acceptedReconciled);
      if (config.clusterValidationCommand) {
        await runValidationCommands(
          validationManifest.repo.cloneDir,
          [config.clusterValidationCommand],
          path.join(artifactDir, 'validation', 'global-cluster-command')
        );
      }
    } catch (error) {
      deploymentError = error.message;
      runManifest.deploymentError = deploymentError;
      await writeManifest(path.join(artifactDir, 'manifest.json'), runManifest);
    }
  }
  await writeText(
    path.join(artifactDir, 'integration-report.md'),
    [
      `# Run ${runId}`,
      '',
      `Run branch: ${runBranch}`,
      `Accepted issues: ${runManifest.acceptedIssues.join(', ') || 'none'}`,
      `Failed issues: ${runManifest.failedIssues.join(', ') || 'none'}`,
      deploymentError ? `Deployment/Test Design Error: ${deploymentError}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  );
  for (const issue of issues) {
    const buildResult = childResults.find((entry) => entry.issueKey === issue.key);
    const branchInfo = runManifest.branchMap[issue.key] || {};
    let desiredStatus = 'AI Build Failed';
    let reason = 'Child build failed or was not reconciled';
    if (runManifest.acceptedIssues.includes(issue.key)) {
      const outcome = deploymentError
        ? { status: 'AI Build Failed', reason: deploymentError }
        : classifyIssueOutcome(issue.key, integrationValidation.scenarioResults, integrationValidation.setupResults);
      desiredStatus = outcome.status;
      reason = outcome.reason;
    }
    const scenario = integrationValidation.scenarioResults.find((entry) => entry.issueKey === issue.key);
    const commentBody = [
      `Issue: ${issue.key}`,
      `Child run ID: ${branchInfo.childRunId || buildResult?.childRunId || ''}`,
      `Child branch: ${branchInfo.childBranch || buildResult?.childBranch || ''}`,
      `Reconciled branch: ${branchInfo.reconciledBranch || 'n/a'}`,
      `Run branch: ${runBranch}`,
      `Outcome: ${desiredStatus}`,
      `Reason: ${reason}`,
      '',
      `Build report: ${issueArtifactPaths(config, issue.key).buildReportPath}`,
      `Issue pack: ${issueArtifactPaths(config, issue.key).issuePackPath}`,
      `Plan: ${issueArtifactPaths(config, issue.key).planPath}`,
      '',
      'Manual demo steps:',
      ...ensureArray(scenario?.manualDemoSteps).map((step) => `- ${step}`)
    ].join('\n');
    if (!args.dryRun) {
      await postIssueComment(config, issue.key, commentBody, desiredStatus);
    }
  }
  if (validationManifest && !(args.keepValidationEnv || config.keepValidationEnv)) {
    await cleanupManifest(validationManifest, { keepClone: false }).catch(() => null);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || '';
  const env = await loadAutomationEnv();
  const config = automationConfig(env);
  if (command === 'meeting-plans') {
    await commandMeetingPlans(args, config);
    return;
  }
  if (command === 'jira-stories') {
    await commandJiraStories(args, config);
    return;
  }
  if (command === 'jira-plans') {
    await commandJiraPlans(args, config);
    return;
  }
  if (command === 'jira-build' || command === 'jira-code') {
    await commandJiraBuild(args, config);
    return;
  }
  usage();
  process.exitCode = 1;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export {
  acceptedReportStatus,
  atlassianDocToText,
  buildConflictResolutionPrompt,
  buildIssueBranchName,
  buildMeetingExtractionPrompt,
  buildPlanGenerationPrompt,
  buildPostDeployTestDesignPrompt,
  buildReconciledBranchName,
  buildRunBranchName,
  buildStoryNormalizationPrompt,
  classifyIssueOutcome,
  parseArgs
};

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
