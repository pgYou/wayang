# legacy-session fixture

A real pre-snapshot Wayang session, used by `signal-e2e-real-session.test.ts` to
verify that the signal-storage migration (append-only logs → `signals.json`
snapshot) works on actual historical data rather than a hand-built case.

## Contents

| File | Meaning |
| --- | --- |
| `signals.jsonl` | 36 signal bodies, the legacy append-only layout |
| `state-events.jsonl` | 71 legacy state events (`append` / `set` with whole arrays) |
| `conversation.jsonl` | 10 conversation turns (first 5 + last 5) |
| `meta.json` | session metadata |

There is deliberately **no `signals.json`**: the absence of a snapshot is what
puts `SignalState.restore()` on the migration path.

## Ground truth

Replaying the two legacy logs yields 36 signals: 34 `read`, 2 `discarded`
(`sig-4`, `sig-25`), 0 `unread`. Max signal number is 36, so the id
high-water mark after migration must be 36.

## Why it is scrubbed

The capture came from a live run and contained a real API key, a machine
workspace path, and an internal endpoint. Those fields are rewritten by
`generate-legacy-session.mjs`. Signal ids, bodies, timestamps and status
transitions are untouched, so the fixture still exercises real data shapes.

The test suite asserts that no credential, username, or internal hostname
reappears in these files.

## Regenerating

```bash
node src/services/signal/__tests__/fixtures/generate-legacy-session.mjs <source-session-dir>
```

The generator is kept in-tree so the scrubbing rules are auditable. Do not
commit a raw session directory.
