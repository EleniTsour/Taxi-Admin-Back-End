import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-finance-secret";

const { pool } = await import("../src/db.js");
const { app } = await import("../src/server.js");

let server;
let baseUrl;
let baseQuery;

before(async () => {
  baseQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (sql.includes("session_version") && sql.includes("FROM users")) return [[{ sessionVersion: 0 }]];
    return baseQuery(sql, params);
  };
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = baseQuery;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function headers(role = "admin", csrfToken = "finance-csrf") {
  const token = jwt.sign({ userId: 1, role, csrfToken, sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return {
    Cookie: `token=${token}; csrf_token=${csrfToken}`,
    "X-CSRF-Token": csrfToken,
    "Content-Type": "application/json",
  };
}

async function withMockedDb(handler, work) {
  const originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (sql.includes("session_version") && sql.includes("FROM users")) return [[{ sessionVersion: 0 }]];
    return handler(sql, params);
  };
  try {
    return await work();
  } finally {
    pool.query = originalQuery;
  }
}

const validEntry = { tourOperator: "Alpha Tours", date: "2026-09-15", charge: "100.50", payment: "0", notes: "Invoice 7" };

test("creates a valid Finance entry and preserves zero payment", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM prices")) return [[{ tourOperator: "Alpha Tours" }]];
    if (sql.includes("INSERT INTO finance")) return [{ insertId: 42 }];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance`, { method: "POST", headers: headers(), body: JSON.stringify(validEntry) });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true, id: 42 });
  });
  const insert = queries.find((query) => query.sql.includes("INSERT INTO finance"));
  assert.match(insert.sql, /`TOUR_OPER`, `THE_DATE`, `CHARGE`, `PAYMENT`, `NOTES`/);
  assert.doesNotMatch(insert.sql, /`AA`/);
  assert.deepEqual(insert.params, ["Alpha Tours", "2026-09-15", "100.50", "0", "Invoice 7"]);
});

test("rejects a missing Tour Operator", async () => {
  const response = await fetch(`${baseUrl}/finance`, {
    method: "POST", headers: headers(), body: JSON.stringify({ ...validEntry, tourOperator: "" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Tour Operator is required/);
});

test("rejects an unknown Tour Operator and a missing Date", async () => {
  await withMockedDb(async (sql) => {
    if (sql.includes("FROM prices")) return [[]];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const unknownTour = await fetch(`${baseUrl}/finance`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ...validEntry, tourOperator: "Not a configured operator" }),
    });
    assert.equal(unknownTour.status, 400);
    assert.match((await unknownTour.json()).error, /does not exist/);
  });

  const missingDate = await fetch(`${baseUrl}/finance`, {
    method: "POST", headers: headers(), body: JSON.stringify({ ...validEntry, date: "" }),
  });
  assert.equal(missingDate.status, 400);
  assert.match((await missingDate.json()).error, /Date must be a valid/);
});

test("rejects invalid Charge and Payment values", async () => {
  for (const body of [{ ...validEntry, charge: "letters" }, { ...validEntry, payment: "-25" }]) {
    const response = await fetch(`${baseUrl}/finance`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /non-negative euro amount/);
  }
});

test("search requires Tour Operator", async () => {
  const response = await fetch(`${baseUrl}/finance/search`, { headers: headers() });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Tour Operator is required/);
});

test("does not expose unexpected Finance database errors", async () => {
  await withMockedDb(async () => {
    throw new Error("Unknown column 'internal_secret' in 'field list'");
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/search?tourOperator=Alpha%20Tours`, { headers: headers() });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
  });
});

test("searches by Tour Operator with inclusive From and To dates and decimal-safe balances", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("COLUMN_NAME IN")) return [[{ COLUMN_NAME: "A/A" }]];
    if (sql.includes("COUNT(*) AS total")) return [[{ total: 4, totalCharge: "400.50", totalPayment: "300.25", totalBalance: "100.25" }]];
    if (sql.includes("FROM finance")) return [[
      { id: 42, tourOperator: "Alpha Tours", date: "2026-09-15", charge: "100.00", payment: "60.00", balance: "40.00", notes: null },
      { id: 43, tourOperator: "Alpha Tours", date: "2026-09-15", charge: "100.00", payment: "100.00", balance: "0.00", notes: null },
      { id: 44, tourOperator: "Alpha Tours", date: "2026-09-15", charge: "100.00", payment: "120.00", balance: "-20.00", notes: null },
      { id: 45, tourOperator: "Alpha Tours", date: "2026-09-15", charge: "100.50", payment: "20.25", balance: "80.25", notes: null },
    ]];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/search?tourOperator=Alpha%20Tours&from=2026-09-15&to=2026-09-15`, { headers: headers() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 4);
    assert.deepEqual(body.totals, { charge: "400.50", payment: "300.25", balance: "100.25" });
    assert.equal(body.rows[0].tourOperator, "Alpha Tours");
    assert.deepEqual(body.rows.map((row) => row.balance), ["40.00", "0.00", "-20.00", "80.25"]);
  });
  const countQuery = queries.find((query) => query.sql.includes("COUNT(*) AS total"));
  const resultQuery = queries.find((query) => query.sql.includes("CAST(`CHARGE` - `PAYMENT` AS DECIMAL(12,2)) AS balance"));
  assert.match(countQuery.sql, /`THE_DATE` >= \? AND `THE_DATE` <= \?/);
  assert.deepEqual(countQuery.params, ["Alpha Tours", "2026-09-15", "2026-09-15"]);
  assert.ok(resultQuery);
});

test("search returns zero decimal-safe totals for an empty filtered result set", async () => {
  await withMockedDb(async (sql) => {
    if (sql.includes("COUNT(*) AS total")) return [[{ total: 0, totalCharge: "0.00", totalPayment: "0.00", totalBalance: "0.00" }]];
    if (sql.includes("FROM finance")) return [[]];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/search?tourOperator=Alpha%20Tours&page=2&pageSize=10&sortBy=PAYMENT&sortDir=asc`, { headers: headers() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 0);
    assert.deepEqual(body.totals, { charge: "0.00", payment: "0.00", balance: "0.00" });
  });
});

test("rejects a Date From later than Date To", async () => {
  const response = await fetch(`${baseUrl}/finance/search?tourOperator=Alpha%20Tours&from=2026-09-16&to=2026-09-15`, { headers: headers() });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot be later/);
});

test("defaults omitted or blank Charge and Payment to 0.00", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM prices")) return [[{ tourOperator: "Alpha Tours" }]];
    if (sql.includes("INSERT INTO finance")) return [{ insertId: 47 }];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const omitted = await fetch(`${baseUrl}/finance`, { method: "POST", headers: headers(), body: JSON.stringify({ tourOperator: "Alpha Tours", date: "2026-09-15" }) });
    const blank = await fetch(`${baseUrl}/finance`, { method: "POST", headers: headers(), body: JSON.stringify({ tourOperator: "Alpha Tours", date: "2026-09-15", charge: "", payment: "" }) });
    assert.equal(omitted.status, 201);
    assert.equal(blank.status, 201);
  });
  const inserts = queries.filter((query) => query.sql.includes("INSERT INTO finance"));
  assert.equal(inserts.length, 2);
  for (const insert of inserts) assert.deepEqual(insert.params.slice(2, 4), ["0.00", "0.00"]);
});

test("deletes a Finance entry", async () => {
  await withMockedDb(async (sql) => {
    if (sql.includes("COLUMN_NAME IN")) return [[{ COLUMN_NAME: "A/A" }]];
    if (sql.includes("DELETE FROM finance")) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/42`, { method: "DELETE", headers: headers() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, id: "42" });
  });
});

test("returns not found when deleting an already removed Finance entry", async () => {
  await withMockedDb(async (sql) => {
    if (sql.includes("DELETE FROM finance")) return [{ affectedRows: 0 }];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/999`, { method: "DELETE", headers: headers() });
    assert.equal(response.status, 404);
  });
});

test("generates an authenticated PDF for one authoritative Finance row", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM finance") && sql.includes("WHERE `AA` = ?")) {
      return [[{
        id: 42, tourOperator: "Alpha Tours", date: "2026-09-15",
        charge: "100.50", payment: "20.25", balance: "80.25",
        notes: "A long Greek and English note that is rendered by the shared Finance PDF renderer.",
      }]];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/42/pdf`, { headers: headers("user") });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
    assert.match(response.headers.get("content-disposition") ?? "", /finance_report_42\.pdf/);
    const pdf = Buffer.from(await response.arrayBuffer());
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.includes(Buffer.from("/Subtype /Image")));
  });
  assert.match(queries[0].sql, /CAST\(`CHARGE` - `PAYMENT` AS DECIMAL\(12,2\)\) AS balance/);
  assert.deepEqual(queries[0].params, ["42"]);
});

test("rejects unauthenticated single Finance PDF requests", async () => {
  const response = await fetch(`${baseUrl}/finance/42/pdf`);
  assert.equal(response.status, 401);
});

test("authenticated normal users can create, search, and delete Finance entries", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("FROM prices")) return [[{ tourOperator: "Alpha Tours" }]];
    if (sql.includes("INSERT INTO finance")) return [{ insertId: 46 }];
    if (sql.includes("COUNT(*) AS total")) return [[{ total: 0 }]];
    if (sql.includes("DELETE FROM finance")) return [{ affectedRows: 1 }];
    if (sql.includes("FROM finance")) return [[]];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const userHeaders = headers("user");
    const create = await fetch(`${baseUrl}/finance`, { method: "POST", headers: userHeaders, body: JSON.stringify(validEntry) });
    const search = await fetch(`${baseUrl}/finance/search?tourOperator=Alpha%20Tours`, { headers: userHeaders });
    const remove = await fetch(`${baseUrl}/finance/46`, { method: "DELETE", headers: userHeaders });
    assert.equal(create.status, 201);
    assert.equal(search.status, 200);
    assert.equal(remove.status, 200);
  });
});

test("unauthenticated users cannot create, search, or delete Finance entries", async () => {
  const requests = [
    fetch(`${baseUrl}/finance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validEntry) }),
    fetch(`${baseUrl}/finance/search?tourOperator=Alpha%20Tours`),
    fetch(`${baseUrl}/finance/42`, { method: "DELETE" }),
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 401);
  }
});

test("Finance exports cannot be queued without authentication", async () => {
  const response = await fetch(`${baseUrl}/exports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "finance_excel", query: { tourOperator: "Alpha Tours" } }),
  });
  assert.equal(response.status, 401);
});

test("Finance CSV backup includes only persisted fields without losing dates, decimals, zeroes, or Greek text", async () => {
  await withMockedDb(async (sql) => {
    if (sql === "SHOW COLUMNS FROM finance") {
      return [[
        { Field: "AA" }, { Field: "TOUR_OPER" }, { Field: "THE_DATE" },
        { Field: "CHARGE" }, { Field: "PAYMENT" }, { Field: "NOTES" },
      ]];
    }
    if (sql === "SELECT * FROM finance") {
      return [[{
        AA: 42,
        TOUR_OPER: "Ελληνικά Tours",
        THE_DATE: "2026-09-18",
        CHARGE: "100.50",
        PAYMENT: "0.00",
        NOTES: "Greek σημείωση and English note",
      }]];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/finance/backup.csv`, { headers: headers() });
    const csv = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/csv; charset=utf-8/i);
    assert.match(response.headers.get("content-disposition") ?? "", /finance_backup_\d{4}-\d{2}-\d{2}\.csv/);
    assert.match(csv, /"AA","TOUR_OPER","THE_DATE","CHARGE","PAYMENT","NOTES"/);
    assert.match(csv, /"42","Ελληνικά Tours","2026-09-18","100.50","0.00","Greek σημείωση and English note"/);
    assert.doesNotMatch(csv, /BALANCE/i);
  });
});
