import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const { app } = await import("../src/server.js");
let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve, reject) => {
  if (!server?.listening) return resolve();
  return server.close((error) => error ? reject(error) : resolve());
}));

function authCookies(csrfToken = "csrf-token") {
  const token = jwt.sign({ userId: 1, csrfToken }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return `token=${token}; csrf_token=${csrfToken}`;
}

test("voucher endpoint rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 401);
});

test("voucher endpoint rejects requests without a valid CSRF token", async () => {
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookies(),
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 403);
});

test("voucher endpoint accepts an authenticated request with a valid CSRF token", async () => {
  const csrfToken = "csrf-token";
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookies(csrfToken),
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
});

test("login attempts are rate limited", async () => {
  let response;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  assert.equal(response.status, 429);
  assert.match(await response.text(), /Too many login attempts/);
});
