/**
 * Typed IPC router (desktop-app-design §2.2, 4.2 域二工作项①/②).
 *
 * The main side of the single contract: `typedHandle` registers a handler
 * for a contract channel with
 *   - sender validation (SecurityGuard's trust check, §2.9 senderFrame/url),
 *   - argument validation (the contract's validator table),
 *   - a `{ ok, data, error }` envelope so every failure crossing the bridge
 *     is a value, never a bare exception.
 *
 * Handlers receive the validated, typed argument tuple; channel names come
 * from the contract — no string literals here.
 */

import { ipcMain, type WebContents } from 'electron';
import {
  IPC_ARG_VALIDATORS,
  type IpcInvokeContract,
  type IpcResult,
  type InvokeChannel,
} from '../../shared/ipc-contract';

export interface IpcRouterDeps {
  /** Trust check for the invoking frame (§2.9 SecurityGuard). */
  isTrustedSender: (sender: WebContents) => boolean;
}

/** A typed channel handler: validated args in, channel result out. */
export type TypedHandler<K extends InvokeChannel> = (
  args: IpcInvokeContract[K]['args'],
) => Promise<IpcInvokeContract[K]['result']> | IpcInvokeContract[K]['result'];

export function typedHandle<K extends InvokeChannel>(
  channel: K,
  deps: IpcRouterDeps,
  handler: TypedHandler<K>,
): void {
  ipcMain.handle(channel, async (event: { sender: WebContents }, ...args: unknown[]): Promise<IpcResult<IpcInvokeContract[K]['result']>> => {
    try {
      // Untrusted senders are rejected before their arguments are even read.
      if (!deps.isTrustedSender(event.sender)) {
        return { ok: false, error: `untrusted sender on ${channel}` };
      }
      const problem = IPC_ARG_VALIDATORS[channel](args);
      if (problem) {
        return { ok: false, error: `invalid arguments on ${channel}: ${problem}` };
      }
      const data = await handler(args as IpcInvokeContract[K]['args']);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Remove a channel's handler (shutdown path). */
export function removeTypedHandler(channel: InvokeChannel): void {
  ipcMain.removeHandler(channel);
}
