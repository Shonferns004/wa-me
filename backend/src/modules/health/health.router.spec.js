const express = require("express");
const request = require("supertest");
const { createHealthRouter } = require("./health.router");

function makeApp({
  authService,
  databases,
  appVersion = "9.9.9",
  probeTimeoutMs,
} = {}) {
  const app = express();
  app.use(
    "/api/health",
    createHealthRouter({
      authService: authService || { validateApiKey: async () => null },
      databases: databases || {
        dataDatabase: () => ({ query: async () => [[{ 1: 1 }]] }),
      },
      appVersion,
      probeTimeoutMs,
    }),
  );
  return app;
}

describe("health router — GET /", () => {
  test("answers 200 with a status and ISO timestamp and no version for an anonymous caller", async () => {
    const res = await request(makeApp()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    expect(res.body).not.toHaveProperty("version");
  });

  test("adds the running version for a valid X-API-Key", async () => {
    const res = await request(
      makeApp({
        authService: {
          validateApiKey: async (key) => (key === "good" ? { id: "k" } : null),
        },
      }),
    )
      .get("/api/health")
      .set("x-api-key", "good");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe("9.9.9");
  });

  test("accepts the key as an Authorization Bearer token", async () => {
    const res = await request(
      makeApp({
        authService: {
          validateApiKey: async (key) => (key === "good" ? { id: "k" } : null),
        },
      }),
    )
      .get("/api/health")
      .set("authorization", "Bearer good");

    expect(res.body.version).toBe("9.9.9");
  });

  test("still answers 200 without a version when the presented key is invalid", async () => {
    const res = await request(makeApp())
      .get("/api/health")
      .set("x-api-key", "bad");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body).not.toHaveProperty("version");
  });

  test("never turns an unavailable key store into a 500 on the public probe", async () => {
    const res = await request(
      makeApp({
        authService: {
          validateApiKey: async () => {
            throw new Error('No metadata for "ApiKey" was found');
          },
        },
      }),
    )
      .get("/api/health")
      .set("x-api-key", "anything");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("version");
  });
});

describe("health router — GET /live", () => {
  test("is static liveness and does not probe a dependency", async () => {
    const query = jest.fn();
    const res = await request(
      makeApp({ databases: { dataDatabase: () => ({ query }) } }),
    ).get("/api/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("health router — GET /ready", () => {
  test("reports 200 and the probed datasource when the database answers", async () => {
    const res = await request(makeApp()).get("/api/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      details: { dataDatabase: { status: "up" } },
    });
  });

  test("reports 503 when the datasource is not connected", async () => {
    const res = await request(
      makeApp({ databases: { dataDatabase: () => null } }),
    ).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "error",
      details: { dataDatabase: { status: "down" } },
    });
  });

  test("reports 503 when the probe query rejects", async () => {
    const res = await request(
      makeApp({
        databases: {
          dataDatabase: () => ({
            query: async () => {
              throw new Error("connection lost");
            },
          }),
        },
      }),
    ).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.details.dataDatabase.status).toBe("down");
  });

  test("bounds a hung probe with the configured timeout instead of hanging the request", async () => {
    const res = await request(
      makeApp({
        databases: {
          dataDatabase: () => ({ query: () => new Promise(() => {}) }),
        },
        probeTimeoutMs: 10,
      }),
    ).get("/api/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.details.dataDatabase.status).toBe("down");
  });
});
