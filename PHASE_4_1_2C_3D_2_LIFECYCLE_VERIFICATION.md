# Phase 4.1.2C-3D-2 Session Lifecycle Verification

## Scope

Express replacement for the NestJS `SessionEngineControls` surface: start, stop, logout, force-kill,
delete, QR and pairing-code, plus the authenticated router that exposes them.

## Endpoint parity

| NestJS | Express | Notes |
| --- | --- | --- |
| `GET /sessions` | `GET /sessions` | Decorated with `engineLoaded` / `lastError`. |
| `POST /sessions` | `POST /sessions` | Duplicate name → 409. |
| `GET /sessions/:id` | `GET /sessions/:id` | 404 when missing. |
| `DELETE /sessions/:id` | `DELETE /sessions/:id` | Stops engine, purges both credential dirs, deletes row. |
| `POST /sessions/:id/start` | `POST /sessions/:id/start` | Registers engine, persists `initializing`, init timeout → 504. |
| `POST /sessions/:id/stop` | `POST /sessions/:id/stop` | Graceful disconnect, escalates to `forceDestroy`. |
| `POST /sessions/:id/logout` | `POST /sessions/:id/logout` | Unlinks device, clears phone, deletes credentials. |
| `POST /sessions/:id/force-kill` | `POST /sessions/:id/force-kill` | Kills engine, preserves credentials. |
| `GET /sessions/:id/qr` | `GET /sessions/:id/qr` | Distinguishes “already authenticated” from “not ready yet”. |
| `POST /sessions/:id/pairing-code` | `POST /sessions/:id/pairing-code` | 201; rejects a ready session. |
| `GET /sessions/:id/config` | `GET /sessions/:id/config` | Read-only projection. |
| `GET /sessions/:id/proxy` | `GET /sessions/:id/proxy` | Read-only projection. |

## Behavior parity

- `stop()` disconnects first and only escalates to `forceDestroy()` when the graceful teardown
  rejects; the engine is unregistered in both cases.
- `logout()` requires a live engine, lets the engine remove its credentials, clears `phone` and
  persists `desiredState: 'stopped'`.
- `forceKill()` requires a live engine and never touches the credential directories.
- `deleteSession()` stops the engine and purges **both** whatsapp-web.js and Baileys auth directories,
  including the legacy name directory when the row name differs from its id.
- Engine callbacks are identity-guarded by `EngineRegistry.isLive`: a late callback from a stopped or
  superseded engine cannot mutate the current row.
- Per-session read-modify-write updates are serialized through a write chain, so a status write cannot
  clobber a concurrently written phone number.
- Terminal `onError` retires the engine, records `lastError` (transient, not persisted) and marks the
  row `failed`.

## Security fixes

- Every session route is behind API-key auth. The C-3D-1 scaffold routes
  (`/sessions/baileys/:id/connect|status`) were unauthenticated and joined the raw path segment into
  the credential directory; they were removed in favor of the lifecycle router.
- `allowedSessions` scoping is enforced with NestJS `@SessionScoped()` parity: a restricted key only
  sees its sessions in `GET /sessions` and receives 403 on every `/:id` route outside its scope.
- `SessionEngineProvider` validates ids with `isSafeSessionName` before creating or deleting auth
  directories, closing the path-traversal risk raised in the C-3A audit.
- Both credential directories are created owner-only (`ensurePrivateDir`, mode `0700`) before the
  plugin is invoked, matching the NestJS EngineFactory.
- Partial teardowns return stable codes (`SESSION_STOP_INCOMPLETE`, `SESSION_LOGOUT_INCOMPLETE`,
  `SESSION_FORCE_KILL_INCOMPLETE`) so clients can distinguish a retryable 502 from a plain failure.

## Tests

Added:

- `backend/src/modules/session/session-lifecycle.service.spec.js` — 36 tests: start/stop/logout/
  force-kill/delete, max-concurrency, init timeout, QR/pairing, callback persistence and stale-engine
  isolation, write serialization.
- `backend/src/modules/session/session-engine.provider.spec.js` — 9 tests: engine construction,
  private-dir hardening, unsafe-id rejection, credential purge (id + legacy name).
- `backend/src/modules/session/session.router.spec.js` — 18 tests: auth, allowedSessions scoping,
  CRUD status codes, lifecycle delegation, pairing 201, and status/code preservation for partial
  teardowns.

Existing suites re-run: session CRUD/HTTP, Express auth, WebSocket authorization and event delivery.

Result:

- Targeted lifecycle/router/auth/WebSocket run → **7 suites / 104 tests passed**.
- `npx jest src/modules/session src/websocket --runInBand` → **64 suites passed, 1 failed, 1349 tests
  passed**. The single failure is the pre-existing Windows symlink test in
  `session-auth-dir-migration.service.spec.js`: `EPERM: operation not permitted, symlink`, unrelated
  to this phase (it needs Developer Mode / elevated symlink rights).
- Boot smoke test: `GET /health` → 200; `GET /sessions` without a key → 401; removed legacy route
  now falls through the authenticated router → 401.

## Limitations

- No real-device lifecycle run yet (QR scan / pairing / unlink against WhatsApp).
- Ownership leases, multi-node forwarding, automatic reconnect orchestration, audit logging and
  webhooks remain in later phases.
- The Express registry is process-local; a second node cannot see or stop this node’s engines.

## Verdict

**PASS WITH LIMITATIONS.** API and teardown semantics match the NestJS surface, the audit’s
path-traversal and unauthenticated-route findings are fixed, and the new behavior is covered by
tests. Remaining work is real-device verification and the later-phase orchestration features.
