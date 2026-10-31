require("./config/load-env");

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const sessionRouter = require("./modules/session/session.router");
const healthRouter = require("./modules/health/health.router");

/** External API prefix. Must match the NestJS `setGlobalPrefix('api')` contract. */
const API_PREFIX = "/api";

function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Everything below is mounted ONCE under the API prefix. Never mount a router at both `/api` and
  // `/api/api`: the routers own their paths relative to the prefix, so `/api` + `/sessions` is
  // `/api/sessions`, not `/api/api/sessions`.
  app.use(`${API_PREFIX}/health`, healthRouter);
  app.use(`${API_PREFIX}/sessions`, sessionRouter);

  // Compatibility alias for probes that were written against the pre-prefix Express scaffold. It
  // serves the same public handlers; protected routers are NOT aliased outside `/api`.
  app.use("/health", healthRouter);

  // The Phase 4.1.2C-3D-1 scaffold routes (/sessions/baileys/:id/connect and /status) remain removed:
  // they bypassed API-key auth, joined the raw path segment into the credential directory and
  // duplicated the engine registry. The authenticated lifecycle router mounted above replaces them
  // (POST /api/sessions/:id/start, GET /api/sessions/:id).
  app.use((err, req, res, _next) => {
    console.error(err);
    const body = { message: err.message || "Internal Server Error" };
    // Lifecycle refusals carry a stable machine-readable code (e.g. SESSION_STOP_INCOMPLETE) so a
    // client can tell a retryable partial teardown from a plain 502.
    if (err.code) body.code = err.code;
    res.status(err.status || 500).json(body);
  });

  return app;
}

module.exports = { createApp, API_PREFIX };
