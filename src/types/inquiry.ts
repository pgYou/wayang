/** Structured question for controller-to-user clarification. */
export interface InquireQuestion {
  message: string;
  type: 'confirm' | 'select' | 'text';
  options?: string[];
  default?: string;
}
