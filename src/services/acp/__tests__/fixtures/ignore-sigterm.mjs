// Test fixture: ignores SIGTERM and stays alive, so the transport's kill
// ladder has to escalate to SIGKILL. Signals readiness AFTER the SIGTERM
// handler is registered, so the test never races process boot.
process.on('SIGTERM', () => {
  /* swallow */
});
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
