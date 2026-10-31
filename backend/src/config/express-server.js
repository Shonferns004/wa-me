const net = require("net");

/**
 * The NestJS runtime binds `process.env.PORT || 2785`. Express uses its own knob so both runtimes can
 * coexist during the migration, but the DEFAULT must match Nest's so a dashboard/probe pointed at
 * 2785 works unchanged once Express takes over.
 */
const DEFAULT_EXPRESS_PORT = 2785;

/**
 * `EXPRESS_PORT` wins whenever it is explicitly provided (including from .env / data/.env.generated).
 * A blank value counts as unset, matching the env loader's blank-shadowing rule. An invalid value
 * fails loudly instead of silently falling back to the default.
 */
function resolveExpressPort(env = process.env) {
  const raw = env.EXPRESS_PORT;
  if (raw === undefined || String(raw).trim() === "")
    return DEFAULT_EXPRESS_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `EXPRESS_PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

/**
 * Fail fast on a port conflict BEFORE the database and Socket.IO are initialised. The probe only
 * binds and releases the port; it never touches (or terminates) the process already listening there,
 * which is usually the NestJS runtime during the migration.
 */
function assertPortAvailable(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. The NestJS runtime may still be running (npm start). ` +
              `Stop it first, or start Express on a free port with EXPRESS_PORT=<port>.`,
          ),
        );
        return;
      }
      reject(error);
    });

    probe.once("listening", () => {
      probe.close(() => resolve());
    });

    if (host) probe.listen({ port, host });
    else probe.listen(port);
  });
}

module.exports = {
  DEFAULT_EXPRESS_PORT,
  resolveExpressPort,
  assertPortAvailable,
};
