import { describe, it, expect } from 'vitest';
import { isCompactSystemItem } from '@/tui/components/chat-area/system-row';
import { ESystemSubtype } from '@/types/conversation';

/**
 * SystemRow's compact rendering is driven by this predicate. A system entry
 * renders as "Conversation has been compacted" only when it structurally
 * carries compactMeta — a bare subtype=compact entry (legacy ClaudeCodeWorker
 * success record) must NOT render in compact style.
 */
describe('isCompactSystemItem', () => {
  it('should return true only for subtype=compact entries carrying compactMeta', () => {
    expect(isCompactSystemItem({
      subtype: ESystemSubtype.Compact,
      compactMeta: { summarizedTokenCount: 100 },
    })).toBe(true);
  });

  it('should return false for subtype=compact without compactMeta', () => {
    expect(isCompactSystemItem({ subtype: ESystemSubtype.Compact })).toBe(false);
    expect(isCompactSystemItem({ subtype: ESystemSubtype.Compact, compactMeta: undefined })).toBe(false);
  });

  it('should return false for task_result entries', () => {
    expect(isCompactSystemItem({ subtype: ESystemSubtype.TaskResult })).toBe(false);
  });

  it('should return false for error entries', () => {
    expect(isCompactSystemItem({ subtype: ESystemSubtype.Error })).toBe(false);
  });
});
