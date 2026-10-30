import { GeminiAnalysisProvider, MockAnalysisProvider } from './providers.js';
import { ResilientAnalysisService } from './resilient-service.js';
import type { AnalysisRepository } from './types.js';

export interface AnalysisConfiguration {
  AI_MODE: 'mock' | 'gemini';
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
}

// Preserve the existing mode selection while making the production wiring
// testable with an injected HTTP transport and no private environment changes.
export function createConfiguredAnalysisService(repository: AnalysisRepository, config: AnalysisConfiguration, transport: typeof fetch = fetch) {
  const provider = config.AI_MODE === 'gemini'
    ? new GeminiAnalysisProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL, transport)
    : new MockAnalysisProvider();
  return new ResilientAnalysisService(repository, provider);
}
