import { pool } from "./db.js";

let setupPromise = null;

// Additive migration for stateless JWT revocation. Existing users and legacy
// sessions begin at version 0; a password change increments the version.
export async function ensureUserSessionInfrastructure() {
  if (!setupPromise) {
    setupPromise = (async () => {
      const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'session_version'");
      if (!columns.length) {
        await pool.query("ALTER TABLE users ADD COLUMN `session_version` INT NOT NULL DEFAULT 0");
      }
    })().catch((err) => {
      setupPromise = null;
      throw err;
    });
  }
  return setupPromise;
}
