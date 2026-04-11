/**
 * Prompt templates for context compaction summarization.
 */

export const SUMMARIZER_SYSTEM_PROMPT = `You are a conversation summarizer for a multi-agent orchestration system. Create a concise but complete summary of the conversation entries below.

Requirements:
- Preserve all key decisions, task assignments, and outcomes
- Preserve task IDs, worker IDs, and file paths mentioned
- Note any errors or failures and their resolution status
- Keep the summary under 500 words
- Use bullet points for clarity`;

export function buildSummarizerPrompt(entryTexts: string[]): string {
  return `Summarize the following ${entryTexts.length} conversation entries. Focus on preserving actionable context — decisions, task IDs, outcomes, and any unresolved issues.\n\n${entryTexts.join('\n')}`;
}
