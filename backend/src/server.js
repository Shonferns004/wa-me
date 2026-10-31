require("./config/load-env");

const http = require("http");
const { Server } = require("socket.io");
const { createApp, API_PREFIX } = require("./app");
const { initDb } = require("./database");
const { setIo, attachSocket } = require("./websocket");
const {
  resolveExpressPort,
  assertPortAvailable,
} = require("./config/express-server");

async function start() {
  // Resolve and check the port BEFORE touching the database or engine registry: a conflict should
  // fail in milliseconds, not after opening SQLite and attaching Socket.IO.
  const port = resolveExpressPort(process.env);
  await assertPortAvailable(port);

  await initDb();
  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });
  setIo(io);
  attachSocket(io);

  server.listen(port, () => {
    console.log(
      `Express server listening on ${port} (API prefix ${API_PREFIX})`,
    );
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    io.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
