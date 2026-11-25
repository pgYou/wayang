// Test fixture: writes one opening marker line (with the ACP_TEST_MARKER env
// var), then echoes every stdin line back to stdout as "echo:<line>".
process.stdout.write(JSON.stringify({ ready: true, marker: process.env.ACP_TEST_MARKER ?? 'none' }) + '\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    process.stdout.write(`echo:${line}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
