#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function aws(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFile('aws', args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

async function bucketExists(bucket, region) {
  const output = await aws(['s3api', 'head-bucket', '--bucket', bucket, '--region', region], { allowFailure: true });
  return output !== null;
}

async function tableExists(table, region) {
  const output = await aws(
    ['dynamodb', 'describe-table', '--table-name', table, '--region', region, '--output', 'json'],
    { allowFailure: true }
  );
  return output !== null;
}

async function listBucketObjects(bucket, region) {
  const versions = [];
  const deleteMarkers = [];
  let keyMarker = '';
  let versionIdMarker = '';

  for (;;) {
    const args = ['s3api', 'list-object-versions', '--bucket', bucket, '--region', region, '--output', 'json'];
    if (keyMarker) {
      args.push('--key-marker', keyMarker);
    }
    if (versionIdMarker) {
      args.push('--version-id-marker', versionIdMarker);
    }
    const raw = await aws(args);
    const payload = JSON.parse(raw || '{}');
    for (const item of payload.Versions || []) {
      versions.push({
        Key: item.Key,
        VersionId: item.VersionId
      });
    }
    for (const item of payload.DeleteMarkers || []) {
      deleteMarkers.push({
        Key: item.Key,
        VersionId: item.VersionId
      });
    }
    if (!payload.IsTruncated) break;
    keyMarker = payload.NextKeyMarker || '';
    versionIdMarker = payload.NextVersionIdMarker || '';
  }

  return { versions, deleteMarkers };
}

async function deleteBucketObjects(bucket, region) {
  for (;;) {
    const { versions, deleteMarkers } = await listBucketObjects(bucket, region);
    const objects = [...versions, ...deleteMarkers];
    if (objects.length === 0) break;

    for (let index = 0; index < objects.length; index += 1000) {
      const chunk = objects.slice(index, index + 1000);
      await aws([
        's3api',
        'delete-objects',
        '--bucket',
        bucket,
        '--region',
        region,
        '--delete',
        JSON.stringify({
          Objects: chunk,
          Quiet: true
        })
      ]);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const bucket = String(args.bucket || '').trim();
const table = String(args.table || '').trim();
const region = String(args.region || 'us-east-1').trim();
const apply = Boolean(args.apply);

if (!bucket || !table) {
  console.error('usage: delete-bootstrap-state.mjs --bucket BUCKET --table TABLE --region us-east-1 --plan|--apply');
  process.exit(1);
}

const bucketPresent = await bucketExists(bucket, region);
const tablePresent = await tableExists(table, region);

if (bucketPresent) {
  const { versions, deleteMarkers } = await listBucketObjects(bucket, region);
  console.log(`[replica] Bootstrap state bucket: ${bucket}`);
  console.log(`[replica]   object versions: ${versions.length}`);
  console.log(`[replica]   delete markers: ${deleteMarkers.length}`);
} else {
  console.log(`[replica] Bootstrap state bucket not found: ${bucket}`);
}

if (tablePresent) {
  console.log(`[replica] Bootstrap lock table: ${table}`);
} else {
  console.log(`[replica] Bootstrap lock table not found: ${table}`);
}

if (!apply) {
  process.exit(0);
}

if (bucketPresent) {
  await deleteBucketObjects(bucket, region);
  await aws(['s3api', 'delete-bucket', '--bucket', bucket, '--region', region]);
  console.log(`[replica] Deleted bootstrap state bucket ${bucket}`);
}

if (tablePresent) {
  await aws(['dynamodb', 'delete-table', '--table-name', table, '--region', region]);
  await aws(['dynamodb', 'wait', 'table-not-exists', '--table-name', table, '--region', region]);
  console.log(`[replica] Deleted bootstrap lock table ${table}`);
}
