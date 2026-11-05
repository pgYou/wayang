// Test fixture: writes N stderr lines, then exits with the given code.
// argv[2] = exit code (default 0), argv[3] = stderr line count (default 0).
const code = Number(process.argv[2] ?? 0);
const stderrCount = Number(process.argv[3] ?? 0);
for (let i = 1; i <= stderrCount; i += 1) {
  process.stderr.write(`stderr line ${i} of ${stderrCount}\n`);
}
process.exit(code);
