/**
 * Prompt building utilities — atomic sections assembled at call time.
 *
 * Each builder returns a plain string section. The assemble() helper joins
 * non-empty sections with double newlines and trims trailing whitespace.
 */

/** Join non-empty sections into a single prompt string. */
export function assemble(...sections: (string | undefined | null | false)[]): string {
  return sections
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\n\n');
}

/** Wrap a titled section. Returns empty string if body is empty. */
export function section(title: string, body: string): string {
  if (!body.trim()) return '';
  return `# ${title}\n\n${body.trim()}`;
}

/** Build a markdown-style key-value block from an object. */
export function kvBlock(pairs: Record<string, string | number | undefined | null>): string {
  return Object.entries(pairs)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
}
