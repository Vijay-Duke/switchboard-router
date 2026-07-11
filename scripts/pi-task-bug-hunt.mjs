#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';

const repo = process.cwd();
const concurrency = Number(process.env.PI_TASK_CONCURRENCY || 16);
const retryArgs = ['--retries', '2', '--retry-on', '429,500,502,503,504', '--task-timeout', '420000', '--tools', 'read,bash', '--cwd', repo];

function runPi(args, input) {
  return new Promise((resolve) => {
    const child = spawn('pi-task', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, error: String(error), stdout, stderr }));
    child.on('close', (code, signal) => resolve({ ok: code === 0, code, signal, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input);
  });
}

async function mapConcurrent(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

async function smoke() {
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('pi-task', ['models', '--json'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `models exited ${code}`)));
  });
  const models = JSON.parse(raw);
  const results = await mapConcurrent(models, async ({ provider, id }) => {
    const model = `${provider}/${id}`;
    const result = await runPi(['run', '--print', '--model', model, '--retries', '0', '--task-timeout', '60000', '--tools', 'read', '-'], 'PONG');
    return { model, ok: result.ok && /\bPONG\b/i.test(result.stdout), code: result.code, output: result.stdout, error: result.error };
  });
  process.stdout.write(`${JSON.stringify(results.filter((result) => result.ok), null, 2)}\n`);
}

function huntPrompt(file) {
  return `You are hunting for one real runtime bug in ${file} in the Switchboard repository. Read the actual file and relevant callers/tests with the allowed tools. Focus on security, crashes, data loss, incorrect routing, malformed protocol handling, concurrency, and client-controlled input. Do not suggest style, hypothetical cleanup, missing validation that the surrounding code already provides, or behavior that is explicitly intentional. Remember: Array.join() renders undefined as "" rather than "undefined", and a shallow spread shares nested references; neither is a bug by itself. Return ONLY a strict JSON array. Each finding must contain exactly: {"file":"...","line":number,"offendingCode":"quoted exact code","scenario":"concrete input/state and observable failure","fix":"specific fix"}. The array must be [] if there is no real, reproducible bug. Do not include markdown fences or prose.`;
}

async function hunt() {
  const modelChain = process.env.PI_TASK_MODEL_CHAIN;
  if (!modelChain) throw new Error('PI_TASK_MODEL_CHAIN is required');
  const files = process.argv.slice(3);
  if (!files.length) throw new Error('usage: pi-task-bug-hunt.mjs hunt <file>...');
  const results = await mapConcurrent(files, async (file) => {
    const result = await runPi(['run', '--print', '--model', modelChain, ...retryArgs, '-'], huntPrompt(file));
    let findings = [];
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) findings = parsed;
    } catch {
      // Invalid model output is retained for audit, but never treated as a finding.
    }
    return { file, ok: result.ok, findings, raw: result.stdout, stderr: result.stderr };
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

const command = process.argv[2];
if (command === 'smoke') await smoke();
else if (command === 'hunt') await hunt();
else throw new Error('usage: pi-task-bug-hunt.mjs smoke|hunt <file>...');
