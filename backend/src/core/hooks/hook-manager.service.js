"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var HookManager_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.HookManager = void 0;
exports.normalizeHookPriority = normalizeHookPriority;
const common_1 = require("@nestjs/common");
const logger_service_1 = require("../../common/services/logger.service");
const node_async_hooks_1 = require("node:async_hooks");
const node_util_1 = require("node:util");
/**
 * The priority a registration actually runs at: a finite number as given, anything else the default
 * 100. The chain is sorted by `a.priority - b.priority`; one NaN or string in it makes the comparator
 * return NaN and the order of EVERY handler for that event implementation-defined (a veto can land
 * after a rewrite). Sandboxed plugins send their priority over IPC, so no type can be assumed.
 */
function normalizeHookPriority(priority) {
    return typeof priority === 'number' && Number.isFinite(priority) ? priority : 100;
}
let HookManager = HookManager_1 = class HookManager {
    logger = (0, logger_service_1.createLogger)(HookManager_1.name);
    hooks = new Map();
    pluginHooks = new Map(); // pluginId -> hookIds
    // Events in-flight on the active async context. A handler that re-fires the SAME event
    // (e.g. a message:sending handler that sends) is short-circuited instead of recursing.
    // NOTE: the context does not span the async engine `message_create` echo, so this guards
    // synchronous re-entry only (the async message:sent echo loop is documented, deferred).
    // Each scope is the event set of one execute()/runInFlight() call. It is emptied when that call settles,
    // because the store also reaches every timer and detached promise the call's handlers start.
    inFlightEvents = new node_async_hooks_1.AsyncLocalStorage();
    nextHookId = 0;
    /**
     * Register a hook handler
     */
    register(pluginId, event, handler, priority = 100) {
        const id = `${pluginId}:${event}:${this.nextHookId++}`;
        const registration = {
            id,
            pluginId,
            event,
            handler,
            priority: normalizeHookPriority(priority),
        };
        // Add to event handlers
        if (!this.hooks.has(event)) {
            this.hooks.set(event, []);
        }
        this.hooks.get(event).push(registration);
        // Sort by priority
        this.hooks.get(event).sort((a, b) => a.priority - b.priority);
        // Track plugin's hooks for cleanup
        if (!this.pluginHooks.has(pluginId)) {
            this.pluginHooks.set(pluginId, new Set());
        }
        this.pluginHooks.get(pluginId).add(id);
        this.logger.debug(`Hook registered: ${event} by ${pluginId} (priority: ${registration.priority})`);
        return id;
    }
    /**
     * Unregister a specific hook by ID
     */
    unregister(hookId) {
        for (const registrations of this.hooks.values()) {
            const index = registrations.findIndex(r => r.id === hookId);
            if (index !== -1) {
                const registration = registrations[index];
                registrations.splice(index, 1);
                // Remove from plugin tracking
                const pluginHookIds = this.pluginHooks.get(registration.pluginId);
                if (pluginHookIds) {
                    pluginHookIds.delete(hookId);
                }
                this.logger.debug(`Hook unregistered: ${hookId}`);
                return;
            }
        }
    }
    /** Move an existing registration to `priority` (normalized like {@link register}) and re-sort its chain. */
    setPriority(hookId, priority) {
        for (const registrations of this.hooks.values()) {
            const registration = registrations.find(r => r.id === hookId);
            if (!registration)
                continue;
            registration.priority = normalizeHookPriority(priority);
            registrations.sort((a, b) => a.priority - b.priority);
            return;
        }
    }
    /**
     * Unregister all hooks for a plugin
     */
    unregisterPlugin(pluginId) {
        const hookIds = this.pluginHooks.get(pluginId);
        if (!hookIds)
            return;
        for (const [eventKey, registrations] of this.hooks.entries()) {
            const filtered = registrations.filter(r => r.pluginId !== pluginId);
            this.hooks.set(eventKey, filtered);
        }
        this.pluginHooks.delete(pluginId);
        this.logger.debug(`Unregistered all hooks for plugin: ${pluginId}`);
    }
    /**
     * Execute hooks for an event
     * Returns: { continue: boolean, data: T }
     */
    async execute(event, data, options) {
        if (this.isInFlight(event)) {
            this.logger.warn(`Hook re-entrancy blocked: ${event} re-fired by a handler of the same event (source: ${options.source})`);
            return { continue: true, data };
        }
        return this.runInFlight([event], () => this.runHandlers(event, data, options));
    }
    /**
     * Run `fn` with `events` marked in-flight on the active async context (merged with anything already
     * in flight). The re-entrancy guard in {@link execute} relies on AsyncLocalStorage, which does not
     * span the sandbox worker IPC boundary: a worker handling a hook can issue a capability call that
     * returns to the host on a fresh async context, where `getStore()` is empty. Wrapping that
     * round-trip in this method re-establishes the in-flight set so a capability that re-fires the same
     * in-flight event is short-circuited exactly as an in-process handler would be.
     * The events stay in flight until `fn` settles (a native Promise) or returns; work it leaves running
     * afterwards is no longer treated as re-entrant.
     */
    runInFlight(events, fn) {
        const scope = new Set(events);
        const scopes = [...(this.inFlightEvents.getStore() ?? []).filter(parent => parent.size > 0), scope];
        return this.inFlightEvents.run(scopes, () => {
            let result;
            try {
                result = fn();
            }
            catch (error) {
                scope.clear();
                throw error;
            }
            if (node_util_1.types.isPromise(result)) {
                void Promise.prototype.then.call(result, () => scope.clear(), () => scope.clear());
            }
            else {
                scope.clear();
            }
            return result;
        });
    }
    /** True if `event` is already in-flight on the active async context (an ancestor handler is running
     *  it). Lets a caller wrap a capability in {@link runInFlight} ONLY for genuine re-entrancy, instead
     *  of unconditionally seeding the event and suppressing it for unrelated observers on a top-level call. */
    isInFlight(event) {
        return this.inFlightEvents.getStore()?.some(scope => scope.has(event)) ?? false;
    }
    /** Every event in flight on the active async context, for a caller that must carry the chain across a
     *  boundary AsyncLocalStorage does not span (the sandbox worker IPC) and re-establish it with
     *  {@link runInFlight} on the way back. */
    currentInFlight() {
        return [...new Set((this.inFlightEvents.getStore() ?? []).flatMap(scope => [...scope]))];
    }
    async runHandlers(event, data, options) {
        // A snapshot: a registration added or moved while this chain awaits a handler (a sandboxed plugin
        // re-subscribing at a lower priority) must not make the loop skip or repeat one.
        const registrations = [...(this.hooks.get(event) ?? [])];
        if (registrations.length === 0) {
            return { continue: true, data };
        }
        let currentData = data;
        const ctx = {
            event,
            data: currentData,
            sessionId: options.sessionId,
            timestamp: new Date(),
            source: options.source,
        };
        for (const registration of registrations) {
            try {
                ctx.data = currentData;
                const result = await registration.handler(ctx);
                // A handler that reports an error discards its output: do NOT apply its (possibly partial or
                // corrupted) data mutation, even though HookResult allows returning data and error together.
                // A result the caller cannot use is dropped the same way, so the chain keeps the last usable
                // value (an earlier handler's redaction included) instead of the caller falling back to the input.
                if (result.error === undefined && result.data !== undefined) {
                    if (options.accept && !options.accept(result.data)) {
                        this.logger.warn(`Hook result from ${registration.pluginId} for ${event} is not usable; keeping the previous data`);
                    }
                    else {
                        currentData = result.data;
                    }
                }
                if (!result.continue) {
                    this.logger.debug(`Hook chain stopped by ${registration.pluginId} at event ${event}`);
                    return { continue: false, data: currentData };
                }
                if (result.error) {
                    throw result.error;
                }
            }
            catch (error) {
                this.logger.error(`Hook error in ${registration.pluginId} for ${event}: ${error instanceof Error ? error.message : String(error)}`);
                // Continue to next handler, don't break the chain on error
            }
        }
        return { continue: true, data: currentData };
    }
    /**
     * Check if any hooks are registered for an event
     */
    hasHooks(event) {
        const registrations = this.hooks.get(event);
        return registrations !== undefined && registrations.length > 0;
    }
    /**
     * Get count of registered hooks for an event
     */
    getHookCount(event) {
        return this.hooks.get(event)?.length || 0;
    }
    /**
     * Get registered hooks info (for debugging/dashboard)
     */
    getRegisteredHooks() {
        const result = {};
        for (const [event, registrations] of this.hooks.entries()) {
            result[event] = registrations.map(r => ({
                pluginId: r.pluginId,
                priority: r.priority,
            }));
        }
        return result;
    }
    /**
     * Get all events that a plugin has registered
     */
    getPluginEvents(pluginId) {
        const events = [];
        for (const [event, registrations] of this.hooks.entries()) {
            if (registrations.some(r => r.pluginId === pluginId)) {
                events.push(event);
            }
        }
        return events;
    }
};
exports.HookManager = HookManager;
exports.HookManager = HookManager = HookManager_1 = __decorate([
    (0, common_1.Injectable)()
], HookManager);
