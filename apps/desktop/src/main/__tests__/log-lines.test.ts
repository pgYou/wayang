import { describe, expect, it } from 'vitest';
import { createLineSplitter } from '../log-lines';

describe('createLineSplitter', () => {
  it('emits complete lines and buffers partials across chunks', () => {
    const lines: string[] = [];
    const split = createLineSplitter((line) => lines.push(line));
    split('alpha\nbet');
    split('a\r\n');
    expect(lines).toEqual(['alpha', 'beta']);
  });

  it('skips empty lines', () => {
    const lines: string[] = [];
    const split = createLineSplitter((line) => lines.push(line));
    split('one\n\n\n two\n');
    expect(lines).toEqual(['one', ' two']);
  });

  it('flush emits a trailing line without a newline exactly once', () => {
    const lines: string[] = [];
    const split = createLineSplitter((line) => lines.push(line));
    split('partial');
    split.flush();
    split.flush();
    expect(lines).toEqual(['partial']);
  });
});
