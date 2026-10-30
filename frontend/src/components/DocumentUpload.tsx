import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { uploadDocuments } from '../api';
import { formatFileSize, MAX_FILES, validateFile, type UploadResult } from '../upload';
import AnalysisSection from './AnalysisSection';
import Icon from './Icon';

interface SelectedFile { id: string; file: File; error?: string }
interface ResultBatch { id: string; results: UploadResult[] }

const outcomeLabels = { ready: 'Uploaded', duplicate: 'Already uploaded', failed: 'Extraction failed', rejected: 'Rejected' };
const statusLabels = { uploaded: 'Uploaded', processing: 'Processing', ready: 'Ready', failed: 'Failed' };
const PREVIEW_LENGTH = 1200;

export default function DocumentUpload() {
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [batches, setBatches] = useState<ResultBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const request = useRef<AbortController | null>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const tooMany = selected.length > MAX_FILES;
  const canUpload = selected.length > 0 && !tooMany && selected.every(item => !item.error) && !busy;
  const readyDocuments = [...new Map(batches.flatMap(batch => batch.results)
    .flatMap(result => result.document?.processing_status === 'ready' ? [result.document] : [])
    .map(document => [document.id, document] as const)).values()];

  useEffect(() => () => request.current?.abort(), []);

  function addFiles(files: File[]) {
    if (busy) return;
    const added = files.map(file => ({ id: crypto.randomUUID(), file, error: validateFile(file) }));
    setSelected(previous => [...previous, ...added]);
    setRequestError('');
    setAnnouncement('');
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = '';
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUpload) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setRequestError('');
    setAnnouncement('');
    try {
      const results = await uploadDocuments(selected.map(item => item.file), controller.signal);
      setBatches(previous => [{ id: crypto.randomUUID(), results }, ...previous]);
      // Keep failed/rejected files selected so users can inspect or remove them.
      setSelected(previous => previous.filter((_item, index) => results[index]?.outcome === 'failed' || results[index]?.outcome === 'rejected'));
      const readyCount = results.filter(result => result.document?.processing_status === 'ready').length;
      setAnnouncement(`Upload complete. ${readyCount} of ${results.length} documents ready. Review each result below.`);
      resultsHeading.current?.focus();
    } catch (error) {
      if (!controller.signal.aborted) {
        setRequestError(error instanceof Error ? error.message : 'Upload failed. Please try again.');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }

  return (
    <>
      <div className="overview-grid" aria-label="Workspace overview">
        <div className="overview-card"><span className="overview-icon"><Icon name="file" /></span><div><p>Ready documents</p><strong>{readyDocuments.length.toString().padStart(2, '0')}</strong><span>Available for analysis</span></div></div>
        <div className="overview-card"><span className="overview-icon indigo"><Icon name="layers" /></span><div><p>Selected files</p><strong>{selected.length.toString().padStart(2, '0')}</strong><span>Up to {MAX_FILES} per upload</span></div></div>
        <div className="overview-card"><span className="overview-icon teal"><Icon name="check" /></span><div><p>Source provenance</p><strong className="overview-word">Traceable</strong><span>Evidence linked to each finding</span></div></div>
      </div>
      <div className="upload-layout">
      <section aria-labelledby="upload-heading" className="upload-section panel">
        <div className="panel-heading"><span className="step-number">01</span><div><h2 id="upload-heading">Upload documents</h2><p className="section-description">Add your source documents to get started.</p></div><span className="badge">PDF & TXT</span></div>
        <form onSubmit={submit} aria-busy={busy}>
          <div className={`dropzone${dragging && !busy ? ' is-dragging' : ''}${busy ? ' is-disabled' : ''}`} role="region" aria-label="Document drop zone"
            onDragEnter={event => { event.preventDefault(); dragDepth.current++; if (!busy) setDragging(true); }}
            onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
            onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }} onDrop={dropFiles}>
            <input id="documents" className="sr-only" aria-label="Choose PDF or TXT files" type="file" accept=".pdf,.txt,application/pdf,text/plain" multiple onChange={selectFiles} disabled={busy} aria-describedby="selection-help" />
            <label className="dropzone-label" htmlFor="documents"><span className="upload-symbol"><Icon name="upload" /></span><strong>{dragging ? 'Drop your documents here' : 'Drag & drop your documents here'}</strong><span>or <span className="browse-link">browse files</span> to select</span><span className="dropzone-limits">PDF or TXT · Up to 10 MiB per file · 5 files per upload</span></label>
          </div>
          <p id="selection-help" className="note upload-help">UTF-8 text and PDFs with a text layer. Scanned PDFs require OCR, which is not available yet.</p>
          {selected.length > 0 && (
            <div className="selection">
              <div className="section-bar">
                <h3>Selected files ({selected.length}/{MAX_FILES})</h3>
                <button type="button" className="button-secondary" disabled={busy} onClick={() => { setSelected([]); setRequestError(''); }}>Clear selection</button>
              </div>
              <ul className="file-list">
                {selected.map(item => (
                  <li key={item.id} className={`file-row${item.error ? ' file-invalid' : ''}`}>
                    <div className="file-info">
                      <span className="filename">{item.file.name}</span>
                      <span className="file-size">{formatFileSize(item.file.size)}</span>
                      {item.error && <span className="error-text">{item.error}</span>}
                    </div>
                    <button type="button" className="button-secondary" disabled={busy} aria-label={`Remove ${item.file.name}`} onClick={() => setSelected(previous => previous.filter(file => file.id !== item.id))}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tooMany && <p className="error-text" role="alert">Select at most five files. Remove {selected.length - MAX_FILES} before uploading.</p>}
          {selected.some(item => item.error) && <p className="error-text" role="alert">Remove files with validation errors before uploading.</p>}
          <div className="upload-actions">
            <button type="submit" disabled={!canUpload}>{busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="upload" />}{busy ? 'Uploading and extracting…' : `Upload${selected.length ? ` ${selected.length} file${selected.length === 1 ? '' : 's'}` : ' documents'}`}</button>
            {busy && <span className="loading-label" role="status"><span className="spinner" aria-hidden="true" />Uploading and extracting text. Please wait.</span>}
          </div>
          {requestError && <p className="error-box" role="alert">{requestError}</p>}
        </form>
        {announcement && <p role="status" className="upload-announcement"><Icon name="check" />{announcement}</p>}
      </section>
      <aside className="workflow-panel" id="workflow-guide"><div className="guide-icon"><Icon name="sparkles" /></div><p className="eyebrow">A CLEARER REVIEW PROCESS</p><h2>From documents<br />to connected insights.</h2><p className="guide-description">A single workspace to extract, compare and review your banking documents.</p><ol className="workflow-list"><li><span>1</span><div><strong>Upload your sources</strong><p>Bring PDF and TXT documents together.</p></div></li><li><span>2</span><div><strong>Review extracted text</strong><p>Check each document before analysis.</p></div></li><li><span>3</span><div><strong>Ask. Compare. Verify.</strong><p>Follow every finding to its source.</p></div></li></ol><div className="synthetic-notice"><Icon name="file" /><span>Built for this assessment.<br /><strong>Use synthetic documents only.</strong></span></div></aside>
      </div>

      <section className="results-section panel" aria-labelledby="results-heading">
        <div className="panel-heading"><span className="step-number">02</span><div><h2 id="results-heading" ref={resultsHeading} tabIndex={-1}>Document results</h2><p className="section-description">Your uploaded sources, processing status and extracted content.</p></div><span className="badge">{readyDocuments.length} ready</span></div>
        <p className="note source-note">Results are kept in this browser session. Extracted text is source content, not AI interpretation.</p>
        {batches.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="file" /></span><strong>Your documents will appear here</strong><p>Upload a PDF or TXT file to review its processing status and extracted text.</p></div>}
        {batches.map(batch => (
          <div className="result-batch" key={batch.id}>
            {batch.results.map((result, index) => {
              const document = result.document;
              const text = document?.extracted_text;
              const error = result.error?.message ?? document?.error_message;
              return (
                <article className="document-card upload-result-card" key={`${batch.id}-${index}`}>
                  <div className="document-card-top"><span className={`file-type-icon ${result.filename.toLowerCase().endsWith('.pdf') ? 'file-pdf' : 'file-txt'}`}><Icon name="file" /><small>{result.filename.toLowerCase().endsWith('.pdf') ? 'PDF' : 'TXT'}</small></span><span className={`badge badge-${document?.processing_status === 'failed' ? 'failed' : result.outcome}`}><span className="badge-dot" />{outcomeLabels[result.outcome]}</span></div>
                  <div className="section-bar">
                    <h3 className="filename">{result.filename}</h3>
                  </div>
                  {document && <p className="document-meta">{formatFileSize(Number(document.file_size_bytes))} · Document #{document.id} · Processing status: <strong>{statusLabels[document.processing_status]}</strong></p>}
                  {result.outcome === 'duplicate' && <p className="note">Existing document reused. No second copy was saved.</p>}
                  {error && <p className="error-box">{result.error?.code && <strong>{result.error.code}: </strong>}{error}</p>}
                  {text ? (
                    <details className="text-preview">
                      <summary>Extracted text preview</summary>
                      <pre>{text.slice(0, PREVIEW_LENGTH)}</pre>
                      {text.length > PREVIEW_LENGTH && <p className="note">Showing the first {PREVIEW_LENGTH.toLocaleString()} of {text.length.toLocaleString()} characters.</p>}
                    </details>
                  ) : document && !error && <p className="note">No extracted text is available yet.</p>}
                </article>
              );
            })}
          </div>
        ))}
      </section>
      <AnalysisSection documents={readyDocuments} uploading={busy} />
    </>
  );
}
