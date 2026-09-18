import { pool } from "./db.js";

export const MAX_FINANCE_PAGE_SIZE = 500;

let setupPromise = null;

// This follows the application's existing runtime table-bootstrap convention
// (used by export_jobs), while exactly matching the established finance table.
export async function ensureFinanceInfrastructure() {
  if (!setupPromise) {
    setupPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS finance (
        \`AA\` INT NOT NULL AUTO_INCREMENT,
        \`TOUR_OPER\` VARCHAR(255) NOT NULL,
        \`THE_DATE\` DATE NOT NULL,
        \`CHARGE\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`PAYMENT\` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        \`NOTES\` TEXT NULL,
        PRIMARY KEY (\`AA\`),
        INDEX idx_finance_tour_date (\`TOUR_OPER\`, \`THE_DATE\`)
      )
    `).catch((err) => {
      setupPromise = null;
      throw err;
    });
  }
  return setupPromise;
}

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export function normalizeFinanceDate(value, fieldName = "Date") {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw validationError(`${fieldName} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw validationError(`${fieldName} must be a valid YYYY-MM-DD date.`);
  }
  return date;
}

export function normalizeEuroAmount(value, fieldName) {
  const amount = String(value ?? "").trim();
  if (!amount) return "0.00";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(amount)) {
    throw validationError(`${fieldName} must be a non-negative euro amount with up to two decimal places.`);
  }
  // Keep money as a decimal string: converting through Number would lose the
  // fixed-precision guarantee before the DECIMAL column receives it.
  return amount;
}

export async function normalizeTourOperator(value) {
  const tourOperator = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!tourOperator) throw validationError("Tour Operator is required.");

  // `prices.Tour` is the existing canonical source for Tour Operators. There
  // is no separate operator-id entity in this database, so store its canonical
  // value rather than creating a parallel list.
  const [rows] = await pool.query(
    "SELECT `Tour` AS tourOperator FROM prices WHERE LOWER(TRIM(`Tour`)) = LOWER(TRIM(?)) LIMIT 1",
    [tourOperator],
  );
  const canonicalValue = String(rows?.[0]?.tourOperator ?? "").trim();
  if (!canonicalValue) throw validationError("Tour Operator does not exist.");
  return canonicalValue;
}

export function normalizeFinanceEntry(body) {
  const notes = body?.notes == null ? null : String(body.notes).trim();

  return {
    date: normalizeFinanceDate(body?.date),
    charge: normalizeEuroAmount(body?.charge, "Charge"),
    payment: normalizeEuroAmount(body?.payment, "Payment"),
    notes: notes || null,
  };
}

export function buildFinanceSearch(query) {
  const tourOperator = String(query?.tourOperator ?? "").replace(/\s+/g, " ").trim();
  if (!tourOperator) throw validationError("Tour Operator is required.");

  const from = query?.from ? normalizeFinanceDate(query.from, "Date From") : null;
  const to = query?.to ? normalizeFinanceDate(query.to, "Date To") : null;
  if (from && to && from > to) throw validationError("Date From cannot be later than Date To.");

  const page = Math.max(1, Number.parseInt(query?.page, 10) || 1);
  const pageSize = Math.min(MAX_FINANCE_PAGE_SIZE, Math.max(10, Number.parseInt(query?.pageSize, 10) || 50));
  const sortBy = String(query?.sortBy ?? "THE_DATE");
  const sortDir = String(query?.sortDir ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortColumns = { AA: "id", THE_DATE: "date", CHARGE: "charge", PAYMENT: "payment" };
  const normalizedSortBy = Object.hasOwn(sortColumns, sortBy) ? sortBy : "THE_DATE";

  const where = ["`TOUR_OPER` = ?"];
  const params = [tourOperator];
  if (from) { where.push("`THE_DATE` >= ?"); params.push(from); }
  if (to) { where.push("`THE_DATE` <= ?"); params.push(to); }

  return {
    tourOperator,
    from,
    to,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    sortBy: normalizedSortBy,
    sortDir,
    orderBy: `${sortColumns[normalizedSortBy]} ${sortDir}, id ${sortDir}`,
    whereSql: `WHERE ${where.join(" AND ")}`,
    params,
  };
}

export async function fetchFinancePage(query) {
  const search = buildFinanceSearch(query);
  const selectSql = `
    SELECT \`AA\` AS id, \`TOUR_OPER\` AS tourOperator,
      DATE_FORMAT(\`THE_DATE\`, '%Y-%m-%d') AS date,
      \`CHARGE\` AS charge, \`PAYMENT\` AS payment,
      CAST(\`CHARGE\` - \`PAYMENT\` AS DECIMAL(12,2)) AS balance,
      \`NOTES\` AS notes
    FROM finance
    ${search.whereSql}
  `;
  // Keep the count and monetary totals in the same server-side aggregate over
  // the exact WHERE clause used by the paginated row query. DECIMAL values are
  // returned as strings by mysql2, so no JavaScript floating-point sum occurs.
  const [summaryRows] = await pool.query(`
    SELECT COUNT(*) AS total,
      CAST(COALESCE(SUM(\`CHARGE\`), 0.00) AS DECIMAL(24,2)) AS totalCharge,
      CAST(COALESCE(SUM(\`PAYMENT\`), 0.00) AS DECIMAL(24,2)) AS totalPayment,
      CAST(COALESCE(SUM(\`CHARGE\`) - SUM(\`PAYMENT\`), 0.00) AS DECIMAL(24,2)) AS totalBalance
    FROM finance
    ${search.whereSql}
  `, search.params);
  const [rows] = await pool.query(`${selectSql} ORDER BY ${search.orderBy} LIMIT ? OFFSET ?`, [...search.params, search.pageSize, search.offset]);
  const summary = summaryRows?.[0] ?? {};
  return {
    rows,
    total: Number(summary.total ?? 0),
    totals: {
      charge: String(summary.totalCharge ?? "0.00"),
      payment: String(summary.totalPayment ?? "0.00"),
      balance: String(summary.totalBalance ?? "0.00"),
    },
    page: search.page,
    pageSize: search.pageSize,
    sortBy: search.sortBy,
    sortDir: search.sortDir.toLowerCase(),
  };
}

export async function countMatchingFinance(query, existingSearch = null) {
  const search = existingSearch ?? buildFinanceSearch(query);
  const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM finance ${search.whereSql}`, search.params);
  return Number(rows?.[0]?.total ?? 0);
}

export async function fetchAllMatchingFinance(query, limit) {
  const search = buildFinanceSearch(query);
  const total = await countMatchingFinance(query, search);
  if (total > limit) {
    const err = new Error(`Export is limited to ${limit} Finance entries. Please narrow the filters and try again.`);
    err.status = 413;
    err.total = total;
    err.limit = limit;
    throw err;
  }
  const [rows] = await pool.query(`
    SELECT \`AA\` AS id, \`TOUR_OPER\` AS tourOperator,
      DATE_FORMAT(\`THE_DATE\`, '%Y-%m-%d') AS date,
      \`CHARGE\` AS charge, \`PAYMENT\` AS payment,
      CAST(\`CHARGE\` - \`PAYMENT\` AS DECIMAL(12,2)) AS balance,
      \`NOTES\` AS notes
    FROM finance
    ${search.whereSql}
    ORDER BY ${search.orderBy}
    LIMIT ?
  `, [...search.params, limit]);
  return { rows, total, limit, search };
}

export async function fetchFinanceById(id) {
  const [rows] = await pool.query(`
    SELECT \`AA\` AS id, \`TOUR_OPER\` AS tourOperator,
      DATE_FORMAT(\`THE_DATE\`, '%Y-%m-%d') AS date,
      \`CHARGE\` AS charge, \`PAYMENT\` AS payment,
      CAST(\`CHARGE\` - \`PAYMENT\` AS DECIMAL(12,2)) AS balance,
      \`NOTES\` AS notes
    FROM finance
    WHERE \`AA\` = ?
    LIMIT 1
  `, [id]);
  return rows?.[0] ?? null;
}
