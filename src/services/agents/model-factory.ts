import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderConfig } from '@/types/index';
import { ConfigError } from '@/services/config/model-resolution';

/**
 * Create a language model using the OpenAI-compatible chat completions endpoint.
 *
 * openai-compatible (not @ai-sdk/openai) is required for thinking models:
 * it parses `reasoning_content` from responses into reasoning parts and passes
 * them back on replay — DeepSeek/GLM-style thinking APIs reject requests whose
 * assistant tool-call messages lack `reasoning_content`.
 */
export function createModel(provider: ProviderConfig) {
  // #88 step2: replace with resolveModelRef
  const baseURL = provider.baseURL ?? provider.endpoint;
  if (!baseURL) {
    throw new ConfigError('provider baseURL is required (set baseURL or the deprecated endpoint alias)');
  }
  if (!provider.modelName) {
    throw new ConfigError('provider modelName is required');
  }
  const compatible = createOpenAICompatible({
    name: 'wayang',
    baseURL,
    apiKey: provider.apiKey,
  });
  return compatible.chatModel(provider.modelName);
}
