const net = require("net");
const {
  DEFAULT_EXPRESS_PORT,
  resolveExpressPort,
  assertPortAvailable,
} = require("./express-server");

function listenOnEphemeralPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => resolve(server));
  });
}

function portOf(server) {
  return server.address().port;
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe("resolveExpressPort", () => {
  test("defaults to the NestJS-compatible port 2785", () => {
    expect(DEFAULT_EXPRESS_PORT).toBe(2785);
    expect(resolveExpressPort({})).toBe(2785);
  });

  test("honours an explicit EXPRESS_PORT", () => {
    expect(resolveExpressPort({ EXPRESS_PORT: "3001" })).toBe(3001);
    expect(resolveExpressPort({ EXPRESS_PORT: 4000 })).toBe(4000);
  });

  test("treats a blank EXPRESS_PORT as unset", () => {
    expect(resolveExpressPort({ EXPRESS_PORT: "   " })).toBe(2785);
  });

  test("fails loudly instead of silently overriding an invalid EXPRESS_PORT", () => {
    expect(() => resolveExpressPort({ EXPRESS_PORT: "abc" })).toThrow(
      /EXPRESS_PORT/,
    );
    expect(() => resolveExpressPort({ EXPRESS_PORT: "0" })).toThrow(
      /EXPRESS_PORT/,
    );
    expect(() => resolveExpressPort({ EXPRESS_PORT: "70000" })).toThrow(
      /EXPRESS_PORT/,
    );
    expect(() => resolveExpressPort({ EXPRESS_PORT: "2785.5" })).toThrow(
      /EXPRESS_PORT/,
    );
  });
});

describe("assertPortAvailable", () => {
  test("resolves for a free port", async () => {
    const server = await listenOnEphemeralPort();
    const port = portOf(server);
    await close(server);

    await expect(assertPortAvailable(port)).resolves.toBeUndefined();
  });

  test("rejects with a clear message when the port is already in use, without killing the listener", async () => {
    const server = await listenOnEphemeralPort();
    const port = portOf(server);
    try {
      await expect(assertPortAvailable(port)).rejects.toThrow(
        /already in use/i,
      );
      expect(server.listening).toBe(true);
    } finally {
      await close(server);
    }
  });
});
