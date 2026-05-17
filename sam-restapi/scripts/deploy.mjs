#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const bucket = process.env.SAM_S3_BUCKET;
const profile = process.env.AWS_PROFILE;

const missing = [];
if (!bucket) missing.push('SAM_S3_BUCKET');
if (!profile) missing.push('AWS_PROFILE');
if (missing.length) {
  console.error(`[deploy] missing env var(s): ${missing.join(', ')}`);
  console.error('[deploy] set them in `.env` (see `.env.example`) or export them in your shell.');
  process.exit(1);
}

const args = [
  'deploy',
  '--s3-bucket', bucket,
  '--profile', profile,
  ...process.argv.slice(2),
];

const result = spawnSync('sam', args, { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
