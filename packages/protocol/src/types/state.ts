// --- State Event ---

export interface StateEvent {
  type: 'set' | 'update' | 'append' | 'remove';
  path: string;
  data: unknown;
  prev: unknown;
}
