const request = require("supertest");
const { createApp, API_PREFIX } = require("./app");

describe("Express API prefix", () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  test("exposes the NestJS-compatible prefix constant", () => {
    expect(API_PREFIX).toBe("/api");
  });

  test("serves health under /api", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("serves liveness under /api", async () => {
    const res = await request(app).get("/api/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  test("keeps /health as a compatibility alias", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("does not report ready while the database is not connected", async () => {
    // createApp() is built without initDb() here, so the real datasource accessor returns null.
    const res = await request(app).get("/api/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.details.dataDatabase.status).toBe("down");
  });

  test("enforces API-key auth on /api/sessions", async () => {
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(401);
  });

  test("enforces API-key auth on session sub-routes", async () => {
    const res = await request(app).get(
      "/api/sessions/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(401);
  });

  test("does not expose protected routes without the /api prefix", async () => {
    const res = await request(app).get("/sessions");
    expect(res.status).toBe(404);
  });

  test("never double-prefixes to /api/api", async () => {
    const res = await request(app).get("/api/api/sessions");
    expect(res.status).toBe(404);
  });
});
