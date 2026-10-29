#!/usr/bin/env node
/**
 * One-off generator for the `legacy-session` fixture.
 *
 * Source: a real pre-snapshot session captured from ~/.wayang/sessions.
 * The raw capture contains a live API key and machine-specific absolute paths,
 * so it cannot be committed as-is. This script rewrites those fields and drops
 * the bulky, migration-irrelevant parts (the `prev` half of every legacy
 * `set` event, which the migration code never reads).
 *
 * Run from the repo root:
 *   node src/services/signal/__tests__/fixtures/generate-legacy-session.mjs <source-session-dir>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = dirname(fileURLToPath(import.meta.url)) + '/legacy-session';
const srcDir = process.argv[2];
if (!srcDir) {
  console.error('usage: node generate-legacy-session.mjs <source-session-dir>');
  process.exit(1);
}

/** Replace anything that ties the fixture to a real machine or credential. */
function scrub(value) {
  if (typeof value === 'string') {
    return value
      .replace(/9rBf9lxBpCcevj0cx8mQgjHM@5203/g, 'REDACTED-API-KEY')
      .replace(/\/data\/home\/lukegypeng/g, '/home/user')
      .replace(/https?:\/\/v2\.open\.venus\.oa\.com\/[^\s"\\]*/g, 'http://localhost:1234/v1');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === 'apiKey' ? 'REDACTED-API-KEY' : scrub(v);
    }
    return out;
  }
  return value;
}

function readJsonl(name) {
  return readFileSync(join(srcDir, name), 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

function writeJsonl(name, rows) {
  writeFileSync(join(outDir, name), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// signals.jsonl: plain signal bodies, legacy layout. Keep verbatim (scrubbed).
const signals = readJsonl('signals.jsonl').map(scrub);
writeJsonl('signals.jsonl', signals);

// state-events.jsonl: keep only what migration reads — type, path, timestamp,
// and `data`. `prev` is never consulted, and it doubles the file size.
const events = readJsonl('state-events.jsonl').map((event) => {
  const row = {
    type: event.type,
    path: event.path,
    timestamp: event.timestamp,
    data: scrub(event.data ?? null),
  };
  if (event.signalId) row.signalId = event.signalId;
  return row;
});
writeJsonl('state-events.jsonl', events);

// meta.json: keeps the session identity but not the real workspace path.
const meta = scrub(JSON.parse(readFileSync(join(srcDir, 'meta.json'), 'utf-8')));
meta.sessionId = 'legacy-session-fixture';
writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

// conversation.jsonl: only needed to prove history is independent of the
// signal window. Truncate to first + last turns so the fixture stays small.
const conversation = readJsonl('conversation.jsonl').map(scrub);
const trimmed = conversation.length > 10
  ? [...conversation.slice(0, 5), ...conversation.slice(-5)]
  : conversation;
writeJsonl('conversation.jsonl', trimmed);

console.log(JSON.stringify({
  outDir,
  signals: signals.length,
  events: events.length,
  conversationKept: trimmed.length,
}, null, 2));
