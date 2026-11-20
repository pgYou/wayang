/** Structured question for controller-to-user clarification. */
export interface InquireQuestion {
  message: string;
  type: 'confirm' | 'select' | 'text';
  options?: string[];
  default?: string;
  /**
   * "select" only: append an "Other" choice that lets the user type a
   * free-form answer instead of picking a preset option. Defaults to true.
   */
  allowOther?: boolean;
}

/** Label of the free-input choice auto-appended to select options. */
export const INQUIRE_OTHER_OPTION = '其他（自行输入）';

/** Prefix marking an inquire answer the user typed via the "Other" choice. */
export const INQUIRE_CUSTOM_ANSWER_PREFIX = '[Other] ';

/**
 * Choices rendered for a select inquiry: the preset options plus the
 * auto-appended "Other" escape (omitted when allowOther is false).
 */
export function buildSelectChoices(options: string[], allowOther?: boolean): string[] {
  return allowOther === false ? options : [...options, INQUIRE_OTHER_OPTION];
}

/** Whether a rendered choice is the auto-appended "Other" row. */
export function isOtherChoice(choice: string): boolean {
  return choice === INQUIRE_OTHER_OPTION;
}

/**
 * Mark a free-form answer typed via "Other" so the controller can tell it
 * apart from a preset-option pick.
 */
export function formatCustomAnswer(text: string): string {
  return `${INQUIRE_CUSTOM_ANSWER_PREFIX}${text}`;
}

/** Whether an inquire answer is custom "Other" input rather than a preset option. */
export function isCustomAnswer(answer: string): boolean {
  return answer.startsWith(INQUIRE_CUSTOM_ANSWER_PREFIX);
}
