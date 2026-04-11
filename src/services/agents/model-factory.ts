import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderConfig } from '@/types/index';


/** Create a language model using the OpenAI-compatible chat completions endpoint. */
export function createModel(provider: ProviderConfig) {
  const openai = createOpenAI({ baseURL: provider.endpoint, apiKey: provider.apiKey });
  return openai.chat(provider.modelName);
}
