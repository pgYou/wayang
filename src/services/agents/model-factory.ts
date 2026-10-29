import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderConfig } from '@/types/index';

/**
 * Create a language model using the OpenAI-compatible chat completions endpoint.
 *
 * openai-compatible (not @ai-sdk/openai) is required for thinking models:
 * it parses `reasoning_content` from responses into reasoning parts and passes
 * them back on replay — DeepSeek/GLM-style thinking APIs reject requests whose
 * assistant tool-call messages lack `reasoning_content`.
 */
export function createModel(provider: ProviderConfig) {
  const compatible = createOpenAICompatible({
    name: 'wayang',
    baseURL: provider.endpoint,
    apiKey: provider.apiKey,
  });
  return compatible.chatModel(provider.modelName);
}
