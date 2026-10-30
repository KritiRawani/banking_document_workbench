# Deployment preparation: banking_document_workbench

No service has been deployed. Project name: `banking_document_workbench`; MySQL database: `document_workbench`.

## Repository and runtime

The repository is an npm workspace with a shared root `package-lock.json`:

- `frontend/`: React, TypeScript, Vite and Tailwind; build output `frontend/dist`.
- `backend/`: Express, TypeScript, mysql2 pool, PDF/TXT extraction and Gemini/rule-based analysis; output `backend/dist`.
- `backend/database/schema.sql`: existing manual schema; never run automatically at startup.
- `vercel.json`: static frontend build settings, from repository root.
- `render.yaml`: backend template, from repository root; paid disk, automatic deployments disabled.

Use Node 24 (at least 24.13.0, required by the current dependencies). The Render template pins 24.22.1; select Node 24.x in Vercel. Keep both services' Root Directory at the repository root, not the individual workspace. This preserves access to the shared lockfile.

## 1. Railway MySQL (when deployment is authorized)

1. Add a MySQL service with persistent storage, compatible with MySQL 8.0.16+ (schema uses MySQL 8 JSON, checks and `utf8mb4_0900_ai_ci`).
2. Set `MYSQL_DATABASE=document_workbench` before initial provisioning where supported. On an already initialized Railway service, changing this variable does not rename/create the existing database; the existing schema script creates `document_workbench` when run by an authorized database administrator.
3. Enable public TCP access. Render is outside Railway's private network: use the public TCP proxy host and port, not `mysql.railway.internal`.
4. In MySQL Workbench create a Standard TCP/IP connection with that public host, port and Railway credentials. Do not put passwords in shell commands, screenshots, Git or this guide.
5. For a NEW database, open `backend/database/schema.sql`, review it, and execute it manually. It creates the four existing tables: `documents`, `analysis_sessions`, `analysis_documents`, `findings`. It contains no DROP statements. For an existing database, inspect `SHOW TABLES` and `SHOW CREATE TABLE` first; `IF NOT EXISTS` does not migrate incompatible definitions. Back up existing data before any administrative change.
6. Verify using read-only queries:

```sql
USE document_workbench;
SELECT DATABASE();
SHOW TABLES;
```

Create/use a dedicated application account with SELECT, INSERT and UPDATE on these tables (current application also uses MySQL named locks). The runtime account does not need CREATE or DROP. Keep administrator credentials for manual setup only.

Set Render's `MYSQL_URL` to the external/public connection string with database `/document_workbench`:

```text
mysql://APP_USER:URL_ENCODED_PASSWORD@PUBLIC_TCP_HOST:PUBLIC_TCP_PORT/document_workbench
```

Railway may expose this as `MYSQL_PUBLIC_URL`; inspect its database suffix before using it. This application deliberately rejects another database name. URL-encode special characters in credentials. No Railway secrets belong in Vercel. Public TCP proxying alone does not establish MySQL TLS: verify the provisioned database's transport/security capabilities before using sensitive data. This preparation retains the existing mysql2 connection behavior.

## 2. Render backend

Create a Node Web Service from the repository only when authorized. Use the root-level `render.yaml` as the configuration reference or fill in the following settings manually. The template requires a paid service with a persistent disk. It does not deploy by itself.

| Setting | Value |
| --- | --- |
| Root Directory | repository root (leave blank) |
| Build Command | `npm ci --include=dev && npm run build -w backend` |
| Start Command | `npm run start -w backend` |
| Health Check Path | `/api/health/db` |
| Node version | `24.22.1` |
| Disk mount | `/var/data` (1 GB initially; monitor usage) |
| Automatic deployments | Off during preparation |

`--include=dev` installs TypeScript even when NODE_ENV is production. No Vite dev server or tsx watcher is used to serve production traffic. Render supplies `PORT`; the backend reads it and listens on `0.0.0.0`. Do not hardcode Render's port.

Set these variables in Render's backend Environment panel:

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24.22.1` |
| `PORT` | supplied by Render |
| `CLIENT_ORIGIN` | `https://YOUR-FRONTEND.vercel.app` (exact origin, no path or trailing slash) |
| `MYSQL_URL` | Railway public TCP URL ending `/document_workbench` |
| `AI_MODE` | `gemini` (or `mock` for deterministic analysis) |
| `GEMINI_API_KEY` | private Google API key |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite`, or an available compatible model for your account |
| `UPLOAD_DIR` | `/var/data/uploads` |

Production ignores local `.env` files and reads backend platform environment variables. Local development retains existing `backend/.env` precedence and file-only credential loading. Never set a database URL or Gemini key as a `VITE_` variable.

CORS already uses `CLIENT_ORIGIN`: set it to the actual stable Vercel origin. Other browser origins do not receive matching access permission. This is not authentication. Preview deployments have different origins; use a separate staging backend if needed instead of a wildcard. Changing the environment requires a production service restart/redeploy.

### Upload persistence

The existing route stays `POST /api/documents/upload`, multipart field `files`, up to five PDF/TXT files, 10 MiB each. Existing validation, hashing, duplicates, parsing worker, errors and evidence logic remain unchanged. Staged and retained files share `UPLOAD_DIR`, so atomic file moves stay on the same disk. Stored names are random keys; uploaded files are not publicly served and local paths are not returned.

Mount persistent storage at `/var/data` and point `UPLOAD_DIR` to its `uploads` child. Without a mounted disk, Render's ephemeral filesystem loses uploads after replacement/restart even though extracted text/metadata remain in MySQL. Keep a single backend instance with the current disk-based design. When moving existing data, copy original files by their existing storage keys together with the corresponding database records; a database-only copy does not copy files. Back up both Railway data and Render disk, and monitor capacity. Scanned/encrypted PDFs remain unsupported as before.

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

These tests add synthetic records/files to the configured local database; they never recreate/drop tables. All Gemini calls in automated tests are mocked. Production configuration tests use synthetic injected environment variables and do not contact Railway or Google.

After deployment is authorized and performed:

1. GET `https://YOUR-BACKEND.onrender.com/api/health` should return HTTP 200, `status: ok`.
2. GET `/api/health/db` should return HTTP 200 with `databaseName: document_workbench`; otherwise inspect the sanitized connection error. Health checks verify connectivity, not complete schema compatibility.
3. Open Vercel, upload synthetic PDF/TXT files and inspect the browser Network panel. Confirm correct Render URL, successful preflight/CORS and processing results. Test duplicates and invalid files as before.
4. Restart the backend and confirm stored files remain on the mounted disk and existing analysis results can be retrieved.
5. Analyze the four synthetic documents for employment type. For a successful real provider run, `POST /api/analysis` returns `mode: gemini`, the configured model, matching Salaried values and source quotations. HTTP 201 alone is insufficient: a labelled fallback also returns 201. Upstream outages, rate limits or invalid evidence still trigger the existing labelled rule-based fallback.
6. To perform the existing read-only connection test on a running Render shell without tsx, use `node dist/scripts/test-db.js` from `backend/` (or `node backend/dist/scripts/test-db.js` from the repository root).

No production account, Railway connectivity, Vercel domain or Render disk has been verified during this local preparation. Those checks require the actual resources and deployment authorization.

## Secrets and operational scope

`.env`, `.env.*` (except `.env.example`), `node_modules`, build outputs, uploads, `.vercel`, private-key files and logs are ignored. Templates contain placeholders only. Do not commit provider exports, database dumps, uploaded documents containing sensitive information, or credentials in URLs. Check `git status` before pushing; ignore rules do not untrack previously committed secrets.

This is deployment preparation for the existing synthetic-data assessment. Existing unauthenticated endpoints and per-process concurrency controls are unchanged. Production banking/customer use still requires authentication/authorization, tenant isolation, audited access, rate limiting, retention policies, encrypted transport/storage and operational monitoring. Those are separate feature/security work, not introduced by this deployment-only change.

## Platform references

- [Render web services and port binding](https://render.com/docs/web-services)
- [Render persistent disks](https://render.com/docs/disks)
- [Render Node versions](https://render.com/docs/node-version)
- [Railway MySQL and public TCP access](https://docs.railway.com/databases/mysql)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vite production build](https://vite.dev/guide/build)
