// Test fixture: writes one oversized ndjson line (argv[2] bytes, default
// 1 MiB) followed by a newline, then stays alive.
const total = Number(process.argv[2] ?? 1024 * 1024);
const chunk = 'x'.repeat(64 * 1024);
let written = 0;
while (written + chunk.length <= total) {
  process.stdout.write(chunk);
  written += chunk.length;
}
if (written < total) {
  process.stdout.write('x'.repeat(total - written));
}
process.stdout.write('\n');
setInterval(() => {}, 1000);
