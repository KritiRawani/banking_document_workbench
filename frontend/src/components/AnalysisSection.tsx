import { useEffect, useRef, useState, type FormEvent } from 'react';
import { analyseDocuments } from '../api';
import { analysisAsText, findingLabels, type AnalysisResult, type AnalysisFinding } from '../analysis';
import type { UploadedDocument } from '../upload';
import Icon from './Icon';

export default function AnalysisSection({ documents, uploading = false }: { documents: UploadedDocument[]; uploading?: boolean }) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = [...new Set(documents.filter(doc => doc.processing_status === 'ready').map(doc => doc.id))];
  const documentKey = ids.slice().sort().join(',');
  const previousDocumentKey = useRef(documentKey);
  const resultKey = result?.documents.map(doc => doc.id).sort().join(',');
  const stale = Boolean(result && (resultKey !== documentKey || result.instruction !== instruction.trim()));

  useEffect(() => () => { requestVersion.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    if (previousDocumentKey.current !== documentKey) {
      requestVersion.current++;
      controller.current?.abort();
      controller.current = null;
      setBusy(false);
      setError('');
      setCopyStatus('');
    }
    previousDocumentKey.current = documentKey;
  }, [documentKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploading || !ids.length || ids.length > 10 || !instruction.trim() || instruction.trim().length > 4000) return;
    const request = new AbortController();
    const version = ++requestVersion.current;
    const submittedInstruction = instruction.trim();
    controller.current = request;
    // A run owns its result, messages and counters. Never display a previous
    // result while another request is running, or after that request fails.
    setResult(null);
    setBusy(true);
    setError('');
    setCopyStatus('');
    try {
      const response = await analyseDocuments(ids, submittedInstruction, request.signal);
      if (!request.signal.aborted && requestVersion.current === version) { setResult(response); heading.current?.focus(); }
    } catch (error) {
      if (!request.signal.aborted && requestVersion.current === version) setError(error instanceof Error ? error.message : 'Analysis failed. Please retry.');
    } finally {
      if (!request.signal.aborted && requestVersion.current === version) setBusy(false);
      if (controller.current === request) controller.current = null;
    }
  }

  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(analysisAsText(result)); setCopyStatus('Analysis copied with source evidence.'); }
    catch { setCopyStatus('Copy failed. Select the findings and copy them manually.'); }
  }

  return (
    <section className="analysis-section panel" aria-labelledby="analysis-heading">
      <div className="panel-heading"><span className="step-number">03</span><div><h2 id="analysis-heading">Document analysis</h2><p className="section-description">Your question. Your documents. Evidence with every insight.</p></div><span className="analysis-symbol"><Icon name="sparkles" /></span></div>
      {documents.length ? <>
        <p className="analysis-scope"><Icon name="check" /><span><strong>{ids.length} ready document{ids.length === 1 ? '' : 's'} will be included.</strong> Duplicate uploads are included once.</span></p>
        <ul className="analysis-document-list">{documents.filter((doc, index) => documents.findIndex(item => item.id === doc.id) === index).map(doc => <li key={doc.id}>{doc.original_filename} <span className="note">#{doc.id}</span></li>)}</ul>
      </> : <p className="analysis-scope scope-empty"><Icon name="file" />Upload documents successfully above to enable analysis.</p>}
      <form onSubmit={submit} aria-busy={busy} className="analysis-form">
        <label className="file-picker" htmlFor="analysis-instruction">Analysis instruction</label>
        <textarea id="analysis-instruction" rows={5} maxLength={4000} value={instruction} disabled={busy}
          onChange={event => setInstruction(event.target.value)} aria-describedby="analysis-help"
          placeholder="Compare applicant details, annual income, requested loan amounts and obligations across all loan documents. Highlight mismatches and relevant missing information with evidence." />
        <p id="analysis-help" className="note">{instruction.length}/4,000 characters. Only explicit source values are facts; interpretation, severity and missing-information observations require review.</p>
        <div className="prompt-suggestions"><span>Try an instruction</span><button type="button" className="prompt-chip" disabled={busy} onClick={() => setInstruction('Compare annual income across all uploaded documents.')}>Compare annual income<Icon name="arrow" /></button><button type="button" className="prompt-chip" disabled={busy} onClick={() => setInstruction('Compare employment type across all uploaded documents.')}>Compare employment type<Icon name="arrow" /></button></div>
        {ids.length > 10 && <p className="error-box" role="alert">Analysis supports up to 10 documents in this session. Refresh and upload a smaller set.</p>}
        <div className="upload-actions">
          <button type="submit" disabled={busy || uploading || !ids.length || ids.length > 10 || !instruction.trim()}>{busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkles" />}{busy ? 'Analysing documents…' : 'Analyze Documents'}{!busy && <Icon name="arrow" />}</button>
          {busy && <span className="loading-label" role="status"><span className="spinner" aria-hidden="true" />Analysing each source and comparing evidence…</span>}
        </div>
        {error && <p className="error-box" role="alert">{error}</p>}
      </form>
      <div className="analysis-result-header"><h3 ref={heading} tabIndex={-1} className="analysis-result-heading">Analysis results</h3><span className="note">Traceable insights, grounded in your sources</span></div>
      {!result && !busy && <div className="empty-state analysis-empty"><span className="empty-icon"><Icon name="sparkles" /></span><strong>Ready for a clearer picture?</strong><p>Enter an instruction above to compare your documents and explore the evidence.</p></div>}
      {stale && <p className="error-box" role="status">Results from an earlier document set or instruction are hidden. Run analysis again for the current instruction.</p>}
      {result && !stale && <div className="analysis-results">
        <div className="section-bar"><span className="badge">{result.mode === 'mock' ? 'Mock / rule-based analysis' : `Gemini · ${result.model}`}</span><button type="button" className="button-secondary" onClick={copy}><Icon name="copy" />Copy analysis</button></div>
        <p role="status">{copyStatus}</p>
        <p className="note">Analysis #{result.id} · {result.documents.length} documents</p>
        <p><strong>Instruction:</strong> {result.instruction}</p>
        <div className="summary-card"><span className="summary-icon"><Icon name="sparkles" /></span><div><h4>Consolidated summary</h4><p>{result.summary}</p></div></div>
        <div className="result-metrics" role="group" aria-label="Analysis statistics"><div><span className="metric-dot blue" />Documents reviewed<strong>{result.documents.length}</strong></div><div><span className="metric-dot amber" />Mismatches<strong>{result.findings.filter(item => item.type === 'discrepancy').length}</strong></div><div><span className="metric-dot green" />Comparisons<strong>{result.findings.filter(item => item.type === 'comparison').length}</strong></div><div><span className="metric-dot indigo" />Extracted values<strong>{result.findings.filter(item => item.type === 'key_value').length}</strong></div></div>
        <details className="analysis-context"><summary>Analysis scope & limitations</summary><ul className="analysis-limitations">{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>
        <div className="coverage-panel"><h4>Individual document coverage</h4><ul>{result.documents.map(doc => <li key={doc.id}><Icon name="file" /><span>{doc.name}</span><span className="badge">{doc.factCount} source-backed values</span></li>)}</ul></div>
        {(['summary', 'discrepancy', 'missing_information', 'comparison', 'key_value'] as AnalysisFinding['type'][]).map(type => {
          const findings = result.findings.filter(finding => finding.type === type);
          return <section key={type} className={`finding-group finding-${type}`} aria-label={findingLabels[type]}>
            <div className="finding-group-heading"><span className="finding-type-icon"><Icon name={type === 'discrepancy' || type === 'missing_information' ? 'alert' : type === 'comparison' ? 'check' : 'file'} /></span><h4>{findingLabels[type]}</h4><span className="finding-count">{findings.length}</span></div>
            {!findings.length && <p className="category-empty">No supported findings for this category and instruction. This does not prove there are no issues.</p>}
            {findings.map(finding => <article className="document-card" key={finding.id}>
              <div className="section-bar"><h5>{finding.title}</h5><span className={`badge severity-${finding.severity}`}>Severity: {finding.severity}</span></div>
              <p className="note">{finding.contentKind === 'extracted_fact' ? 'Extracted fact · quotation verified' : 'Interpretation · human review required'}</p>
              <p>{finding.description}</p>
              {finding.values.length > 0 && <div className="comparison-scroll"><table className="comparison-table"><caption className="sr-only">Source values for {finding.title}</caption><thead><tr><th>Document</th><th>Field</th><th>Reported value</th></tr></thead><tbody>{finding.values.map((value, index) => <tr key={index}><td>{result.documents.find(doc => doc.id === value.documentId)?.name ?? value.documentId}</td><td>{value.field}</td><td>{value.value}</td></tr>)}</tbody></table></div>}
              <details className="evidence-panel" open><summary><Icon name="file" />Source evidence<span>{finding.sources.length} citation{finding.sources.length === 1 ? '' : 's'}</span></summary>
              {finding.sources.map((source, index) => <div className="source-evidence" key={index}>
                <p className="note"><strong>{source.documentName}</strong> · Document #{source.documentId}{source.page ? ` · Page ${source.page}` : ''}{source.charStart !== null ? ` · Characters ${source.charStart}–${source.charEnd} (end exclusive)` : ' · Full extracted-text search scope'}</p>
                {source.quote === null ? <p className="note">No quotation supports absence. This observation only identifies the document searched.</p> : <blockquote>{source.quote}</blockquote>}
              </div>)}
              </details>
            </article>)}
          </section>;
        })}
      </div>}
    </section>
  );
}
