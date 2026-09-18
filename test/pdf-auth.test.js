import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../src/db.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

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

after(() => new Promise((resolve, reject) => {
  pool.query = baseQuery;
  if (!server?.listening) return resolve();
  return server.close((error) => error ? reject(error) : resolve());
}));

function authCookies(csrfToken = "csrf-token") {
  const token = jwt.sign({ userId: 1, csrfToken, sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return `token=${token}; csrf_token=${csrfToken}`;
}

function expiredAuthCookies(csrfToken = "csrf-token") {
  const token = jwt.sign({ userId: 1, csrfToken, sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: -1 });
  return `token=${token}; csrf_token=${csrfToken}`;
}

function legacyAuthCookies() {
  const token = jwt.sign({ userId: 1, sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return `token=${token}`;
}

function authHeaders(csrfToken = "csrf-token") {
  return {
    Cookie: authCookies(csrfToken),
    "X-CSRF-Token": csrfToken,
  };
}

async function startSmtpServer() {
  const messages = [];
  const authCommands = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let receivingMessage = false;
    let message = "";

    socket.write("220 smtp.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.length) {
        if (receivingMessage) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          message += buffer.slice(0, end);
          messages.push(message);
          message = "";
          buffer = buffer.slice(end + 5);
          receivingMessage = false;
          socket.write("250 2.0.0 queued\r\n");
          continue;
        }

        const end = buffer.indexOf("\r\n");
        if (end === -1) return;
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (/^(EHLO|HELO) /i.test(command)) {
          socket.write("250-smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n");
        } else if (/^AUTH /i.test(command)) {
          authCommands.push(command);
          socket.write("235 2.7.0 Authentication successful\r\n");
        } else if (/^MAIL FROM:/i.test(command) || /^RCPT TO:/i.test(command)) {
          socket.write("250 2.1.0 OK\r\n");
        } else if (/^DATA$/i.test(command)) {
          receivingMessage = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (/^QUIT$/i.test(command)) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 OK\r\n");
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });

  return {
    authCommands,
    messages,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
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

test("bearer tokens do not authenticate without the session cookie", async () => {
  const token = jwt.sign({ userId: 1, csrfToken: "csrf-token", sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const response = await fetch(`${baseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 401);
});

test("login creates an HttpOnly cookie session without returning a token", async () => {
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
    assert.equal(body.token, undefined);
    assert.match(response.headers.get("set-cookie") ?? "", /token=.*HttpOnly.*SameSite=Lax/i);
    assert.match(response.headers.get("set-cookie") ?? "", /csrf_token=/);
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

test("bearer tokens cannot bypass CSRF without the session cookie", async () => {
  const token = jwt.sign({ userId: 1, csrfToken: "csrf-token", sessionVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 401);
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

test("cookie sessions require a renewed CSRF-enabled token", async () => {
  const response = await fetch(`${baseUrl}/pdf/voucher`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: legacyAuthCookies(),
    },
    body: JSON.stringify({ THE_NAME: "Test passenger" }),
  });

  assert.equal(response.status, 401);
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

test("voucher email uses the configured authenticated SMTP transport and preserves PDF and calendar attachments", async () => {
  const smtp = await startSmtpServer();
  const previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,
    SMTP_SECURE: process.env.SMTP_SECURE,
  };
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.port),
    SMTP_USER: "smtp-user",
    SMTP_PASS: "smtp-pass",
    SMTP_FROM: "vouchers@example.test",
    SMTP_SECURE: "false",
  });

  try {
    const response = await fetch(`${baseUrl}/pdf/voucher-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        to: "passenger@example.test",
        subject: "Transfer voucher",
        text: "Your transfer is confirmed.",
        includeCalendar: true,
        ride: { AA: 42, THE_DATE: "2026-09-18", TIME: "10:30", THE_NAME: "Passenger" },
      }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(smtp.authCommands.length, 1);
    assert.equal(smtp.messages.length, 1);
    const message = smtp.messages[0];
    assert.match(message, /To: passenger@example\.test/i);
    assert.match(message, /Subject: Transfer voucher/i);
    assert.match(message, /filename=voucher_42\.pdf/i);
    assert.match(message, /Content-Type: application\/pdf/i);
    assert.match(message, /filename=voucher_42\.ics/i);
    assert.match(message, /Content-Type: text\/calendar/i);
    assert.match(message, /QkVHSU46VkNBTEVOREFS/); // "BEGIN:VCALENDAR" encoded as base64
  } finally {
    await smtp.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("CORS permits the CSRF header for the configured frontend", async () => {
  const response = await fetch(`${baseUrl}/auth/me`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://versa-reg.eu",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "X-CSRF-Token",
    },
  });

  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /X-CSRF-Token/i);
});
