"use strict";
/**
 * HTTP RED metrics — request rate + duration, recorded per route — emitted in Prometheus text
 * exposition format alongside the business metrics in MetricsService.render().
 *
 * Kept dependency-free (no prom-client), mirroring webhook-delivery-metrics.ts: an in-process store
 * that resets only on restart (Prometheus counters handle a restart as a reset, which rate()/
 * increase() already tolerate). Conventional unprefixed names (http_requests_total,
 * http_request_duration_seconds) so a generic RED dashboard/alert matches them.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordHttpRequest = recordHttpRequest;
exports.renderHttpRequestMetrics = renderHttpRequestMetrics;
exports.resetHttpRequestMetrics = resetHttpRequestMetrics;
// Prometheus-default-style buckets covering typical web request latencies (seconds).
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// Composite keys keep a single observation's labels grouped without mutating the stored values.
const requestCounts = new Map();
const requestDurations = new Map();
function escapeLabelValue(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
/**
 * Record one HTTP request: increments the `{method,route,status}` counter and observes the duration
 * in the `{method,route}` histogram (cumulative buckets + sum + count).
 */
function recordHttpRequest(method, route, status, durationSeconds) {
    const methodLabel = method.toUpperCase();
    const statusLabel = String(status);
    const ckey = `${methodLabel}|${route}|${statusLabel}`;
    const counter = requestCounts.get(ckey);
    if (counter) {
        counter.count += 1;
    }
    else {
        requestCounts.set(ckey, { method: methodLabel, route, status: statusLabel, count: 1 });
    }
    const hkey = `${methodLabel}|${route}`;
    let histogram = requestDurations.get(hkey);
    if (!histogram) {
        histogram = {
            method: methodLabel,
            route,
            buckets: Array.from({ length: DURATION_BUCKETS.length }, () => 0),
            sum: 0,
            count: 0,
        };
        requestDurations.set(hkey, histogram);
    }
    histogram.sum += durationSeconds;
    histogram.count += 1;
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
        if (durationSeconds <= DURATION_BUCKETS[i])
            histogram.buckets[i] += 1;
    }
}
/** Render the RED metrics as Prometheus text-exposition lines (empty until something is recorded). */
function renderHttpRequestMetrics() {
    const lines = [];
    if (requestCounts.size === 0 && requestDurations.size === 0)
        return lines;
    if (requestCounts.size > 0) {
        lines.push('# HELP http_requests_total Total HTTP requests by method, route, and HTTP status.');
        lines.push('# TYPE http_requests_total counter');
        for (const c of requestCounts.values()) {
            lines.push(`http_requests_total{method="${escapeLabelValue(c.method)}",route="${escapeLabelValue(c.route)}",status="${escapeLabelValue(c.status)}"} ${c.count}`);
        }
    }
    if (requestDurations.size > 0) {
        lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds.');
        lines.push('# TYPE http_request_duration_seconds histogram');
        for (const h of requestDurations.values()) {
            const labels = `method="${escapeLabelValue(h.method)}",route="${escapeLabelValue(h.route)}"`;
            for (let i = 0; i < DURATION_BUCKETS.length; i++) {
                lines.push(`http_request_duration_seconds_bucket{${labels},le="${DURATION_BUCKETS[i]}"} ${h.buckets[i]}`);
            }
            lines.push(`http_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.count}`);
            lines.push(`http_request_duration_seconds_sum{${labels}} ${h.sum}`);
            lines.push(`http_request_duration_seconds_count{${labels}} ${h.count}`);
        }
    }
    return lines;
}
/** Reset all RED series (test-only; the live process never calls this). */
function resetHttpRequestMetrics() {
    requestCounts.clear();
    requestDurations.clear();
}
