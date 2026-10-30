import type { TestContext } from 'node:test';

// Opt-in MySQL tests may load the real app with AI_MODE=gemini. Stub Google
// before app construction so those tests cannot call the live Gemini API.
export function mockGeminiUnavailable(context: TestContext): void {
  const original = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === 'generativelanguage.googleapis.com') {
      return new Response(JSON.stringify({ error: { message: 'Mocked provider unavailable' } }), { status: 503 });
    }
    return original(input, init);
  });
}
