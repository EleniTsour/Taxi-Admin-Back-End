import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-search-secret";

const { pool } = await import("../src/db.js");
const { app } = await import("../src/server.js");
let server;
let baseUrl;
let originalQuery;
let queries;

before(async () => {
  originalQuery = pool.query;
  queries = [];
  pool.query = async (sql) => {
    queries.push(sql);
    if (sql.includes("COLUMN_NAME IN")) return [[{ COLUMN_NAME: "A/A" }]];
    if (sql.includes("LOWER(DATA_TYPE)")) return [[{ dataType: "date" }]];
    if (sql.includes("SELECT COUNT(*) AS total")) return [[{ total: 4 }]];
    if (sql.includes("FROM data")) return [[
      { "A/A": 1, TOUR_OPER: "alpha" },
      { "A/A": 2, TOUR_OPER: "Bravo" },
      { "A/A": 3, TOUR_OPER: "charlie" },
      { "A/A": 4, TOUR_OPER: null },
    ]];
    throw new Error(`Unexpected query: ${sql}`);
  };
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = originalQuery;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function bearerAuth() {
  const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return `Bearer ${token}`;
}

async function search(sortBy, sortDir) {
  queries = [];
  const response = await fetch(`${baseUrl}/rides/search?sortBy=${sortBy}&sortDir=${sortDir}&page=1&pageSize=25`, {
    headers: { Authorization: bearerAuth() },
  });
  return { response, body: await response.json(), sql: queries.find((query) => query.includes("FROM data") && query.includes("ORDER BY")) };
}

test("search route accepts the frontend Tour Operator key and sends ascending SQL", async () => {
  const { response, body, sql } = await search("TOUR_OPER", "asc");

  assert.equal(response.status, 200);
  assert.equal(body.sortBy, "TOUR_OPER");
  assert.equal(body.sortDir, "asc");
  assert.match(sql, /CASE WHEN TRIM\(COALESCE\(`TOUR_OPER`, ''\)\) = '' THEN 1 ELSE 0 END ASC, LOWER\(`TOUR_OPER`\) ASC/);
});

test("search route preserves descending Tour Operator sorting and existing date sorting", async () => {
  const descending = await search("TOUR_OPER", "desc");
  assert.equal(descending.response.status, 200);
  assert.equal(descending.body.sortDir, "desc");
  assert.match(descending.sql, /LOWER\(`TOUR_OPER`\) DESC/);

  const date = await search("THE_DATE", "desc");
  assert.equal(date.response.status, 200);
  assert.equal(date.body.sortBy, "THE_DATE");
  assert.match(date.sql, /ORDER BY `THE_DATE` DESC, `TIME` DESC/);
});
