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

async function aws(args) {
  const { stdout } = await execFile('aws', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

const args = parseArgs(process.argv.slice(2));
const zoneId = String(args['zone-id'] || '').trim();
const suffixInput = String(args.suffix || '').trim().replace(/\.$/, '');
const apply = Boolean(args.apply);

if (!zoneId || !suffixInput) {
  console.error('usage: delete-dns-records.mjs --zone-id Z123 --suffix replica.vibesplatform.ai --plan|--apply');
  process.exit(1);
}

const suffix = `${suffixInput.toLowerCase()}.`;
const raw = await aws([
  'route53',
  'list-resource-record-sets',
  '--hosted-zone-id',
  zoneId,
  '--output',
  'json'
]);
const payload = JSON.parse(raw || '{}');
const records = Array.isArray(payload.ResourceRecordSets) ? payload.ResourceRecordSets : [];
const targets = records.filter((record) => {
  const name = String(record.Name || '').toLowerCase();
  const type = String(record.Type || '').toUpperCase();
  return name.endsWith(suffix) && type !== 'NS' && type !== 'SOA';
});

if (targets.length === 0) {
  console.log('[replica] No replica Route53 records matched the destroy suffix.');
  process.exit(0);
}

for (const record of targets) {
  console.log(`[replica] DNS ${record.Type} ${record.Name}`);
}

if (!apply) {
  process.exit(0);
}

const changeBatch = {
  Comment: `Delete replica DNS records for ${suffixInput}`,
  Changes: targets.map((record) => ({
    Action: 'DELETE',
    ResourceRecordSet: record
  }))
};

await aws([
  'route53',
  'change-resource-record-sets',
  '--hosted-zone-id',
  zoneId,
  '--change-batch',
  JSON.stringify(changeBatch)
]);

console.log(`[replica] Deleted ${targets.length} Route53 record(s) under ${suffixInput}.`);
