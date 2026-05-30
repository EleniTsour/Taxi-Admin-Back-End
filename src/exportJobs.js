import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import {
  MAX_EXPORT_EXCEL_ROWS,
  MAX_EXPORT_PDF_ROWS,
  countMatchingRides,
  fetchAllMatchingRides,
} from "./rideSearch.js";
import { buildCombinedVoucherPdfBuffer, buildExcelBuffer } from "./exportArtifacts.js";
import { renderVoucherPage } from "./pdfVoucher.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(MODULE_DIR, "../tmp/exports");
const EXPORT_JOB_RETENTION_HOURS = Math.max(1, Number.parseInt(process.env.EXPORT_JOB_RETENTION_HOURS, 10) || 24);
const EXPORT_JOB_RETENTION_MS = EXPORT_JOB_RETENTION_HOURS * 60 * 60 * 1000;
const EXPORT_CLEANUP_INTERVAL_MS = Math.max(60_000, Number.parseInt(process.env.EXPORT_CLEANUP_INTERVAL_MS, 10) || (15 * 60 * 1000));
const EXPORT_MAX_CONCURRENT_JOBS = Math.max(1, Number.parseInt(process.env.EXPORT_MAX_CONCURRENT_JOBS, 10) || 1);

export const EXPORT_LIMITS = {
  pdf: Math.max(1, Number.parseInt(process.env.EXPORT_PDF_LIMIT, 10) || MAX_EXPORT_PDF_ROWS || 3000),
  excel: Math.max(1, Number.parseInt(process.env.EXPORT_EXCEL_LIMIT, 10) || MAX_EXPORT_EXCEL_ROWS || 10000),
};

const EXPORT_MIME_TYPES = {
  pdf: "application/pdf",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const EXPORT_FILE_EXTENSIONS = {
  pdf: "pdf",
  excel: "xlsx",
};

const EXPORT_FILE_PREFIXES = {
  pdf: "rides_vouchers",
  excel: "rides_report",
};

let setupPromise = null;
let maintenanceStarted = false;
let activeJobs = 0;

function normalizeExportType(type) {
  const normalized = String(type ?? "").trim().toLowerCase();
  if (normalized === "pdf" || normalized === "excel") return normalized;
  return "";
}

function normalizeExportQuery(query = {}) {
  const normalized = {};
  const raw = query ?? {};
  const mappings = [
    ["from", "from"],
    ["to", "to"],
    ["from_location", "from_location"],
    ["to_location", "to_location"],
    ["tour_oper", "tour_oper"],
    ["driver", "driver"],
    ["sortBy", "sortBy"],
    ["sortDir", "sortDir"],
  ];

  for (const [fromKey, toKey] of mappings) {
    const value = String(raw[fromKey] ?? "").trim();
    if (value) normalized[toKey] = value;
  }

  if (!normalized.sortBy) normalized.sortBy = "THE_DATE";
  if (!normalized.sortDir) normalized.sortDir = "asc";
  return normalized;
}

function hashQuery(userId, type, query) {
  return createHash("sha256")
    .update(JSON.stringify({ userId: String(userId ?? ""), type, query }))
    .digest("hex");
}

function toPublicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.export_type,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    errorMessage: row.error_message,
    fileName: row.file_name,
    mimeType: row.mime_type,
    resultCount: row.result_count == null ? null : Number(row.result_count),
    limitValue: row.limit_value == null ? null : Number(row.limit_value),
    ready: row.status === "completed",
  };
}

async function ensureInfrastructure() {
  if (!setupPromise) {
    setupPromise = (async () => {
      try {
        await fs.mkdir(EXPORT_DIR, { recursive: true });
        await pool.query(`
          CREATE TABLE IF NOT EXISTS export_jobs (
            id VARCHAR(64) NOT NULL PRIMARY KEY,
            export_type VARCHAR(16) NOT NULL,
            status VARCHAR(16) NOT NULL,
            created_by_user_id BIGINT NULL,
            created_by_email VARCHAR(255) NULL,
            query_json TEXT NOT NULL,
            query_hash CHAR(64) NOT NULL,
            result_count INT NULL,
            limit_value INT NULL,
            file_name VARCHAR(255) NULL,
            file_path VARCHAR(512) NULL,
            mime_type VARCHAR(128) NULL,
            file_size_bytes BIGINT NULL,
            error_message TEXT NULL,
            created_at DATETIME(3) NOT NULL,
            started_at DATETIME(3) NULL,
            completed_at DATETIME(3) NULL,
            failed_at DATETIME(3) NULL,
            INDEX idx_export_jobs_user_hash_status (created_by_user_id, query_hash, status),
            INDEX idx_export_jobs_status_created (status, created_at)
          )
        `);
        await pool.query(`
          UPDATE export_jobs
          SET status = 'failed',
              error_message = COALESCE(error_message, 'Export interrupted because the server restarted before completion.'),
              failed_at = COALESCE(failed_at, UTC_TIMESTAMP(3))
          WHERE status = 'processing'
        `);
      } catch (err) {
        console.error(
          "Export job infrastructure initialization failed. The database user may be missing CREATE/ALTER privileges for the export_jobs table.",
          err,
        );
        throw err;
      }
    })();
  }
  return setupPromise;
}

async function cleanupExpiredJobs() {
  await ensureInfrastructure();
  const cutoffIso = new Date(Date.now() - EXPORT_JOB_RETENTION_MS).toISOString().slice(0, 19).replace("T", " ");
  const [rows] = await pool.query(
    `
      SELECT id, file_path
      FROM export_jobs
      WHERE status IN ('completed', 'failed')
        AND created_at < ?
    `,
    [cutoffIso],
  );

  for (const row of rows) {
    const filePath = String(row.file_path ?? "").trim();
    if (filePath) {
      await fs.unlink(filePath).catch(() => {});
    }
  }

  await pool.query(
    `
      DELETE FROM export_jobs
      WHERE status IN ('completed', 'failed')
        AND created_at < ?
    `,
    [cutoffIso],
  );
}

async function claimNextPendingJob() {
  const [rows] = await pool.query(
    `
      SELECT *
      FROM export_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `,
  );
  const job = rows?.[0];
  if (!job) return null;

  const [result] = await pool.query(
    `
      UPDATE export_jobs
      SET status = 'processing',
          started_at = UTC_TIMESTAMP(3),
          error_message = NULL,
          failed_at = NULL
      WHERE id = ?
        AND status = 'pending'
      LIMIT 1
    `,
    [job.id],
  );

  if (!result?.affectedRows) return null;
  job.status = "processing";
  job.started_at = new Date().toISOString();
  return job;
}

async function markJobFailed(jobId, errorMessage) {
  await pool.query(
    `
      UPDATE export_jobs
      SET status = 'failed',
          error_message = ?,
          failed_at = UTC_TIMESTAMP(3)
      WHERE id = ?
      LIMIT 1
    `,
    [String(errorMessage ?? "Export failed."), jobId],
  );
}

async function markJobCompleted(jobId, fileInfo) {
  await pool.query(
    `
      UPDATE export_jobs
      SET status = 'completed',
          file_name = ?,
          file_path = ?,
          mime_type = ?,
          file_size_bytes = ?,
          completed_at = UTC_TIMESTAMP(3),
          error_message = NULL
      WHERE id = ?
      LIMIT 1
    `,
    [fileInfo.fileName, fileInfo.filePath, fileInfo.mimeType, fileInfo.fileSizeBytes, jobId],
  );
}

async function processJob(job) {
  const type = normalizeExportType(job.export_type);
  const limitValue = Number(job.limit_value ?? EXPORT_LIMITS[type]);
  const query = JSON.parse(String(job.query_json ?? "{}"));
  const result = await fetchAllMatchingRides(query, limitValue);
  let filePath = "";

  try {
    let fileBuffer;
    let mimeType;
    if (type === "pdf") {
      fileBuffer = await buildCombinedVoucherPdfBuffer(result.rows, renderVoucherPage);
      mimeType = EXPORT_MIME_TYPES.pdf;
    } else {
      fileBuffer = buildExcelBuffer(result.rows);
      mimeType = EXPORT_MIME_TYPES.excel;
    }

    const datePart = new Date().toISOString().slice(0, 10);
    const extension = EXPORT_FILE_EXTENSIONS[type];
    const fileName = `${EXPORT_FILE_PREFIXES[type]}_${datePart}_${job.id}.${extension}`;
    filePath = path.join(EXPORT_DIR, fileName);

    await fs.writeFile(filePath, fileBuffer);
    await markJobCompleted(job.id, {
      fileName,
      filePath,
      mimeType,
      fileSizeBytes: fileBuffer.length,
    });
  } catch (err) {
    if (filePath) {
      await fs.unlink(filePath).catch(() => {});
    }
    throw err;
  }
}

async function pumpQueue() {
  await ensureInfrastructure();
  while (activeJobs < EXPORT_MAX_CONCURRENT_JOBS) {
    const nextJob = await claimNextPendingJob();
    if (!nextJob) break;

    activeJobs += 1;
    void (async () => {
      try {
        await processJob(nextJob);
      } catch (err) {
        await markJobFailed(nextJob.id, err?.message || "Export failed.");
      } finally {
        activeJobs = Math.max(0, activeJobs - 1);
        void pumpQueue().catch((error) => {
          console.error("Export queue pump failed", error);
        });
      }
    })();
  }
}

export async function initExportJobService() {
  await ensureInfrastructure();
  if (!maintenanceStarted) {
    maintenanceStarted = true;
    setInterval(() => {
      void cleanupExpiredJobs().catch((err) => {
        console.error("Export job cleanup failed", err);
      });
    }, EXPORT_CLEANUP_INTERVAL_MS);

    setInterval(() => {
      void pumpQueue().catch((err) => {
        console.error("Export queue pump failed", err);
      });
    }, 2000);
  }

  await cleanupExpiredJobs();
  await pumpQueue();
}

export async function createExportJob({ type, query, user }) {
  await ensureInfrastructure();

  const normalizedType = normalizeExportType(type);
  if (!normalizedType) {
    const err = new Error("Unsupported export type.");
    err.status = 400;
    throw err;
  }

  const normalizedQuery = normalizeExportQuery(query);
  const limitValue = EXPORT_LIMITS[normalizedType];
  const resultCount = await countMatchingRides(normalizedQuery);
  if (resultCount <= 0) {
    const err = new Error("No rides matched the current filters.");
    err.status = 400;
    throw err;
  }
  if (resultCount > limitValue) {
    const err = new Error(`Export is limited to ${limitValue} rides. Please narrow the filters and try again.`);
    err.status = 413;
    err.limit = limitValue;
    err.total = resultCount;
    throw err;
  }

  const userId = user?.userId ?? null;
  const queryHash = hashQuery(userId, normalizedType, normalizedQuery);
  const [existingRows] = await pool.query(
    `
      SELECT *
      FROM export_jobs
      WHERE created_by_user_id <=> ?
        AND export_type = ?
        AND query_hash = ?
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId, normalizedType, queryHash],
  );
  if (existingRows?.[0]) {
    return toPublicJob(existingRows[0]);
  }

  const id = randomUUID();
  const createdAt = new Date();
  await pool.query(
    `
      INSERT INTO export_jobs (
        id, export_type, status, created_by_user_id, created_by_email,
        query_json, query_hash, result_count, limit_value, created_at
      ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      normalizedType,
      userId,
      String(user?.email ?? "").trim() || null,
      JSON.stringify(normalizedQuery),
      queryHash,
      resultCount,
      limitValue,
      createdAt.toISOString().slice(0, 23).replace("T", " "),
    ],
  );

  await pumpQueue();
  return toPublicJob({
    id,
    export_type: normalizedType,
    status: "pending",
    created_at: createdAt.toISOString(),
    started_at: null,
    completed_at: null,
    failed_at: null,
    error_message: null,
    file_name: null,
    mime_type: null,
    result_count: resultCount,
    limit_value: limitValue,
  });
}

export async function getExportJob(jobId, user) {
  await ensureInfrastructure();
  const [rows] = await pool.query(
    `
      SELECT *
      FROM export_jobs
      WHERE id = ?
        AND created_by_user_id <=> ?
      LIMIT 1
    `,
    [String(jobId ?? ""), user?.userId ?? null],
  );
  return toPublicJob(rows?.[0] ?? null);
}

export async function getExportDownload(jobId, user) {
  await ensureInfrastructure();
  const [rows] = await pool.query(
    `
      SELECT *
      FROM export_jobs
      WHERE id = ?
        AND created_by_user_id <=> ?
      LIMIT 1
    `,
    [String(jobId ?? ""), user?.userId ?? null],
  );
  const job = rows?.[0];
  if (!job) {
    const err = new Error("Export job not found.");
    err.status = 404;
    throw err;
  }
  if (job.status !== "completed") {
    const err = new Error("Export file is not ready yet.");
    err.status = 409;
    throw err;
  }

  const filePath = String(job.file_path ?? "").trim();
  if (!filePath) {
    const err = new Error("Export file metadata is missing.");
    err.status = 500;
    throw err;
  }

  await fs.access(filePath);
  return {
    filePath,
    fileName: String(job.file_name ?? ""),
    mimeType: String(job.mime_type ?? "application/octet-stream"),
  };
}
