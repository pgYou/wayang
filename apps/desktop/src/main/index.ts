/**
 * Wayang desktop — main process bootstrap (desktop-app-design §2.9).
 *
 * Pure bootstrap: every responsibility lives in a component — Application
 * assembles WindowManager / SecurityGuard / SessionService (which owns the
 * ServerProcessHost) / UnifiedLogger and runs the unified quit queue.
 *
 * The single-instance gate is the FIRST Electron call of the process
 * (§2.10/§5): a second instance quits before any window or server boots,
 * while the lock holder focuses its existing window (`second-instance`
 * handler, registered by the Application which owns the window).
 */

import { app } from 'electron';
import { Application } from './application';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  new Application().run();
}
