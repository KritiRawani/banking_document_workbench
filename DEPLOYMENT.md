# Deployment preparation: banking_document_workbench

No service has been deployed. Project name: `banking_document_workbench`; MySQL database: `document_workbench`.

## Repository and runtime

The repository is an npm workspace with a shared root `package-lock.json`:

- `frontend/`: React, TypeScript, Vite and Tailwind; build output `frontend/dist`.
- `backend/`: Express, TypeScript, mysql2 pool, PDF/TXT extraction and Gemini/rule-based analysis; output `backend/dist`.
- `backend/database/schema.sql`: existing manual schema; never run automatically at startup.
- `vercel.json`: static frontend build settings, from repository root.
- `render.yaml`: backend template, from repository root; Render Free, temporary uploads, automatic deployments disabled.

Use Node 24 (at least 24.13.0, required by the current dependencies). The Render template pins 24.22.1; select Node 24.x in Vercel. Keep both services' Root Directory at the repository root, not the individual workspace. This preserves access to the shared lockfile.

## 1. Aiven MySQL (when deployment is authorized)

1. Provision/use Aiven for MySQL, compatible with the existing MySQL 8 schema. Create a database named `document_workbench` in Aiven Console (do not use the default `defaultdb` name for this app).
2. Copy the service host, port, username and password privately. Download the service/project CA certificate from Aiven Console. Configure network access to permit the Render backend to connect.
3. In MySQL Workbench connect to that host and port using SSL mode **Require and Verify Identity** with the downloaded CA certificate. Never disable certificate verification.
4. For a NEW database, review and manually run `backend/database/schema.sql` with an authorized administrator. It defines the existing `documents`, `analysis_sessions`, `analysis_documents`, and `findings` tables. For an existing database, inspect `SHOW TABLES` and `SHOW CREATE TABLE` first; `IF NOT EXISTS` does not migrate incompatible definitions. No schema is executed by application startup or builds.
5. Verify with read-only queries:

```sql
USE document_workbench;
SELECT DATABASE();
SHOW TABLES;
```

Use a dedicated application account with SELECT, INSERT and UPDATE on the existing tables (the app also uses MySQL named locks). Keep administrator credentials for setup only. The runtime account does not need CREATE or DROP privileges.

Set these private/backend values in Render:

```text
MYSQL_URL=mysql://APP_USER:URL_ENCODED_PASSWORD@AIVEN_SERVICE_HOST:AIVEN_SERVICE_PORT/document_workbench
MYSQL_SSL_CA=<full Aiven CA PEM certificate>
```

The URL must end in `/document_workbench`; replace a copied `/defaultdb` suffix only after creating the correct database. URL-encode special characters in credentials. Paste the CA as a multiline environment variable; escaped `\n` newlines are also supported. With `MYSQL_SSL_CA` set, mysql2 uses TLS with certificate verification (`rejectUnauthorized: true`). Do not add a URL option that disables SSL verification. Local MySQL settings remain unchanged when no CA is configured. Neither the URL nor certificate is hardcoded. Do not put database secrets in Vercel.

Aiven persists document metadata, extracted text, hashes, processing status, analysis membership, findings and source evidence independently of Render's temporary filesystem. Render restarts do not delete these database records. Keep the Aiven service/database available and manage backups there; moving from another MySQL provider requires a separate authorized data migration. This change does not migrate or connect to an Aiven account automatically.

## 2. Render backend

Create a Node Web Service from the repository only when authorized. Use the root-level `render.yaml` as the configuration reference or fill in the following settings manually. The template selects `plan: free` and has no persistent disk. It does not deploy by itself.

| Setting | Value |
| --- | --- |
| Root Directory | repository root (leave blank) |
| Build Command | `npm ci --include=dev && npm run build -w backend` |
| Start Command | `npm run start -w backend` |
| Health Check Path | `/api/health/db` |
| Node version | `24.22.1` |
| Instance plan | Free |
| Upload directory | `/tmp/uploads` (ephemeral; no disk attachment) |
| Automatic deployments | Off during preparation |

`--include=dev` installs TypeScript even when NODE_ENV is production. No Vite dev server or tsx watcher is used to serve production traffic. Render supplies `PORT`; the backend reads it and listens on `0.0.0.0`. Do not hardcode Render's port.

Set these variables in Render's backend Environment panel:

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24.22.1` |
| `PORT` | supplied by Render |
| `CLIENT_ORIGIN` | `https://YOUR-FRONTEND.vercel.app` (exact origin, no path or trailing slash) |
| `MYSQL_URL` | Aiven service URL ending `/document_workbench` |
| `MYSQL_SSL_CA` | Full Aiven CA certificate (PEM) for verified TLS |
| `AI_MODE` | `gemini` (or `mock` for deterministic analysis) |
| `GEMINI_API_KEY` | private Google API key |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite`, or an available compatible model for your account |
| `UPLOAD_DIR` | `/tmp/uploads` |

Production ignores local `.env` files and reads backend platform environment variables. Local development retains existing `backend/.env` precedence and file-only credential loading. Never set a database URL or Gemini key as a `VITE_` variable.

CORS already uses `CLIENT_ORIGIN`: set it to the actual stable Vercel origin. Other browser origins do not receive matching access permission. This is not authentication. Preview deployments have different origins; use a separate staging backend if needed instead of a wildcard. Changing the environment requires a production service restart/redeploy.

### Upload persistence

The existing route stays `POST /api/documents/upload`, multipart field `files`, up to five PDF/TXT files, 10 MiB each. Existing validation, hashing, duplicates, parsing worker, errors and evidence logic remain unchanged. Staged and retained files share `UPLOAD_DIR`, so atomic file moves stay on the same disk. Stored names are random keys; uploaded files are not publicly served and local paths are not returned.

On Render Free, `UPLOAD_DIR=/tmp/uploads` is temporary. The backend recursively creates this directory on the first upload if it does not exist. Originals may be lost when the service restarts, redeploys, or spins down. No original-file durability is promised. Keep your own copies of the synthetic documents. Local development still defaults to `backend/uploads` unless `UPLOAD_DIR` is explicitly configured.

Extracted text, metadata and completed analysis results remain in Aiven MySQL. Existing analysis reads stored extracted text from MySQL rather than reopening original files, so losing temporary originals does not erase saved findings or their quotations. Content-hash duplicate detection still reuses the existing database record; uploading the same bytes again does not guarantee the original file is recreated. Preserving originals permanently would require a separate object-storage feature, outside this change. Scanned/encrypted PDFs remain unsupported as before.

Render Free services can spin down after inactivity and take time to wake up. Retry requests after startup if needed; existing UI timeouts are unchanged. Monitor temporary storage and database limits. Render Free does not provide a persistent disk or interactive shell access.

## 3. Vercel frontend

Import the same repository with Root Directory at the repository root. `vercel.json` sets:

| Setting | Value |
| --- | --- |
| Framework | Vite |
| Install Command | `npm ci --include=dev` |
| Build Command | `npm run build -w frontend` |
| Output Directory | `frontend/dist` |
| Node version | select 24.x |

Set the single public frontend variable before building:

```text
VITE_API_BASE_URL=https://YOUR-BACKEND.onrender.com/api
```

Include `/api` and use HTTPS. Vite embeds this value at build time, so rebuild after changing it. The app already reads this variable; no frontend source or UI design change is needed. The production browser calls Render directly, avoiding serverless proxy/upload time limits. Never use localhost in the deployed frontend's value. Set the resulting Vercel origin as Render's `CLIENT_ORIGIN`. Placeholder URLs in this guide must be replaced with assigned URLs.

## 4. Verification before and after deployment

Local checks from repository root:

```text
npm ci --include=dev
npm run typecheck
npm run test -w backend
npm run test -w frontend
npm run build
```

Optional local MySQL integration tests (PowerShell, with local backend/.env configured):

```powershell
$env:RUN_MYSQL_ANALYSIS_TESTS='1'
$env:RUN_MYSQL_UPLOAD_TESTS='1'
npm run test -w backend
```

These tests add synthetic records/files to the configured local database; they never recreate/drop tables. All Gemini calls in automated tests are mocked. Production configuration tests use synthetic injected environment variables and do not contact Aiven or Google.

After deployment is authorized and performed:

1. GET `https://YOUR-BACKEND.onrender.com/api/health` should return HTTP 200, `status: ok`.
2. GET `/api/health/db` should return HTTP 200 with `databaseName: document_workbench`; otherwise inspect the sanitized connection error. Health checks verify connectivity, not complete schema compatibility.
3. Open Vercel, upload synthetic PDF/TXT files and inspect the browser Network panel. Confirm correct Render URL, successful preflight/CORS and processing results. Test duplicates and invalid files as before.
4. Restart the backend: temporary original files may be gone. Verify that existing analysis results can still be retrieved from Aiven MySQL, and new uploads recreate `/tmp/uploads`.
5. Analyze the four synthetic documents for employment type. For a successful real provider run, `POST /api/analysis` returns `mode: gemini`, the configured model, matching Salaried values and source quotations. HTTP 201 alone is insufficient: a labelled fallback also returns 201. Upstream outages, rate limits or invalid evidence still trigger the existing labelled rule-based fallback.
6. Use `/api/health/db` to check the deployed database connection. Render Free has no interactive shell. The compiled read-only test `node backend/dist/scripts/test-db.js` can be run from a separately configured environment with the private backend environment variables; never put credentials into command arguments.

No production account, Aiven connectivity or Vercel domain has been verified during this local preparation. Those checks require the actual resources and deployment authorization.

## Secrets and operational scope

`.env`, `.env.*` (except `.env.example`), `node_modules`, build outputs, uploads, `.vercel`, private-key files and logs are ignored. Templates contain placeholders only. Do not commit provider exports, database dumps, uploaded documents containing sensitive information, or credentials in URLs. Check `git status` before pushing; ignore rules do not untrack previously committed secrets.

This is deployment preparation for the existing synthetic-data assessment. Existing unauthenticated endpoints and per-process concurrency controls are unchanged. Production banking/customer use still requires authentication/authorization, tenant isolation, audited access, rate limiting, retention policies, encrypted transport/storage and operational monitoring. Those are separate feature/security work, not introduced by this deployment-only change.

## Platform references

- [Render web services and port binding](https://render.com/docs/web-services)
- [Render Free limits and ephemeral filesystem](https://render.com/docs/free)
- [Render Node versions](https://render.com/docs/node-version)
- [Aiven MySQL connections](https://aiven.io/docs/products/mysql/howto/list-code-samples)
- [Aiven TLS certificates](https://aiven.io/docs/platform/concepts/tls-ssl-certificates)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vite production build](https://vite.dev/guide/build)
