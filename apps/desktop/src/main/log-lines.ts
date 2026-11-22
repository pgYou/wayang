/**
 * Line splitter for piped process output — chunks arrive on arbitrary
 * boundaries, logs want whole lines. Pure (electron-free) for testability.
 */

export type LineSink = (line: string) => void;

/** Wrap a chunk sink into a line sink; keeps the trailing partial line buffered. */
export function createLineSplitter(onLine: LineSink): LineSink & { flush(): void } {
  let buffer = '';
  const emit = (): void => {
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.length > 0) onLine(line);
    }
  };
  return Object.assign(
    (chunk: string): void => {
      buffer += chunk;
      emit();
    },
    {
      flush(): void {
        emit();
        if (buffer.length > 0) {
          onLine(buffer);
          buffer = '';
        }
      },
    },
  );
}
