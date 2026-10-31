"use strict";
/**
 * Wire protocol between the host (PluginWorkerHost) and a plugin worker.
 *
 * These messages are the worker's channel to the `ctx.*` capabilities, and the host validates every
 * request against the manifest's permissions before acting on it. They are not the worker's only way
 * out: the worker is a thread in the host process and can use Node built-ins directly, so this is
 * fault containment, not a security boundary (see worker-bootstrap.ts and docs/30).
 *
 * Covers the lifecycle, capability calls, hooks, ingress webhooks, search, health checks and the
 * liveness ping.
 */
Object.defineProperty(exports, "__esModule", { value: true });
