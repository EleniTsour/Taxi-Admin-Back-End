import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-rides-validation-secret";

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

function headers(csrfToken = "rides-csrf") {
  const token = jwt.sign({ userId: 1, csrfToken, sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return {
    Cookie: `token=${token}; csrf_token=${csrfToken}`,
    "X-CSRF-Token": csrfToken,
    "Content-Type": "application/json",
  };
}

const validRide = { THE_DATE: "2026-09-15", FROM: "Airport", TO: "Hotel" };

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

test("ride create and update reject malformed supplied numeric fields", async () => {
  for (const [method, url, field, value] of [
    ["POST", `${baseUrl}/rides`, "PRICE", "abc"],
    ["PUT", `${baseUrl}/rides/42`, "DRIVER_PRICE", "abc"],
    ["PUT", `${baseUrl}/rides/42`, "ADULT", "1x"],
  ]) {
    const body = method === "POST" ? { ...validRide, [field]: value } : { [field]: value };
    const response = await fetch(url, { method, headers: headers(), body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, new RegExp(`${field} must be a valid number`));
  }
});

test("ride create preserves PAX text while numeric fields retain numeric validation", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [[
      { COLUMN_NAME: "THE_DATE" }, { COLUMN_NAME: "FROM" }, { COLUMN_NAME: "TO" },
      { COLUMN_NAME: "PAX" }, { COLUMN_NAME: "ADULT" }, { COLUMN_NAME: "PRICE" }, { COLUMN_NAME: "DRIVER_PRICE" },
    ]];
    if (sql.includes("INSERT INTO data")) return [{ insertId: 42 }];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const blank = await fetch(`${baseUrl}/rides`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ...validRide, PRICE: "", PAX: "" }),
    });
    const numeric = await fetch(`${baseUrl}/rides`, {
      method: "POST", headers: headers(), body: JSON.stringify({ ...validRide, PAX: "2+1", ADULT: "2", PRICE: "100.50", DRIVER_PRICE: "25,25" }),
    });
    assert.equal(blank.status, 200);
    assert.equal(numeric.status, 200);
  });
  const inserts = queries.filter((query) => query.sql.includes("INSERT INTO data"));
  assert.equal(inserts.length, 2);
  assert.ok(inserts[0].params.includes(null));
  assert.ok(inserts[1].params.includes("2+1"));
  assert.ok(inserts[1].params.includes(100.5));
  assert.ok(inserts[1].params.includes(25.25));
});

test("ride update preserves an existing text-style PAX value", async () => {
  const queries = [];
  await withMockedDb(async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [[{ COLUMN_NAME: "PAX" }]];
    if (sql.includes("SHOW COLUMNS FROM data")) return [[{ Field: "A/A" }]];
    if (sql.includes("UPDATE data")) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  }, async () => {
    const response = await fetch(`${baseUrl}/rides/42`, {
      method: "PUT", headers: headers(), body: JSON.stringify({ PAX: "2 AD" }),
    });
    assert.equal(response.status, 200);
  });

  const update = queries.find((query) => query.sql.includes("UPDATE data"));
  assert.deepEqual(update.params, ["2 AD", "42"]);
});
