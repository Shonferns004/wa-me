# Phase 4.1.2C-3C-V Logout and Force-Kill Verification

## Original NestJS behavior (from controller)
- POST /sessions/:id/logout: unlink device, tear down locally, clear phone.
- POST /sessions/:id/force-kill: SIGKILL engine, tear down.

## Express behavior
- logout: disconnects, deletes session credential directory, updates status to disconnected, clears phone.
- force-kill: ends socket, updates status, does not delete credentials.

## Parity
- Logout credential deletion: MATCH (Express deletes auth dir).
- Force-kill preserves credentials: MATCH.
- Distinct behavior: MATCH.

## Safety
- Path resolution uses path.join(process.cwd(), 'data', 'sessions', 'baileys', id). Could be unsafe if id contains path traversal. Need validate UUID. Currently no validation. Risk.

## Verdict: PASS WITH LIMITATIONS
- Missing UUID validation on id for directory deletion.
- No real-world lifecycle verification.
- Existing tests (49 passed) do not cover actual logout/force-kill.

## Addendum (Phase 4.1.2C-3D-2)
- Id validation is fixed: `SessionEngineProvider.createEngine` / `purgeSessionData` reject unsafe ids
  with `isSafeSessionName` before any directory is created or deleted.
- Logout and force-kill now have service-level coverage in
  `backend/src/modules/session/session-lifecycle.service.spec.js` (credential deletion on logout,
  credential preservation on force-kill, partial-teardown codes).
- Real-device verification is still outstanding; see
  PHASE_4_1_2C_3D_2_LIFECYCLE_VERIFICATION.md.
