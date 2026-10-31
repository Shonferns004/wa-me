"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeOnWebhookSubscribe = makeOnWebhookSubscribe;
function makeOnWebhookSubscribe(deps) {
    let unknownRouteWarned = false;
    return (route) => {
        if (!deps.hasPermission)
            return; // no ingress permission => the plugin claims no routes at all
        if (deps.declaredRoutes.has(route) || unknownRouteWarned)
            return;
        unknownRouteWarned = true; // warn at most once per plugin so a flood isn't a log-flood vector
        deps.warn(`Sandboxed plugin ${deps.pluginId} subscribed to an undeclared ingress route; ignoring`, {
            pluginId: deps.pluginId,
            route,
            action: 'sandbox_unknown_ingress_route',
        });
    };
}
