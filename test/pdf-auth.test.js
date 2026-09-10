import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../src/db.js";

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

function expiredAuthCookies(csrfToken = "csrf-token") {
  const token = jwt.sign({ userId: 1, csrfToken }, process.env.JWT_SECRET, { expiresIn: -1 });
  return `token=${token}; csrf_token=${csrfToken}`;
}

function legacyAuthCookies() {
  const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return `token=${token}`;
}

function authHeaders(csrfToken = "csrf-token") {
  return {
    Cookie: authCookies(csrfToken),
    "X-CSRF-Token": csrfToken,
  };
}

function bearerToken(options = {}) {
  return jwt.sign({ userId: 1, ...options }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

function bearerHeaders(options = {}) {
  return { Authorization: `Bearer ${bearerToken(options)}` };
}

test("voucher endpoint rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 401);
});

test("authenticated sessions can retrieve their CSRF token and read operations stay available", async () => {
  const csrfToken = "csrf-token";
  const csrfResponse = await fetch(`${baseUrl}/auth/csrf`, {
    headers: { Cookie: authCookies(csrfToken) },
  });
  const meResponse = await fetch(`${baseUrl}/auth/me`, {
    headers: { Cookie: authCookies(csrfToken) },
  });

  assert.equal(csrfResponse.status, 200);
  assert.deepEqual(await csrfResponse.json(), { token: csrfToken });
  assert.equal(meResponse.status, 200);
});

test("bearer authentication works without cookies", async () => {
  const response = await fetch(`${baseUrl}/auth/me`, {
    headers: bearerHeaders(),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("login returns a bearer token", async () => {
  const originalQuery = pool.query;
  const passwordHash = await bcrypt.hash("correct-password", 4);
  pool.query = async () => [[{
    id: 1,
    email: "admin@example.test",
    password_hash: passwordHash,
    role: "admin",
  }]];

  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "correct-password" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.token, "string");
    assert.equal(jwt.verify(body.token, process.env.JWT_SECRET).email, "admin@example.test");
  } finally {
    pool.query = originalQuery;
  }
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

test("bearer-authenticated state changes do not require CSRF cookies", async () => {
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...bearerHeaders(),
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
});

test("voucher endpoint rejects expired authentication", async () => {
  const csrfToken = "csrf-token";
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: expiredAuthCookies(csrfToken),
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 401);
});

test("cookie-authenticated requests still require CSRF protection", async () => {
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: legacyAuthCookies(),
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
      ...authHeaders(csrfToken),
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
});

test("name-tag PDF works for an authenticated request without a logo", async () => {
  const response = await fetch(`${baseUrl}/pdf/name-tag`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ name: "Test passenger" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
});

test("name-tag PDF rejects unauthenticated requests", async () => {
  const response = await fetch(`${baseUrl}/pdf/name-tag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test passenger" }),
  });

  assert.equal(response.status, 401);
});

test("name-tag logo uses the configured logo rather than a client URL", async () => {
  const originalFetch = globalThis.fetch;
  const logo = await readFile(new URL("../../frontend/public/versa-logo.png", import.meta.url));
  globalThis.fetch = async (input, options) => {
    if (String(input) === "https://versa-reg.eu/versa-logo.png") {
      return new Response(logo, { headers: { "content-type": "image/png" } });
    }
    return originalFetch(input, options);
  };

  try {
    const response = await fetch(`${baseUrl}/pdf/name-tag-logo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ name: "Test passenger", logoUrl: "http://127.0.0.1/ignored.png" }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("logout requires CSRF protection and clears both session cookies", async () => {
  const csrfToken = "csrf-token";
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: authCookies(csrfToken),
      "X-CSRF-Token": csrfToken,
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /token=/);
  assert.match(response.headers.get("set-cookie") ?? "", /csrf_token=/);
});

test("CORS permits the bearer Authorization header for the configured frontend", async () => {
  const response = await fetch(`${baseUrl}/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://versa-reg.eu",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization",
    },
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
});
