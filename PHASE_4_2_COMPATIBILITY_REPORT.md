# Phase 4.2 — Express API Compatibility Alignment

Compatibility pass only. No module migration, no schema change, no entrypoint change.

## Verdict

**PASS WITH LIMITATIONS.** Express is now reachable under `/api`, defaults to the NestJS port
`2785`, exposes `/api/health` with NestJS-compatible semantics, keeps `/health` as an alias, and the
Vite proxy target is configurable without changing the default NestJS workflow. NestJS remains the
active entrypoint and was still serving on `2785` at the end of verification.

The limitations are pre-existing and documented in §8 — most importantly, Express still owns a
single datasource, so real API-key validation cannot succeed against the Express runtime yet.

---

## 1. Files inspected

| File | What was confirmed |
| --- | --- |
| `backend/src/main.js` | Nest entrypoint; `const port = process.env.PORT \|\| 2785` (line 197); `applyGlobalValidation(app)` is called before listen. |
| `backend/src/config/app-validation.js` | `app.setGlobalPrefix('api')` (line 44). Authoritative prefix. |
| `backend/src/modules/health/health.controller.js` | `@Controller('health')` + `@Public()` + `@SkipThrottle()`; routes `GET /`, `GET /live`, `GET /ready`. |
| `backend/src/modules/health/dto/health-response.dto.js` | Exact body shapes: `{status,timestamp,version?}`, `{status}`, `{status,details}`. |
| `backend/src/app.js` | Pre-change Express app: `/health` and `/sessions` mounted without the `/api` prefix. |
| `backend/src/server.js` | Pre-change Express default port `3001`, no conflict preflight. |
| `backend/package.json` | `start`/`start:prod`/`prod` all run `src/main.js` (Nest). No Express script existed. |
| `frontend/vite.config.js` | Actual Vite config (there is no `backend/vite.config.*`); `/api/` and `/socket.io` hardcoded to `http://localhost:2785`. |
| `frontend/src/services/api.js` | `API_BASE_URL = ${API_ORIGIN}/api`; empty `VITE_API_URL` means same-origin `/api`. |
| `backend/src/configure-app.js` | Nest middleware stack (helmet, CSP, CORS, body caps, request id). Read-only reference for parity scope. |
| `backend/src/modules/session/session.router.js` | Existing Express session router; owns paths relative to its mount, enforces `x-api-key` + `allowedSessions`. |
| `backend/src/modules/auth/auth.express.service.js` | `validateApiKey`, `authorizeSession`. |
| `backend/src/database/index.js` | Express `initDb()` opens ONE datasource: `DATABASE_TYPE` + `DATABASE_NAME`. |
| `backend/src/modules/session/session.repository.js`, `api-key.repository.js` | Both resolve entities from that single `getDb()`. |
| `backend/src/websocket/index.js` | `/events` namespace; unchanged. |
| `backend/src/middleware/auth.js` | Stale single-`API_KEY` middleware; not mounted anywhere. Left untouched. |

## 2. Verified NestJS API contract

| Contract | Verified value | Source |
| --- | --- | --- |
| HTTP port | `process.env.PORT \|\| 2785` | `main.js:197` |
| Global prefix | `/api` | `app-validation.js:44` |
| Health liveness | `GET /api/health` → `200 {status:'ok', timestamp}`; `version` only with a valid key; public, unthrottled | `health.controller.js:62-73`, `:158-166` |
| Liveness probe | `GET /api/health/live` → `200 {status:'ok'}` | `health.controller.js:109-113`, `:167-174` |
| Readiness probe | `GET /api/health/ready` → `200 {status:'ok', details:{mainDatabase:{status},dataDatabase:{status}}}`; `503` if either is down or the node is draining | `health.controller.js:114-133`, `:175-187` |
| Frontend origin | `${API_ORIGIN}/api`, default same-origin `/api` | `frontend/src/services/api.js:16` |
| Dev proxy | `/api/` and `/socket.io` → `http://localhost:2785` | `frontend/vite.config.js` |

Live cross-check while Nest was running on `2785`:

```
GET /api/health       -> 200 {"status":"ok","timestamp":"..."}
GET /api/health/ready -> 200 {"status":"ok","details":{"mainDatabase":{"status":"up"},"dataDatabase":{"status":"up"}}}
GET /api/sessions     -> 401
GET /health           -> 404   (Nest has the prefix; no alias)
GET /api/api/sessions -> 404
```

## 3. Changes

### New: `backend/src/config/express-server.js`

- `DEFAULT_EXPRESS_PORT = 2785`.
- `resolveExpressPort(env)`: `EXPRESS_PORT` wins when present and non-blank; blank means unset; an
  invalid value throws instead of silently falling back.
- `assertPortAvailable(port, host)`: binds and releases the port before boot. On `EADDRINUSE` it
  rejects with an actionable message. It never signals or terminates the existing listener.

### New: `backend/src/modules/health/health.router.js`

- `GET /` → `{status:'ok', timestamp}`, adds `version` only for a valid key resolved through
  `presentedApiKey()` (X-API-Key **or** Bearer) and `AuthService.validateApiKey`.
- A missing, invalid, or un-lookupable key never fails the probe (no 500).
- `GET /live` → `{status:'ok'}` without touching a dependency.
- `GET /ready` → probes every configured datasource with a 3 s bound; `200` only when all are `up`,
  `503 {status:'error', details}` otherwise. It cannot report ready from HTTP liveness alone.
- `databases` is injectable and keyed by reported dependency name. Default: `{ dataDatabase: getDb }`.

### Changed: `backend/src/app.js`

- `API_PREFIX = '/api'` exported.
- `app.use('/api/health', healthRouter)` and `app.use('/api/sessions', sessionRouter)` — mounted once.
- `app.use('/health', healthRouter)` — public alias only; protected routers are **not** aliased
  outside `/api`.
- Error handler unchanged in behavior (renamed unused `next` → `_next` for lint).

### Changed: `backend/src/server.js`

- Resolves the port via `resolveExpressPort`, then `await assertPortAvailable(port)` **before**
  `initDb()` and Socket.IO attach.
- Logs `Express server listening on <port> (API prefix /api)`.
- Socket.IO construction and event contracts unchanged.

### Changed: `frontend/vite.config.js`

- `const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:2785'`.
- Both `/api/` and `/socket.io` proxy to it.
- Default is unchanged, so the existing NestJS dev workflow is intact; pointing at Express is opt-in
  via env.

### Changed: `backend/package.json`

- Added `start:express` and `start:express:dev`. **`start`, `start:prod`, and `prod` are unchanged**
  and still run `src/main.js`.

### New focused tests

- `backend/src/app.spec.js` (9 tests): prefix constant, `/api/health`, `/api/health/live`, `/health`
  alias, readiness 503 without a DB, `/api/sessions` 401, session sub-route 401, `/sessions` 404,
  `/api/api/sessions` 404.
- `backend/src/config/express-server.spec.js` (6 tests): default 2785, explicit override, blank =
  unset, invalid values throw, free-port resolve, in-use reject with the listener still alive.
- `backend/src/modules/health/health.router.spec.js` (10 tests): liveness body/version disclosure
  (header + Bearer), invalid key, unavailable key store, static `/live`, readiness up/down/reject/
  timeout.

No repetitive suite was added; only behavior changed in this phase is covered.

## 4. Express route prefix and port behavior

| Requirement | Result |
| --- | --- |
| All Express API routes under `/api` | Yes: `/api/health*`, `/api/sessions*` |
| Session paths preserved relative to prefix | Yes: `/api/sessions`, `/api/sessions/:id`, `/:id/start`, `/:id/stop`, `/:id/logout`, `/:id/force-kill`, `/:id/qr`, `/:id/pairing-code`, `/:id/config`, `/:id/proxy` |
| No double prefix | `/api/api/sessions` → 404 |
| Protected routes not exposed unprefixed | `/sessions` → 404 |
| Auth preserved | `/api/sessions` and `/api/sessions/abc/start` → 401 without a key |
| `EXPRESS_PORT` wins | `EXPRESS_PORT=3997` → listening on 3997 |
| Default is 2785 | `resolveExpressPort({}) === 2785`; boot attempt targeted 2785 |
| Conflict preflight | 2785 occupied by Nest → Express exited 1 with a clear message; Nest kept serving |

Observed runtime (Express on `EXPRESS_PORT=3997`, Nest untouched on 2785):

```
/api/health          -> 200 {"status":"ok","timestamp":"..."}
/health              -> 200 {"status":"ok","timestamp":"..."}
/api/health/live     -> 200 {"status":"ok"}
/api/health/ready    -> 200 {"status":"ok","details":{"dataDatabase":{"status":"up"}}}
/api/sessions        -> 401
/api/sessions/abc/start -> 401
/sessions            -> 404
/api/api/sessions    -> 404
```

## 5. Health endpoint parity

| Aspect | NestJS | Express | Parity |
| --- | --- | --- | --- |
| `/api/health` body | `{status,timestamp,version?}` | same | ✅ |
| Version disclosure | valid key only, public route | same (`X-API-Key` or Bearer) | ✅ |
| Invalid key on `/api/health` | 200, no version | 200, no version | ✅ |
| `/api/health/live` | `{status:'ok'}`, no dependency | same | ✅ |
| `/api/health/ready` semantics | 200 only when deps up; 503 otherwise | 200 only when the Express datasource answers; 503 otherwise | ✅ semantics |
| `/api/health/ready` details keys | `mainDatabase` + `dataDatabase` | `dataDatabase` only | ⚠️ see §8 |
| Draining → 503 | Yes (`ShutdownService`) | Not implemented in Express | ⚠️ see §8 |
| `/health` alias | 404 on Nest | 200 on Express | ✅ additive only |

## 6. Frontend proxy behavior

- Default target remains `http://localhost:2785` (NestJS), so `npm run dev` is unchanged.
- `VITE_API_PROXY_TARGET` overrides both the `/api/` and `/socket.io` targets, so the dashboard can
  be pointed at Express without editing the config or changing the production API origin.
- The SPA keeps using same-origin `/api`, which is exactly what Express now serves.
- No change to `VITE_API_URL` handling in `frontend/src/services/api.js`.

## 7. Tests executed

| Command | Result |
| --- | --- |
| `npx jest src/app.spec.js src/config/express-server.spec.js src/modules/health/health.router.spec.js` | **3 suites / 25 tests passed** |
| `npx jest src/modules/session/session.router.spec.js src/modules/session/session-lifecycle.service.spec.js src/modules/session/session-engine.provider.spec.js` | **3 suites / 63 tests passed** (the existing targeted set) |
| Combined run of the six suites above | **6 suites / 88 tests passed** |
| `npx jest src/modules/health/health.controller.spec.js src/config/app-validation.spec.js` | **2 suites / 26 tests passed** (Nest contract untouched) |
| `npx eslint` on the 7 created/modified backend files | **0 errors** |
| Runtime smoke on `EXPRESS_PORT=3997` | all routes above as expected |
| Runtime smoke on default `2785` | correctly refused; Nest stayed up |

No real WhatsApp authentication was run and no production session data was modified.

## 8. Unresolved compatibility differences

1. **Single datasource / auth DB not wired (pre-existing, blocks real CRUD).**
   `backend/src/database/index.js` opens one TypeORM datasource. With `DATABASE_NAME` from
   `data/.env.generated`, that is `data/openwa.sqlite` (sessions), while `api_keys` lives in
   `data/main.sqlite`. Consequences observed:
   - `GET /api/sessions` without a key → 401 (correct).
   - `GET /api/sessions` with a key → **500**, because the `ApiKey` lookup cannot resolve against the
     data DB.
   This is a data-layer/module-migration concern, not an API-prefix concern, and was deliberately not
   changed in Phase 4.2. Real end-to-end CRUD with a key is therefore **not yet verifiable**; route
   mounting and CRUD semantics are covered by tests.
2. **Readiness detail keys.** Express reports only `dataDatabase` because it probes only the
   datasource it owns. It does not claim `mainDatabase` is up without probing it. Status-code
   semantics match NestJS.
3. **Draining readiness.** Nest flips readiness to 503 while shutting down; Express has no shutdown
   service yet, so it has no draining state.
4. **Middleware parity not in scope.** Rate limiting/throttler, request IDs, body-size budget,
   OpenAPI/docs, CSP nonce, and the trailing-slash DELETE refusal are still Nest-only.
5. **`/health` alias scope.** The alias serves `/health`, `/health/live`, and `/health/ready` (all
   public). It does not alias any protected router.
6. **Lint baseline.** The pre-existing Express scaffold files (`session.router.js`,
   `session.express.service.js`, `auth.express.service.js`) already fail the repo's prettier lint.
   The seven files created/modified in this phase are lint-clean; the older scaffold was left
   untouched to avoid unrelated refactoring.

## 9. Entrypoint confirmation

- `backend/package.json` `start`, `start:prod`, and `prod` still execute `node src/main.js` (NestJS).
- No NestJS file was removed, renamed, or modified in this phase.
- During verification NestJS continued serving `http://localhost:2785/api/health` → 200. It was not
  terminated.
- Express is opt-in via `npm run start:express` (or `node src/server.js`).

## 10. Phase boundary

Phase 4.2 stops here. Session route parity (the 16 remaining Nest session routes) and Phase 5 module
migration are **not** started.
