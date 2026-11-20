import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ResolvedModel } from '@/services/config/model-resolution';

/**
 * Create a language model using the OpenAI-compatible chat completions endpoint.
 *
 * openai-compatible (not @ai-sdk/openai) is required for thinking models:
 * it parses `reasoning_content` from responses into reasoning parts and passes
 * them back on replay — DeepSeek/GLM-style thinking APIs reject requests whose
 * assistant tool-call messages lack `reasoning_content`.
 */
export function createModel(model: ResolvedModel) {
  const compatible = createOpenAICompatible({
    name: 'wayang',
    baseURL: model.baseURL,
    apiKey: model.apiKey,
  });
  return compatible.chatModel(model.modelName);
}
