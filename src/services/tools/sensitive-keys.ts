/**
 * Key names whose values get masked when redact=true.
 *
 * Single source of truth for the text-based redaction in read_file and the
 * structural redaction in inspect_json — one list, so the two tools cannot
 * drift apart. Credentials are routinely written into HTTP headers, so
 * Authorization and Cookie are part of the list alongside the
 * apiKey/token/secret/password family.
 */
export const SENSITIVE_KEY_RE = /api[_-]?key|authorization|cookie|secret|token|password/i;

/** True when a key names a credential-like field. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}
