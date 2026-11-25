/**
 * SecurityGuard (desktop-app-design §2.9, 4.2 域二工作项②).
 *
 * Centralized renderer hardening:
 *   - `hardenedWebPreferences` is the ONE place webPreferences are defined
 *     (contextIsolation on, nodeIntegration off, sandbox on) — window code
 *     never hand-rolls them;
 *   - navigation is locked down (will-navigate blocks everything except the
 *     app's own origin; external http(s) links go to the system browser);
 *   - window.open is denied and every permission request is denied by
 *     default (权限清零);
 *   - `isTrustedSender` feeds the typed IPC router's sender validation
 *     (senderFrame.url check against the trusted window's contents).
 */

import { shell, type BrowserWindow, type WebContents, type WebPreferences } from 'electron';

/** Dev server origin pattern (electron-vite default) vs packaged file:// origin. */
function isInternalUrl(url: string): boolean {
  return url.startsWith('file://') || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
}

export class SecurityGuard {
  private trusted: WebContents | null = null;

  /** The hardened preload webPreferences — the app's single definition (§2.9). */
  hardenedWebPreferences(preloadPath: string): WebPreferences {
    return {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    };
  }

  /** Install the guards on a window and mark its contents as trusted. */
  install(window: BrowserWindow): void {
    const contents = window.webContents;
    this.trusted = contents;

    // Navigation lock: only the app's own origin may navigate; external
    // http(s) links are handed to the system browser.
    contents.on('will-navigate', (event, url) => {
      if (!isInternalUrl(url)) {
        event.preventDefault();
        if (/^https?:\/\//.test(url)) {
          void shell.openExternal(url);
        }
      }
    });

    // No popups from the app shell.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Default-deny every permission request (权限清零).
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
  }

  /** Drop the trust mark (window closed). */
  clearTrust(): void {
    this.trusted = null;
  }

  /** Sender validation for the typed IPC router (§2.2 Sender 校验). */
  isTrustedSender(sender: WebContents): boolean {
    const trusted = this.trusted;
    if (!trusted || trusted.isDestroyed()) return false;
    if (sender.id !== trusted.id) return false;
    // senderFrame.url check: the invoking frame must be the app's own page.
    return isInternalUrl(sender.getURL());
  }
}
