import { useEffect, useState } from 'react';
import { checkHealth } from './api';
import DocumentUpload from './components/DocumentUpload';
import Icon from './components/Icon';

export default function App() {
  const [status, setStatus] = useState('Checking backend…');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    checkHealth(controller.signal)
      .then(() => { if (active) setStatus('Backend connected'); })
      .catch(() => { if (!active) return;
        if (!controller.signal.aborted) setStatus('Backend unavailable — check that it is running.');
        else setStatus('Connection timed out — check that the backend is running.'); })
      .finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <a href="#workspace" className="skip-link">Skip to workspace</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="#workspace" className="brand" aria-label="Banking Document Workbench home">
            <span className="brand-mark"><Icon name="bank" /></span>
            <span><strong>Document Workbench</strong><span className="brand-caption">BANKING INTELLIGENCE</span></span>
          </a>
          <nav aria-label="Main navigation" className="main-nav"><a href="#workspace" className="nav-active">Workspace</a><a href="#results-heading">Documents</a><a href="#analysis-heading">Analysis</a></nav>
          <span className="workspace-pill"><span className="status-dot" />Synthetic workspace</span>
        </div>
      </header>
      <main id="workspace" className="dashboard-shell">
        <div className="page-intro">
          <div><p className="eyebrow">YOUR DOCUMENT WORKSPACE</p><h1>Multi-Document Intelligence Workbench</h1><p className="intro-description">Bring your documents together. Turn source information into clear, traceable insights.</p></div>
          <div className={`connection-status ${status === 'Backend connected' ? 'connected' : ''}`} role="status"><span className="status-dot" />{status}</div>
        </div>
        <DocumentUpload />
        <footer className="dashboard-footer"><span><Icon name="bank" /> Banking Document Workbench</span><p>Assessment environment · Synthetic documents only</p></footer>
      </main>
    </div>
  );
}
