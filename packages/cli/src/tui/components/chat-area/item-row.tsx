import type { DisplayItem } from '@/tui/types/display-item';
import { EMPTY_CHAT_LOOKUPS, type ChatLookups } from '@/tui/utils/chat-lookups';
import { UserRow } from './user-row';
import { AssistantStepRow } from './assistant-step-row';
import { SignalRow } from './signal-row';
import { SystemRow } from './system-row';

/** Render a single DisplayItem based on its role. */
export function ItemRow({
  item,
  contentWidth,
  lookups = EMPTY_CHAT_LOOKUPS,
}: {
  item: DisplayItem;
  contentWidth: number;
  /** Cross-row context (permission requests, workers) for id-only rows. */
  lookups?: ChatLookups;
}) {
  switch (item.role) {
    case 'user':
      return <UserRow item={item} width={contentWidth} />;
    case 'assistant':
      return <AssistantStepRow item={item} lookups={lookups} />;
    case 'signal':
      return <SignalRow item={item} />;
    case 'system':
      return <SystemRow item={item} />;
    default:
      return null;
  }
}
