const express = require("express");
const { presentedApiKey } = require("../../common/security/bearer-token");
const { getDb } = require("../../database");
const { AuthService } = require("../auth/auth.express.service");
const { version: APP_VERSION } = require("../../../package.json");

/** Bound each dependency probe so a hung connection can't stall the readiness check. */
const READINESS_PROBE_TIMEOUT_MS = 3000;

async function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("readiness probe timed out")),
      ms,
    );
  });
  try {
    // Must be awaited: a synchronous `finally` would clear the timer before the race could settle.
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeDatabase(getDataSource, timeoutMs) {
  try {
    const dataSource = getDataSource();
    if (!dataSource) return "down";
    await withTimeout(dataSource.query("SELECT 1"), timeoutMs);
    return "up";
  } catch {
    return "down";
  }
}

/**
 * Express health surface, matching the NestJS contract (`/api/health`, `/api/health/live`,
 * `/api/health/ready`):
 *
 * - `GET /` is public liveness: `{ status, timestamp }`, plus `version` only when the caller presents
 *   a valid API key. A missing/invalid key never fails the probe.
 * - `GET /live` is static liveness. It deliberately does not touch a dependency, so a transient
 *   database outage cannot get the process killed.
 * - `GET /ready` probes the datasource(s) Express actually owns and answers 503 when one is down.
 *   It never reports ready from HTTP liveness alone.
 *
 * `databases` is keyed by the dependency name reported in `details`. Express currently runs one
 * datasource (the data database); the NestJS runtime also has a separate main/auth database, so its
 * `mainDatabase` entry is absent here until that connection is migrated (see PHASE_4_2 report).
 */
function createHealthRouter({
  authService = new AuthService(),
  databases = { dataDatabase: getDb },
  appVersion = APP_VERSION,
  probeTimeoutMs = READINESS_PROBE_TIMEOUT_MS,
} = {}) {
  const router = express.Router();

  /**
   * Resolve a presented key the same way the NestJS health probe does: `X-API-Key`, else
   * `Authorization: Bearer`. Any outcome other than a validated key withholds `version`; it never
   * fails the check. The key store may be unavailable (not initialised, wrong datasource), which is
   * exactly the case this must swallow rather than turn into a 500 on a public probe.
   */
  async function hasValidApiKey(req) {
    const rawKey = presentedApiKey(req.headers);
    if (!rawKey || !authService) return false;
    try {
      return Boolean(await authService.validateApiKey(rawKey));
    } catch {
      return false;
    }
  }

  router.get("/", async (req, res, next) => {
    try {
      const body = { status: "ok", timestamp: new Date().toISOString() };
      if (await hasValidApiKey(req)) body.version = appVersion;
      res.status(200).json(body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/live", (req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/ready", async (req, res, next) => {
    try {
      const names = Object.keys(databases);
      const statuses = await Promise.all(
        names.map((name) => probeDatabase(databases[name], probeTimeoutMs)),
      );
      const details = {};
      names.forEach((name, index) => {
        details[name] = { status: statuses[index] };
      });

      if (statuses.includes("down")) {
        return res.status(503).json({ status: "error", details });
      }
      return res.status(200).json({ status: "ok", details });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = createHealthRouter();
module.exports.createHealthRouter = createHealthRouter;
