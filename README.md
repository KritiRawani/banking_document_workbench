# Banking Document Workbench

Project name: `banking_document_workbench`. MySQL database name: `document_workbench`.

React + Vite + Tailwind dashboard, Express backend, strict TypeScript, MySQL persistence, PDF/TXT upload and extraction, and grounded document analysis. The responsive frontend supports drag-and-drop/browse uploads, document cards with expandable text previews, custom analysis instructions, structured result cards and source evidence. Authentication is not implemented yet. Use synthetic data only.

## Structure

```text
frontend/
  src/             # React app and API client
  .env.example     # Public frontend configuration
backend/
  database/
    schema.sql     # Creates document_workbench and the four initial tables
  samples/         # Synthetic TXT and PDF documents for manual testing
  src/
    config/        # Validated environment and MySQL pool
    documents/     # Validation, extraction, secure storage, MySQL repository
    analysis/      # Independent extraction, collective comparison, evidence validation
    routes/        # Health, document upload, and analysis routes
    app.ts         # Express middleware and routing
    server.ts      # Server startup/shutdown
  .env.example     # Private backend configuration
  tests/           # Multipart API tests and opt-in MySQL integration test
package.json       # npm workspaces and shared commands
```

## Local setup

Prerequisite: Node.js 24.13 or newer and npm. MySQL is optional for this initial app startup; a real MySQL instance and credentials are needed for the database health check.

From the repository root in PowerShell:

```powershell
npm install
if (-not (Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
if (-not (Test-Path frontend/.env)) { Copy-Item frontend/.env.example frontend/.env }
npm run dev
```

Frontend: http://localhost:5173
Backend: http://localhost:4000/api/health
Database health: http://localhost:4000/api/health/db

Edit `backend/.env` with your MySQL connection URL, using `document_workbench` as the database name:

```dotenv
MYSQL_URL=mysql://workbench_user:replace_me@localhost:3306/document_workbench
```

The example password is a placeholder; no database is provisioned automatically. In MySQL Workbench, connect to a MySQL 8.0.16+ server with permission to create databases and tables, open `backend/database/schema.sql`, and execute the entire script. Refresh Schemas to see `document_workbench` and its `documents`, `analysis_sessions`, `analysis_documents`, and `findings` tables. Configure a dedicated MySQL user with access to this database before testing the backend connection. The script is manual and is never executed by app startup.

Without `MYSQL_URL`, the database endpoint returns `503 not_configured`; unreachable MySQL returns `503 unavailable`. The ordinary health endpoint confirms the API process only. Restart the backend after editing its environment file.

The backend reads database credentials only from `backend/.env`, resolved relative to the configuration module regardless of the launch folder. Shell `MYSQL_URL` values are not used. The connection pool is limited to five connections with a bounded waiting queue. Startup checks connectivity and reports sanitized errors while leaving the API available for health diagnostics.

Run `npm run db:test -w backend` for a read-only database connection test. It checks `SELECT 1` and confirms that the selected database is `document_workbench`, closes the pool, and exits with code 1 on failure. `GET /api/health/db` uses the same check and returns HTTP 200 on success or 503 on failure, with a safe diagnostic code and message. Neither check creates, drops, or changes tables; neither logs credentials or raw MySQL errors.

Keep `CLIENT_ORIGIN` aligned with the frontend URL and `VITE_API_BASE_URL` aligned with the API URL. Restart the relevant dev server after changing environment variables. `AI_MODE=mock` runs local rule-based analysis. `AI_MODE=gemini` uses `GEMINI_API_KEY` and `GEMINI_MODEL` for structured Gemini extraction and collective comparison, with an explicitly labelled rule-based fallback when Gemini is unavailable or its output cannot be validated. No key is needed for mock mode. Gemini mode sends extracted synthetic document content to Google; the API key is loaded from `backend/.env` locally and backend platform environment variables in production; it is never read from the browser.

Never put MySQL credentials or Gemini keys in frontend environment variables: Vite exposes `VITE_*` variables to the browser. Real `.env` files are ignored by Git.

## Commands

```powershell
npm run dev                 # Both development servers
npm run dev -w frontend     # Frontend only
npm run dev -w backend      # Backend only
npm run typecheck           # Both TypeScript projects
npm run build               # Both production builds
npm run start -w backend    # Compiled API after build
npm run db:test -w backend  # Read-only MySQL connectivity test
npm run test -w backend     # API tests (MySQL integration test skipped by default)
npm run test -w frontend    # React analysis, upload-to-analysis, and API-client tests
npm run preview -w frontend # Preview the built frontend
```

## Upload and extract documents

Run `npm run dev` from the repository root to start both apps, then open http://localhost:5173. Alternatively run `npm run dev -w backend` and `npm run dev -w frontend` in separate terminals. Keep your existing `.env` files; do not overwrite configured credentials with the examples.

In the browser, choose PDF/TXT files, review filenames and sizes, remove unwanted or invalid selections, then click Upload. Selection is limited to five files per batch and 10 MiB per file. The interface displays a loading indicator while the backend uploads and extracts text, then shows each result, processing status, duplicate/error information, and a preview of the first 1,200 extracted characters. Mixed results and HTTP 422 extraction failures are shown per file. Results stay visible until the page is refreshed; there is no document-history endpoint yet. File removal only changes the current selection and does not delete saved documents. Failed files remain selected for review/removal; reuploading unchanged failed content returns its existing status.

Start the backend with `npm run dev -w backend`. The existing `documents` table must already exist. This feature does not run SQL migrations or recreate tables.

`POST http://localhost:4000/api/documents/upload` accepts `multipart/form-data` with one to five files under the repeated field name `files`. PDF and UTF-8 TXT are supported, with a maximum of 10 MiB (10,485,760 bytes) per file. PDF files must have a PDF header and parse successfully; TXT files must be valid UTF-8 without binary control characters. Extension and MIME type are checked; `application/octet-stream` is allowed for clients that omit a specific type, with content validation still applied.

From the repository root in PowerShell:

```powershell
curl.exe -i -X POST http://localhost:4000/api/documents/upload -F "files=@backend/samples/application.txt;type=text/plain" -F "files=@backend/samples/financials.pdf;type=application/pdf"
```

In Postman, choose POST, enter the same URL, choose Body -> form-data, add two `files` rows, set each row's type to File, and select a PDF and TXT. Let Postman set the multipart Content-Type and boundary automatically.

Each entry in `results` has `filename`, `outcome` (`ready`, `duplicate`, `failed`, or `rejected`), an optional `document`, and an optional `{ code, message }` error. A document includes its ID (string), filename, MIME type, byte size (string), SHA-256, processing status, extracted text, extraction metadata, and timestamps. Internal storage keys and local paths are omitted. Text is untrusted source content; render it as plain text, never as HTML.

HTTP responses:

| Status | Meaning |
| --- | --- |
| 201 | All files were saved and extracted successfully |
| 200 | All files were duplicates of existing documents |
| 207 | Mixed per-file results; inspect every entry |
| 422 | Every file was rejected or failed extraction; inspect individual error codes |
| 400 | Missing files, malformed multipart, unexpected fields, or more than five files |
| 413 | A file exceeded 10 MiB; no files in that request are processed |
| 415 | Request did not use multipart/form-data |
| 503 | Database/storage unavailable or upload capacity reached |

Repeat the same upload to verify `duplicate` outcomes and the same document IDs. Deduplication uses SHA-256 and a MySQL named lock per hash, preventing concurrent uploads through this application from inserting another row. Existing failed or interrupted documents also return as duplicates with their original status; automatic retry of failed extraction is not implemented. Unsupported extensions and zero-byte files are rejected before persistence. Corrupt PDFs, invalid/blank text, and PDFs without a text layer are stored with `failed` status and a sanitized error. A duplicate's original filename remains in its document record; the response entry retains the new upload's filename.

PDF metadata contains one-based page numbers and zero-based, end-exclusive JavaScript character offsets into `extracted_text`. PDF parsing runs in a worker with a 15-second timeout, a 128 MiB V8 heap limit, a 100-page limit, and a 1,000,000-character text limit. TXT extraction uses the same character limit. OCR and password-protected PDFs are not supported. Text extraction records source facts only; no AI interpretation or financial decision is generated.

Files are staged on disk inside `backend/uploads`, then retained under random UUID names. The directory is ignored by Git and has no static/download route. Temporary files are cleaned after processing, duplicate uploads do not retain another file, and a failed database insert removes its newly retained file. Directory/file permissions are restricted on platforms that support POSIX modes; on Windows, restrict the directory ACL to the service account. At most two upload requests run at a time per API process, with files processed sequentially within each request.

## Upload tests

`npm run test -w backend` exercises real multipart requests, the real TXT/PDF extractors, and isolated temporary storage using an in-memory repository. It covers successful uploads, SHA-256, duplicate handling, page provenance, storage privacy, corrupt/scanned PDFs, empty/binary/invalid-encoding text, unsupported formats, MIME spoofing, size limits, bad multipart fields, database outage responses, and insertion-failure cleanup.

To additionally run the MySQL persistence test from PowerShell:

```powershell
$env:RUN_MYSQL_UPLOAD_TESTS = '1'
npm run test -w backend
Remove-Item Env:RUN_MYSQL_UPLOAD_TESTS
```

The opt-in test uses `backend/.env`, inserts two synthetic documents, retains their files for inspection, verifies persisted text/metadata/status, and tests concurrent duplicate requests. It does not recreate, drop, or delete tables or records.

## Document analysis

Discrepancy results are explicitly scoped to annual income between `01_loan_application.pdf` and `02_income_verification.pdf`. The calculated difference and evidence use only those two sources. Conflicting fields or values in other documents do not produce discrepancy findings. Both named sources must be available; another document is never substituted. Other analysis sections continue to show source-backed document content. Run analysis again to refresh previously stored results.

The current instruction takes precedence over broad document-scope wording and the discrepancy rule. For example, `Compare employment type across all uploaded documents` selects only `employment_type`, shows the matching `Salaried` source values, and does not extract or display income discrepancies. Whole field phrases are resolved before broader topic words. The same scope filter applies to mock and Gemini facts before summaries, comparisons and persistence. Changing the frontend instruction hides earlier results until a new analysis completes.

Document-role references and PDF/TXT filenames are excluded when resolving requested fields. In `Compare employment type in the loan application and income verification documents`, `income verification` identifies a source document; it does not request an income comparison. Comparison generation independently reapplies the instruction scope, and summary mismatch counts use only the final findings from that run.

Every POST creates a separate analysis session with request-local facts and findings; previous results are never used as input. Starting a run clears the previous result, counters, copy status and errors. Changing the document set aborts obsolete requests, and request-version checks reject late responses. The API client also rejects a result whose instruction differs from the current submitted instruction. Sequential income-then-employment regression tests verify separate stored sessions, `Salaried` versus `Salaried`, and zero employment mismatches.

Below Document Results, enter an instruction and select **Analyze Documents**. Every unique ready document in the current browser session is included, across upload batches; four ready documents send all four IDs. Failed documents are excluded and duplicate IDs are sent once. Results include individual source-backed key values and document summaries, collective comparisons/potential discrepancies, scoped missing-information observations, severity, source filenames, quotations and character/page locations. Copy analysis includes the instruction, values, evidence and limitations. Changing the instruction or uploading a new document marks earlier results as stale until analysis runs again.

`POST /api/analysis` accepts JSON:

```json
{
  "documentIds": ["1", "2", "3", "4"],
  "instruction": "Compare applicant details, annual income, requested loan amounts and obligations across all uploaded loan documents. Identify mismatches and relevant missing information."
}
```

Use real IDs returned by your upload responses. Success returns HTTP 201 with `{ id, status, instruction, mode, model, summary, limitations, documents, findings }`. `GET /api/analysis/:id` retrieves a completed stored result. Invalid inputs return 400, missing documents 404, unreadable/unready documents 409, content limits 413, invalid/unavailable AI output 502, and database/capacity failures 503, using `{ error: { code, message } }`.

The pipeline loads each document independently, splits it on whole lines into bounded chunks, and extracts instruction-relevant facts per source. It verifies every fact value occurs verbatim inside its quotation and that the quotation occurs in that document's stored text. It assigns character offsets and, for PDFs, page locations from extraction metadata. Collective comparison receives validated facts with document IDs, not a concatenation of raw documents. Unknown fact citations, comparisons without two distinct source documents, invented values/quotes, and unsupported numerical interpretation claims reject the entire analysis before findings are committed.

Broad analysis instructions use banking-loan fields: applicant details, addresses, loan amounts/purpose, annual/monthly income, property value, employment, dates, obligations and credit scores. Extraction supports colon/equal-sign labels, PDF table columns separated by two or more spaces, and bulleted notes. Annual and monthly income are compared separately, as are residential/property addresses and employer/employment type. Matching fields include every uploaded document that supplies that field; unrelated documents are not assigned invented values. Explicit business-field extraction remains available when specifically requested, but business metrics are not part of the loan missing-information checklist.

Matching-field comparisons run on the server for both AI modes. Explicit same-currency amounts are parsed into integer minor units, normalising INR/₹ notation and Indian/Western number grouping while preserving verbatim source quotations. For example, ₹1,200,000 declared annual income versus ₹1,080,000 verified annual income produces a calculated absolute difference of ₹120,000, citing both documents. Calculations are labelled as derived interpretation, not source quotations. Different currencies, bare amounts without currency, annual versus monthly periods, and ambiguous multiple values in one document are never subtracted. No exchange rates, annualisation, ratios or risk scores are inferred. Gemini interpretations remain subject to evidence validation and human review.

Missing-information checks are restricted to fields applicable to the source's loan-document role. Loan applications, income verification, property valuation and credit review use separate checklists. A valuation report is not asked for income, and income verification is not asked for loan purpose. Licence number/expiry, revenue, profit, assets and liabilities are excluded from missing-field reports. Explicit blank/unavailable labels are quoted directly; blank fields cannot consume the next line as their value. If neither a label nor value is located, the result quotes a real source excerpt as explicitly labelled search context, never as proof of absence. Every new finding includes its source filename and a verbatim quotation with character offsets; page references are derived only from stored PDF extraction metadata. These scope-limited observations are not a regulatory completeness standard. Previously stored analyses remain snapshots; select **Analyze Documents** again to generate corrected results.

Limits: 1–10 unique ready documents, instructions of 1–4,000 characters, 100,000 total extracted characters, 12,000 characters per text line, 100 facts per document, 50 collective findings, and a 180-second run timeout. Oversized content is rejected explicitly; documents are never silently truncated or omitted. One analysis runs per API process at a time. Provider responses are schema-validated; raw provider errors, API keys and SQL details are not returned or logged.

Storage reuses `analysis_sessions`, `analysis_documents`, and `findings`; no schema changes are required. Each finding/source document is stored as a separate relational row with a shared group UUID. Severity, values and display order use the existing `structured_value` JSON column. Source evidence uses the existing `source_evidence` JSON column. The session's existing TEXT `summary` column stores a JSON envelope with summary text, instruction, provider, document coverage and limitations, versioned with `prompt_version=grounded-v1`. Session membership is created atomically; findings and completion status commit in a second transaction. Failure marks the session failed without saving partial findings. Document content remains unchanged.

Backend tests cover four-document analysis, instruction relevance, evidence/offset validation, source citations, missing information, malformed requests, readiness/content limits, Gemini structured-output handling, unsupported facts and failure safety. Frontend tests exercise submission of all four IDs, loading/errors/retry, source/severity display, copy, stale results and upload batches feeding analysis. Run both with `npm run test -w backend` and `npm run test -w frontend`.

To additionally verify real MySQL analysis persistence:

```powershell
$env:RUN_MYSQL_ANALYSIS_TESTS = '1'
npm run test -w backend
Remove-Item Env:RUN_MYSQL_ANALYSIS_TESTS
```

This opt-in test inserts four distinct synthetic documents and an analysis, verifies all four memberships, finding severity, exact evidence and the retrieval round trip, and retains records for inspection. It makes no DDL changes or deletions. MySQL integration tests stub Gemini before constructing the app, so even a locally configured Gemini mode cannot make a real provider call in those tests.

## Gemini configuration and fallback

Keep the existing database and frontend settings. Set these only in `backend/.env`, then restart the backend:

```dotenv
AI_MODE=gemini
GEMINI_API_KEY=replace_with_your_gemini_api_key
GEMINI_MODEL=gemini-3.1-flash-lite
```

Replace the key placeholder and use a model available to your account. The example model ID is configurable. `.env.example` contains placeholders only, and real `.env` files remain ignored by Git. Leave `AI_MODE=mock` for explicitly local rule-based analysis.

Set `AI_MODE=gemini` and use a model available to your Google account; keep the API key private in `backend/.env`. Restart the backend with `npm run dev -w backend` (or restart `npm run dev` for both apps). The updated development command watches `.env` and reloads it; production requires a restart. Startup logs show the configured provider/model without credentials.

If the model returns HTTP 404, the fallback reports `AI_MODEL_UNAVAILABLE`: update `GEMINI_MODEL` to an available model. Credentials alone do not enable Gemini; `AI_MODE` must be `gemini`. Previously saved/displayed analyses retain their original mode; run a new analysis after configuration changes.

To test manually, open http://localhost:5173, upload the synthetic sample documents, enter an instruction such as `Compare employment type in the loan application and income verification documents`, and click **Analyze Documents**. Successful Gemini analysis displays `Gemini · <your model>`; the network response from `POST /api/analysis` has `mode: "gemini"` and your configured `model`. If the UI shows `Mock / rule-based analysis` and a `Rule-based fallback (CODE)` summary, Gemini was unavailable or failed validation; expand Analysis scope & limitations for the safe reason. HTTP 201 alone does not prove Gemini was used, because a valid fallback also returns 201.

Automated verification from the repository root:

```powershell
npm run test -w backend
npm run test -w frontend
npm run typecheck
npm run build
```

The configured-mode tests exercise the same `createConfiguredAnalysisService` factory used by the app: `AI_MODE=gemini` sends the document text/instruction to an injected mock transport and returns validated Gemini results; `AI_MODE=mock` never contacts the provider even with credentials configured; mocked outages return a labelled fallback. These tests do not change `backend/.env` or validate your live key with Google.

The existing `GeminiAnalysisProvider` uses Google's backend REST API and JSON Schema output, then validates both the provider envelope and generated JSON with Zod. Each document/chunk and the current instruction are sent independently; collective analysis receives only validated, source-bound facts. Model-supplied filenames/page numbers are rejected by the fact schema. Existing comparison arithmetic, instruction scope, evidence validation and discrepancy rules remain authoritative. The existing API response and UI continue to render summaries, comparisons, discrepancies, missing information and source evidence.

`ResilientAnalysisService` adds a per-request fallback around the original service. Calls have a 45-second provider timeout within the existing overall analysis deadline. Missing/placeholder keys, network errors, rate limits, upstream errors, incomplete/malformed JSON, ungrounded quotations and invalid citations trigger a new complete rule-based run. The failed Gemini session stays failed; no partial findings are reused. A fallback response uses `mode=mock`, `model=null`, a visible `Rule-based fallback (CODE)` summary prefix, and a safe reason in `limitations`; the existing UI displays these without a design change. A successful Gemini response uses `mode=gemini` and the configured model. Gemini is attempted again on the next request after a transient failure; fallback mode is not sticky.

Validation, missing/unready documents, database/storage errors and other non-AI failures retain their existing status/error responses. If the fallback also fails, that error is returned normally. No raw provider error, key, local storage path or stack trace is included in results. Existing loading/error states handle both modes.

`npm run test -w backend` includes mocked Gemini success, strict JSON/evidence validation, invented quotation/page rejection, missing keys, authentication/rate-limit/outage responses, timeouts, whole-run fallback, provider recovery, file-only key loading and API response compatibility. All Gemini requests in tests use injected/stubbed transports; no live API calls are made. A real Gemini run requires your configured key and a currently available model and is intentionally not part of automated tests.

Production work remains: authentication and tenant isolation, rate limits, malware scanning, encrypted managed storage, retention controls, durable background jobs/recovery for interrupted upload/analysis records, request deadlines, and monitoring. A filesystem operation and SQL write cannot commit atomically; a crash can leave a retained file or a processing record that needs reconciliation. An infrastructure failure mid-batch can leave earlier files committed; retrying uploads is safe through duplicate checks. Analysis requests create a new run rather than resuming a timed-out run. Named locks protect upload writers using this repository; unrelated database writers must follow the same protocol. AI development assistance: OpenAI Codex.

## Deployment preparation

See [DEPLOYMENT.md](DEPLOYMENT.md) for Vercel frontend, Render Free backend with temporary `/tmp/uploads` storage, Aiven MySQL setup, production environment variables and exact commands. Production ignores local `.env` files and uses backend platform environment variables. No deployment has been performed.

Render Free may lose original uploads on restart, redeploy or spin-down. Metadata, extracted text and saved analysis results remain in Aiven MySQL when its connection is configured. The backend creates the temporary upload directory automatically; local upload behavior is unchanged. See the deployment guide for `MYSQL_URL` and verified TLS via `MYSQL_SSL_CA`.
