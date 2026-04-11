import { describe, it, expect, vi } from 'vitest';
import { BaseAgent } from '@/services/agents/base-agent';
import type { ProviderConfig } from '@/types/index';

// Mock streamText and model-factory
vi.mock('ai', () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => n),
}));
vi.mock('../model-factory.js', () => ({
  createModel: () => ({}),
}));

const mockProvider: ProviderConfig = {
  endpoint: 'http://localhost:1234',
  apiKey: 'test-key',
  modelName: 'test-model',
};

// Concrete subclass for testing
class TestAgent extends BaseAgent {
  readonly state: any;
  constructor(provider: ProviderConfig, state?: any) {
    super(provider);
    this.state = state ?? { append: vi.fn(), get: vi.fn(() => []) };
  }
}

describe('BaseAgent', () => {
  it('should generate unique id', () => {
    const agent1 = new TestAgent(mockProvider);
    const agent2 = new TestAgent(mockProvider);
    expect(agent1.id).not.toBe(agent2.id);
  });

  it('should abort via abortController', () => {
    const agent = new TestAgent(mockProvider);
    agent.abort();
    expect(agent.abortController.signal.aborted).toBe(true);
  });

  it('should create model from provider', () => {
    const agent = new TestAgent(mockProvider);
    expect(agent).toBeDefined();
  });
});
