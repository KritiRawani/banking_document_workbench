import { AnalysisService } from './service.js';
import { MockAnalysisProvider } from './providers.js';
import { AnalysisError, type AnalysisProvider, type AnalysisRepository, type AnalysisResult } from './types.js';

const fallbackCodes = new Set([
  'AI_NOT_CONFIGURED', 'AI_UNAVAILABLE', 'AI_RATE_LIMITED', 'AI_PROVIDER_ERROR',
  'INVALID_AI_OUTPUT', 'UNGROUNDED_AI_OUTPUT',
  'AI_MODEL_UNAVAILABLE',
]);

// Add resilience outside the working extraction/comparison pipeline. Providers
// and fallback decisions are per request, never shared mutable mode state.
export class ResilientAnalysisService extends AnalysisService {
  private readonly prefersGemini: boolean;
  constructor(private readonly fallbackRepository: AnalysisRepository, provider: AnalysisProvider) {
    super(fallbackRepository, provider);
    this.prefersGemini = provider.mode === 'gemini';
  }

  override async analyse(input: unknown): Promise<AnalysisResult> {
    try { return await super.analyse(input); }
    catch (error) {
      // Invalid requests, document readiness, storage and DB failures are not AI
      // failures and must retain their existing error response/status.
      if (!this.prefersGemini || !(error instanceof AnalysisError) || !fallbackCodes.has(error.code)) throw error;
      const message = `Gemini could not supply validated analysis (${error.code}). All documents were reanalysed using the rule-based fallback; no partial Gemini findings were reused.`;
      return new AnalysisService(this.fallbackRepository, new MockAnalysisProvider(), {
        notices: [message], summaryPrefix: `Rule-based fallback (${error.code}). `,
      }).analyse(input);
    }
  }
}
