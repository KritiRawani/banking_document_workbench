-- Initial schema for MySQL 8.0.16+ (including MySQL 8.4).
-- Run manually in MySQL Workbench; the backend does not execute this file.
-- Synthetic assessment documents only. No credentials or sample data are included.
-- IF NOT EXISTS allows repeat runs but does not migrate existing table definitions.

CREATE DATABASE IF NOT EXISTS document_workbench
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE document_workbench;

-- Store files under server-generated storage keys, never user-supplied paths.
-- The original filename is display metadata only. SHA-256 identifies file content.
CREATE TABLE IF NOT EXISTS documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  original_filename VARCHAR(255) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  mime_type VARCHAR(127) NOT NULL,
  file_size_bytes BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  processing_status ENUM('uploaded', 'processing', 'ready', 'failed')
    NOT NULL DEFAULT 'uploaded',
  extracted_text LONGTEXT NULL,
  extraction_metadata JSON NULL COMMENT 'Parser/version, page count, OCR usage, and extraction warnings',
  error_message TEXT NULL COMMENT 'Sanitized user-facing processing error; no secrets or stack traces',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_storage_key (storage_key),
  KEY idx_documents_sha256 (sha256),
  KEY idx_documents_created_at (created_at),
  CONSTRAINT chk_documents_file_size CHECK (file_size_bytes > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS analysis_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  instruction TEXT NOT NULL,
  status ENUM('pending', 'processing', 'completed', 'failed')
    NOT NULL DEFAULT 'pending',
  ai_mode ENUM('mock', 'gemini') NOT NULL DEFAULT 'mock',
  ai_model VARCHAR(128) NULL,
  prompt_version VARCHAR(64) NULL,
  summary TEXT NULL COMMENT 'Generated interpretation, not a verified source fact',
  error_message TEXT NULL COMMENT 'Sanitized error only',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_analysis_sessions_created_at (created_at),
  CONSTRAINT chk_analysis_sessions_instruction
    CHECK (CHAR_LENGTH(TRIM(instruction)) > 0)
) ENGINE=InnoDB;

-- Many-to-many membership preserves document boundaries and enables reuse.
-- After analysis starts, the application must keep membership and extracted
-- document content immutable (or create a new document/session for a new version).
CREATE TABLE IF NOT EXISTS analysis_documents (
  analysis_session_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (analysis_session_id, document_id),
  KEY idx_analysis_documents_document_id (document_id),
  CONSTRAINT fk_analysis_documents_session
    FOREIGN KEY (analysis_session_id) REFERENCES analysis_sessions (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_documents_document
    FOREIGN KEY (document_id) REFERENCES documents (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- One row per finding/source document. For a cross-document finding, insert
-- a row for each relevant document using the same application-generated UUID
-- in finding_group_id. This keeps every source relationally traceable.
-- The composite FK prevents citing documents outside the analysis session.
CREATE TABLE IF NOT EXISTS findings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  analysis_session_id BIGINT UNSIGNED NOT NULL,
  source_document_id BIGINT UNSIGNED NOT NULL,
  finding_group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  finding_type ENUM('comparison', 'summary', 'discrepancy', 'missing_information', 'key_value')
    NOT NULL,
  content_kind ENUM('extracted_fact', 'ai_interpretation') NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  structured_value JSON NULL COMMENT 'Typed extracted value; represent money as decimal strings with currency',
  source_evidence JSON NOT NULL COMMENT 'Array of evidence objects belonging only to source_document_id',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_findings_session_source (analysis_session_id, source_document_id),
  KEY idx_findings_session_group (analysis_session_id, finding_group_id),
  CONSTRAINT fk_findings_analysis_document
    FOREIGN KEY (analysis_session_id, source_document_id)
    REFERENCES analysis_documents (analysis_session_id, document_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_findings_evidence_array
    CHECK (JSON_TYPE(source_evidence) = 'ARRAY'),
  CONSTRAINT chk_findings_fact_evidence
    CHECK (content_kind <> 'extracted_fact' OR JSON_LENGTH(source_evidence) > 0)
) ENGINE=InnoDB;

-- source_evidence examples (documentation only, not inserted):
-- PDF: [{"quote":"Annual revenue: INR 2500000","page":2}]
-- CSV: [{"quote":"2025,2500000","row":3,"column":"revenue"}]
-- Text: [{"quote":"Licence expires 2027-03-31","char_start":120,"char_end":146}]
-- Character offsets are zero-based, end-exclusive, in the stored extracted_text;
-- page and CSV row numbers are one-based. CSV rows include the header row.
-- Missing-information findings may use [] because absence has no verbatim quote;
-- classify these as ai_interpretation and explain the searched scope in description.
-- Application validation must enforce evidence object shape, locator ranges,
-- exact quote matching, and evidence/value consistency before persisting output.
-- Keep timestamps in UTC by configuring the application's MySQL session timezone.
-- RESTRICT protects provenance from accidental deletion; retention/purge workflows
-- must explicitly delete dependent records in order and remove stored files.
