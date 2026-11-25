import { describe, it, expect } from 'vitest';
import {
  CMDSUBST_PLACEHOLDER,
  classifyRedirections,
  isDiscardRedirectTarget,
  tokenizeShellLite,
  type ShellRedirect,
  type ShellSegment,
  type ShellToken,
} from '@/services/tools/shell-lexer';

/** Tokenize and fail loudly (with the lexer's error) when it does not parse. */
function lex(command: string): ShellSegment[] {
  const result = tokenizeShellLite(command);
  if (!result.ok) throw new Error(`unexpected lexer error: ${result.error}`);
  return result.segments;
}

/** Every redirection in a command line, flattened. */
function redirects(command: string): ShellRedirect[] {
  return lex(command)
    .flatMap((segment) => segment.tokens)
    .filter((token): token is Extract<ShellToken, { kind: 'redirect' }> => token.kind === 'redirect')
    .map((token) => token.redirect);
}

/** The words of a command line, flattened. */
function words(command: string): string[] {
  return lex(command)
    .flatMap((segment) => segment.tokens)
    .filter((token): token is Extract<ShellToken, { kind: 'word' }> => token.kind === 'word')
    .map((token) => token.word.text);
}

describe('tokenizeShellLite: segments', () => {
  it('splits on pipes, `&&`, `;` and newlines', () => {
    expect(lex('a | b && c ; d\ne').length).toBe(5);
    // `||` and `|&` are single operators, not two empty segments.
    expect(lex('a || b').length).toBe(2);
    expect(lex('a |& b').length).toBe(2);
  });

  it('treats a comment as the rest of the line, not a command', () => {
    const segments = lex('ls -la # rm -rf /');
    expect(segments.length).toBe(1);
    expect(words('ls -la # rm -rf /')).toEqual(['ls', '-la']);
  });

  it('joins a shell word that contains quoted spaces', () => {
    expect(words('echo "out file.txt"')).toEqual(['echo', 'out file.txt']);
    expect(words("echo 'a b'")).toEqual(['echo', 'a b']);
  });
});

describe('tokenizeShellLite: redirections', () => {
  it.each([
    ['>', '>', 'output', 1],
    ['>>', '>>', 'output', 1],
    ['2>', '2>', 'output', 2],
    ['&>', '&>', 'output', 2],
    ['&>>', '&>>', 'output', 2],
    ['<', '<', 'input', undefined],
  ])('%s is lexed as a redirection with its own fd', (suffix, operator, kind, fd) => {
    const [redirect] = redirects(`cmd ${suffix}/tmp/x`);
    expect(redirect?.operator).toBe(operator);
    expect(redirect?.kind).toBe(kind);
    expect(redirect?.fd).toBe(fd);
    expect(redirect?.target?.text).toBe('/tmp/x');
  });

  it('lexes fd duplication without a target path', () => {
    for (const command of ['cmd 2>&1', 'cmd >&2', 'cmd 1>&2', 'cmd 2>&1 3>&1']) {
      const all = redirects(command);
      expect(all.length).toBeGreaterThan(0);
      for (const redirect of all) {
        expect(redirect.kind).toBe('fd-dup');
        expect(redirect.target).toBeUndefined();
      }
    }
  });

  it('keeps the target of a redirect that is written without spaces', () => {
    expect(redirects('ls >/dev/null')[0]?.target?.text).toBe('/dev/null');
    expect(redirects('ls 2>/dev/null')[0]?.target?.text).toBe('/dev/null');
  });

  it('lexes heredoc, here-string and clobber operators', () => {
    expect(redirects("cat <<'EOF'\nbody\nEOF")[0]?.kind).toBe('here-doc');
    // A heredoc without its body is an incomplete command, not a silent allow.
    expect(tokenizeShellLite("cat <<'EOF'").ok).toBe(false);
    expect(redirects('cat <<< "x"')[0]?.kind).toBe('here-string');
    expect(redirects('echo x >| out.txt')[0]?.operator).toBe('>|');
  });

  it('skips a heredoc body instead of parsing it as commands', () => {
    const segments = lex("cat <<'EOF'\n$(rm -rf /)\nEOF\n");
    expect(segments.length).toBe(1);
    expect(words("cat <<'EOF'\n$(rm -rf /)\nEOF\n")).toEqual(['cat']);
  });
});

describe('tokenizeShellLite: quoting and substitution', () => {
  it('keeps single quotes fully literal', () => {
    // The old gate read this backtick as a substitution.
    expect(words("echo 'a`b'")).toEqual(['echo', 'a`b']);
    expect(words("echo '$(date)'")).toEqual(['echo', '$(date)']);
  });

  it('finds substitutions outside single quotes and inside double quotes', () => {
    expect(lex('echo $(date)')[0]?.tokens[1]).toMatchObject({
      kind: 'word',
      word: { text: CMDSUBST_PLACEHOLDER, substitutions: [{ inner: 'date' }] },
    });
    expect(lex('echo "x $(date)"')[0]?.tokens[1]).toMatchObject({
      kind: 'word',
      word: { substitutions: [{ inner: 'date' }] },
    });
    expect(lex('echo `date`')[0]?.tokens[1]).toMatchObject({
      kind: 'word',
      word: { substitutions: [{ inner: 'date' }] },
    });
  });

  it('balances nested parentheses inside $()', () => {
    expect(lex('echo $(echo $(date))')[0]?.tokens[1]).toMatchObject({
      kind: 'word',
      word: { substitutions: [{ inner: 'echo $(date)' }] },
    });
  });

  it('does not treat a plain parameter as a substitution', () => {
    const tokens = lex("awk '{print $1}' file")[0]?.tokens ?? [];
    for (const token of tokens) {
      if (token.kind === 'word') expect(token.word.substitutions).toEqual([]);
    }
  });
});

describe('tokenizeShellLite: errors (callers turn these into `ask`)', () => {
  it.each(["echo 'abc", 'echo "abc', 'echo $(date', 'echo `date', 'echo >', 'echo >&', 'cat <<EOF'])(
    '%s fails to parse',
    (command) => {
      const result = tokenizeShellLite(command);
      expect(result.ok).toBe(false);
    },
  );
});

describe('classifyRedirections', () => {
  it('separates discard targets, fd copies and real file writes', () => {
    const classification = classifyRedirections(lex('cmd >/dev/null 2>&1 >> /dev/stdout 3>&1 > real.txt < in.txt'));
    expect(classification.discarded).toEqual(['/dev/null', '/dev/stdout']);
    expect(classification.duplicates).toEqual(['2>&1', '3>&1']);
    expect(classification.writeTargets).toEqual(['real.txt']);
    expect(classification.readTargets).toEqual(['in.txt']);
    expect(classification.unresolved).toBeUndefined();
  });

  it('marks a substitution target as unresolved', () => {
    const classification = classifyRedirections(lex('cmd > $(mktemp)'));
    expect(classification.writeTargets).toEqual([]);
    expect(classification.unresolved).toBeDefined();
  });

  it('ignores here-strings and heredoc delimiters', () => {
    const classification = classifyRedirections(lex('cat <<< "data"'));
    expect(classification.writeTargets).toEqual([]);
    expect(classification.readTargets).toEqual([]);
  });

  it('recognises exactly the /dev/null family as discard targets', () => {
    expect(isDiscardRedirectTarget('/dev/null')).toBe(true);
    expect(isDiscardRedirectTarget('/dev/stdout')).toBe(true);
    expect(isDiscardRedirectTarget('/dev/stderr')).toBe(true);
    expect(isDiscardRedirectTarget('/dev/zero')).toBe(false);
    expect(isDiscardRedirectTarget('/tmp/null')).toBe(false);
    expect(isDiscardRedirectTarget(undefined)).toBe(false);
  });
});
