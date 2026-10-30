import { isUploadResult, type UploadResult } from './upload';
import { isAnalysisResult, type AnalysisResult } from './analysis';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api').replace(/\/$/, '');

export async function checkHealth(signal: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/health`, { signal });
  if (!response.ok) throw new Error('Backend is unavailable');
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('status' in body) || body.status !== 'ok') {
    throw new Error('Unexpected health response');
  }
}
export async function uploadDocuments(files: File[], signal: AbortSignal): Promise<UploadResult[]> {
  const form = new FormData();
  files.forEach(file => form.append('files', file));
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/documents/upload`, {
      method: 'POST', body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(100_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('Upload timed out. Some files may have been saved; retrying will detect duplicates.');
    }
    throw new Error('Cannot reach the backend. Check that it is running and the API URL and CLIENT_ORIGIN are configured correctly.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === 'object' && body !== null) {
    // The API returns per-file results even when all extractions fail (HTTP 422).
    if ([200, 201, 207, 422].includes(response.status) && 'results' in body && Array.isArray(body.results) &&
      body.results.length === files.length && body.results.every(isUploadResult)) return body.results;
    if (!response.ok && 'error' in body && typeof body.error === 'object' && body.error !== null &&
      'message' in body.error && typeof body.error.message === 'string') {
      throw new Error(body.error.message);
    }
  }
  throw new Error(`Unexpected upload response (HTTP ${response.status}). Some files may have been saved; retrying will detect duplicates.`);
}

export async function analyseDocuments(documentIds: string[], instruction: string, signal: AbortSignal): Promise<AnalysisResult> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/analysis`, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentIds, instruction }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(195_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(error instanceof DOMException && error.name === 'TimeoutError'
      ? 'Analysis timed out. Please retry with smaller documents.' : 'Cannot reach the analysis API. Check that the backend is running.');
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isAnalysisResult(body)) {
    if (body.documents.length !== documentIds.length || new Set(body.documents.map(doc => doc.id)).size !== documentIds.length || !body.documents.every(doc => documentIds.includes(doc.id))) {
      throw new Error('The analysis response did not include every requested document.');
    }
    if (body.instruction !== instruction.trim()) {
      throw new Error('The analysis response belongs to a different instruction. Please run the current analysis again.');
    }
    return body;
  }
  if (!response.ok && typeof body === 'object' && body !== null && 'error' in body &&
    typeof body.error === 'object' && body.error !== null && 'message' in body.error && typeof body.error.message === 'string') {
    throw new Error(body.error.message);
  }
  throw new Error(`Unexpected analysis response (HTTP ${response.status}).`);
}
