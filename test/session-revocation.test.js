import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-session-revocation-secret";

const { pool } = await import("../src/db.js");
const { app } = await import("../src/server.js");

let server;
let baseUrl;
let originalQuery;
const user = { id: 7, email: "driver@example.test", passwordHash: await bcrypt.hash("old-password", 4), sessionVersion: 0 };

before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (sql.includes("WHERE email = ?")) {
      if (params[0] !== user.email) return [[]];
      return [[{ id: user.id, email: user.email, password_hash: user.passwordHash, role: "user", sessionVersion: user.sessionVersion }]];
    }
    if (sql.includes("SELECT `session_version` AS sessionVersion FROM users")) {
      return [[{ sessionVersion: user.sessionVersion }]];
    }
    if (sql.includes("SELECT id, password_hash, session_version AS sessionVersion")) {
      return [[{ id: user.id, password_hash: user.passwordHash, sessionVersion: user.sessionVersion }]];
    }
    if (sql.includes("UPDATE users SET password_hash = ?, session_version = session_version + 1")) {
      user.passwordHash = params[0];
      user.sessionVersion += 1;
      return [{ affectedRows: 1 }];
    }
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

function cookiesFromLogin(response) {
  const raw = response.headers.get("set-cookie") ?? "";
  const token = raw.match(/token=([^;]+)/)?.[1];
  const csrfToken = raw.match(/csrf_token=([^;]+)/)?.[1];
  assert.ok(token, "login must issue a token cookie");
  assert.ok(csrfToken, "login must issue a CSRF cookie");
  return { token, csrfToken, cookie: `token=${token}; csrf_token=${csrfToken}` };
}

async function login(password) {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password }),
  });
}

test("password changes revoke old JWT sessions and require a new login", async () => {
  const initialLogin = await login("old-password");
  assert.equal(initialLogin.status, 200);
  const oldSession = cookiesFromLogin(initialLogin);
  assert.equal(jwt.decode(oldSession.token).sessionVersion, 0);

  const beforeChange = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: oldSession.cookie } });
  assert.equal(beforeChange.status, 200);

  const changed = await fetch(`${baseUrl}/auth/change-password`, {
    method: "POST",
    headers: { Cookie: oldSession.cookie, "X-CSRF-Token": oldSession.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "old-password", newPassword: "new-password" }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ok: true, sessionRevoked: true });

  const oldSessionAfterChange = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: oldSession.cookie } });
  assert.equal(oldSessionAfterChange.status, 401);

  const oldPasswordLogin = await login("old-password");
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await login("new-password");
  assert.equal(newPasswordLogin.status, 200);
  const newSession = cookiesFromLogin(newPasswordLogin);
  assert.equal(jwt.decode(newSession.token).sessionVersion, 1);
  const newSessionRequest = await fetch(`${baseUrl}/auth/me`, { headers: { Cookie: newSession.cookie } });
  assert.equal(newSessionRequest.status, 200);
});
