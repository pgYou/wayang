import type { DisplayItem } from '@/tui/types/display-item';
import { UserRow } from './user-row';
import { AssistantStepRow } from './assistant-step-row';
import { SignalRow } from './signal-row';
import { SystemRow } from './system-row';

/** Render a single DisplayItem based on its role. */
export function ItemRow({ item, contentWidth }: { item: DisplayItem; contentWidth: number }) {
  switch (item.role) {
    case 'user':
      return <UserRow item={item} width={contentWidth} />;
    case 'assistant':
      return <AssistantStepRow item={item} />;
    case 'signal':
      return <SignalRow item={item} />;
    case 'system':
      return <SystemRow item={item} />;
    default:
      return null;
  }
}
