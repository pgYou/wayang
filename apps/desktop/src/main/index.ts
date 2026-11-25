/**
 * Wayang desktop — main process bootstrap (desktop-app-design §2.9).
 *
 * Pure bootstrap: every responsibility lives in a component — Application
 * assembles WindowManager / SecurityGuard / SessionService (which owns the
 * ServerProcessHost) / UnifiedLogger and runs the unified quit queue.
 */

import { Application } from './application';

new Application().run();
