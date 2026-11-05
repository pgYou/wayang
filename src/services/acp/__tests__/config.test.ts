import { describe, expect, it } from 'vitest';
import { ACP_JSONRPC_ERROR, DEFAULT_ACP_TIMEOUTS, resolveAcpTimeouts } from '@/services/acp/config';
import { AcpError } from '@/services/acp/errors';

describe('DEFAULT_ACP_TIMEOUTS', () => {
  it('matches the frozen §2.1 matrix exactly', () => {
    expect(DEFAULT_ACP_TIMEOUTS).toEqual({
      handshakeMs: 15_000,
      sessionNewMs: 30_000,
      promptMs: 0,
      permissionMs: 300_000,
      cancelGraceMs: 5_000,
      sigtermWaitMs: 2_000,
    });
  });
});

describe('resolveAcpTimeouts', () => {
  it('returns the defaults when called without input', () => {
    expect(resolveAcpTimeouts()).toEqual(DEFAULT_ACP_TIMEOUTS);
    expect(resolveAcpTimeouts({})).toEqual(DEFAULT_ACP_TIMEOUTS);
  });

  it('merges a partial over the defaults without mutating them', () => {
    const resolved = resolveAcpTimeouts({ cancelGraceMs: 8_000, promptMs: 120_000 });
    expect(resolved.cancelGraceMs).toBe(8_000);
    expect(resolved.promptMs).toBe(120_000);
    expect(resolved.handshakeMs).toBe(DEFAULT_ACP_TIMEOUTS.handshakeMs);
    expect(DEFAULT_ACP_TIMEOUTS.cancelGraceMs).toBe(5_000);
  });

  it('treats explicitly-undefined fields as absent', () => {
    expect(resolveAcpTimeouts({ promptMs: undefined })).toEqual(DEFAULT_ACP_TIMEOUTS);
  });

  it('allows promptMs = 0 (unlimited turns)', () => {
    expect(resolveAcpTimeouts({ promptMs: 0 }).promptMs).toBe(0);
  });

  it('rejects a negative promptMs with AcpError(protocol-mismatch)', () => {
    expect(() => resolveAcpTimeouts({ promptMs: -1 })).toThrowError(AcpError);
    try {
      resolveAcpTimeouts({ promptMs: -1 });
    } catch (err) {
      expect((err as AcpError).code).toBe('protocol-mismatch');
    }
  });

  it('rejects zero or negative values for every non-prompt field', () => {
    for (const field of ['handshakeMs', 'sessionNewMs', 'permissionMs', 'cancelGraceMs', 'sigtermWaitMs'] as const) {
      for (const value of [0, -100]) {
        expect(() => resolveAcpTimeouts({ [field]: value })).toThrowError(AcpError);
      }
    }
  });

  it('rejects non-number, NaN and Infinity values', () => {
    expect(() => resolveAcpTimeouts({ handshakeMs: Number.NaN })).toThrowError(AcpError);
    expect(() => resolveAcpTimeouts({ handshakeMs: Number.POSITIVE_INFINITY })).toThrowError(AcpError);
    expect(() => resolveAcpTimeouts({ sigtermWaitMs: 'soon' as unknown as number })).toThrowError(AcpError);
  });

  it('ignores non-timeout keys (callers spread whole AcpProtocolConfig objects in)', () => {
    // The worker layer spreads the whole protocol override object in —
    // `capabilities` and `gatePermissions` must neither land in the merged
    // matrix nor fail its numeric validation (latent bug fixed with #25).
    const resolved = resolveAcpTimeouts({
      handshakeMs: 20_000,
      capabilities: { permissionRequests: true },
      gatePermissions: false,
    } as unknown as Parameters<typeof resolveAcpTimeouts>[0]);
    expect(resolved).toEqual({ ...DEFAULT_ACP_TIMEOUTS, handshakeMs: 20_000 });
  });
});

describe('ACP_JSONRPC_ERROR', () => {
  it('matches the frozen §2.1 codes', () => {
    expect(ACP_JSONRPC_ERROR).toEqual({ requestCancelled: -32800, methodNotFound: -32601, internal: -32603 });
  });
});
