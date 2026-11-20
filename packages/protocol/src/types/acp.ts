/**
 * ACP shapes that the protocol layer itself references.
 *
 * These live here (not in @wayang/core) because `@wayang/protocol`'s config
 * types (`AcpProtocolConfig`) are built on top of them and the protocol layer
 * never imports core. The core ACP modules re-export them so their own import
 * sites stay unchanged.
 */

export interface AcpTimeouts {
  /** Upper bound for the initialize response. Default 15000. */
  handshakeMs: number;
  /** Upper bound for the session/new response. Default 30000. */
  sessionNewMs: number;
  /** Per-turn upper bound. 0 = unlimited; > 0 walks the §6 cancel path on expiry. Default 0. */
  promptMs: number;
  /** Upper bound for a permission_request to be answered. Default 300000. */
  permissionMs: number;
  /** Grace after session/cancel before SIGTERM. Default 5000. */
  cancelGraceMs: number;
  /** Grace after SIGTERM before SIGKILL. Default 2000. */
  sigtermWaitMs: number;
}

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

/** Stable capability view for upper layers; built by `buildAcpCapabilities`. */
export interface AcpCapabilities {
  provider: string;
  protocolVersion: number;
  /** Constantly true: session/update streaming exists by protocol definition. */
  streaming: true;
  toolCalls: boolean;
  permissionRequests: boolean;
  loadSession: boolean;
  /** 0.9.0 placeholders — semantics made explicit. */
  midTurnInject: false;
  inquiry: false;
  authMethods: AcpAuthMethod[];
}
