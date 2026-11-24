/**
 * Key names whose values get masked when redact=true.
 *
 * Single source of truth for the text-based redaction in read_file and the
 * structural redaction in inspect_json — one list, so the two tools cannot
 * drift apart. Credentials are routinely written into HTTP headers, so
 * Authorization and Cookie are part of the list alongside the
 * apiKey/token/secret/password family, plus the specific credential-key
 * shapes seen in AWS-style and database-style configs: privateKey,
 * accessKey/accessKeyId, passwd, credential(s).
 *
 * Deliberately NO bare "key" here: it would also hit `keys`, `keyName` or
 * `monkey` — only concrete credential forms belong on this list.
 */
export const SENSITIVE_KEY_RE =
  /api[_-]?key|authorization|cookie|secret|token|password|private[_-]?key|access[_-]?key|passwd|credential/i;

/** True when a key names a credential-like field. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}
