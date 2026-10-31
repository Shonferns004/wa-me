import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionApi, webhookApi, templateApi, apiKeyApi, auditApi, infraApi, pluginsApi, pluginInstancesApi, statsApi, } from '../services/api';
// ── Query Keys ────────────────────────────────────────────────────────
export const queryKeys = {
    sessions: ['sessions'],
    sessionStats: ['sessions', 'stats'],
    sessionGroups: (sessionId) => ['sessions', sessionId, 'groups'],
    sessionChats: (sessionId) => ['sessions', sessionId, 'chats'],
    webhooks: ['webhooks'],
    templates: (sessionId) => ['sessions', sessionId, 'templates'],
    apiKeys: ['apiKeys'],
    logs: (params) => ['logs', params],
    infraStatus: ['infra', 'status'],
    plugins: ['plugins'],
    pluginInstances: (pluginId) => ['plugins', pluginId, 'instances'],
    engines: ['engines'],
    currentEngine: ['engines', 'current'],
    statsOverview: ['stats', 'overview'],
    statsMessages: (period) => ['stats', 'messages', period],
};
// ── Session Queries ───────────────────────────────────────────────────
export function useSessionsQuery() {
    return useQuery({
        queryKey: queryKeys.sessions,
        queryFn: sessionApi.list,
        staleTime: 30_000,
    });
}
export function useSessionStatsQuery() {
    return useQuery({
        queryKey: queryKeys.sessionStats,
        queryFn: sessionApi.getStats,
        staleTime: 30_000,
    });
}
export function useSessionGroupsQuery(sessionId, enabled) {
    return useQuery({
        queryKey: queryKeys.sessionGroups(sessionId),
        queryFn: () => sessionApi.getGroups(sessionId),
        enabled: enabled && !!sessionId,
        staleTime: 60_000,
    });
}
export function useSessionChatsQuery(sessionId, enabled) {
    return useQuery({
        queryKey: queryKeys.sessionChats(sessionId),
        queryFn: ({ signal }) => sessionApi.getChats(sessionId, signal),
        enabled: enabled && !!sessionId,
        staleTime: 60_000,
    });
}
export function useStopSessionMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id) => sessionApi.stop(id),
        // A failed stop can still have changed the session, so the list is re-read either way.
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
        },
    });
}
// ── Webhook Queries ───────────────────────────────────────────────────
export function useWebhooksQuery(enabled = true) {
    return useQuery({
        queryKey: queryKeys.webhooks,
        queryFn: webhookApi.listAll,
        staleTime: 30_000,
        enabled,
        // Normalize `events` to an array at the data boundary so every consumer (list render + edit
        // modal) can trust the declared string[] shape. A malformed payload then renders as no tags
        // instead of taking down the whole SPA via events.map() in the ErrorBoundary.
        select: webhooks => webhooks.map(w => ({ ...w, events: Array.isArray(w.events) ? w.events : [] })),
    });
}
export function useCreateWebhookMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ sessionId, ...body }) => webhookApi.create(sessionId, body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
        },
    });
}
export function useUpdateWebhookMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (params) => webhookApi.update(params.sessionId, params.id, params.data),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
        },
    });
}
export function useDeleteWebhookMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (params) => webhookApi.delete(params.sessionId, params.id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
        },
    });
}
// ── Template Queries ─────────────────────────────────────────────────────────
export function useTemplatesQuery(sessionId, enabled = true) {
    return useQuery({
        queryKey: queryKeys.templates(sessionId),
        queryFn: () => templateApi.list(sessionId),
        enabled: enabled && !!sessionId,
        staleTime: 30_000,
    });
}
export function useCreateTemplateMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (params) => templateApi.create(params.sessionId, params.data),
        onSuccess: (_template, params) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
        },
    });
}
export function useUpdateTemplateMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (params) => templateApi.update(params.sessionId, params.id, params.data),
        onSuccess: (saved, params) => {
            // Swap the saved row into the list before the refetch lands (or fails), so reopening it in the meantime
            // loads the stored values rather than the pre-save ones that a second save would write back.
            queryClient.setQueryData(queryKeys.templates(params.sessionId), rows => rows?.map(row => (row.id === params.id ? saved : row)));
            void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
        },
    });
}
export function useDeleteTemplateMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (params) => templateApi.delete(params.sessionId, params.id),
        onSuccess: (_template, params) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
        },
    });
}
// ── API Key Queries ───────────────────────────────────────────────────
export function useApiKeysQuery() {
    return useQuery({
        queryKey: queryKeys.apiKeys,
        queryFn: apiKeyApi.list,
        staleTime: 30_000,
    });
}
export function useCreateApiKeyMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (data) => apiKeyApi.create(data),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
        },
    });
}
export function useUpdateApiKeyMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, data, }) => apiKeyApi.update(id, data),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
        },
    });
}
export function useDeleteApiKeyMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id) => apiKeyApi.delete(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
        },
    });
}
export function useRevokeApiKeyMutation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id) => apiKeyApi.revoke(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
        },
    });
}
// ── Logs Queries ──────────────────────────────────────────────────────
export function useLogsQuery(params) {
    return useQuery({
        queryKey: queryKeys.logs(params),
        queryFn: () => auditApi.list({
            severity: params.severity,
            limit: params.limit,
            offset: (params.page - 1) * params.limit,
        }),
        staleTime: 15_000,
    });
}
// ── Infrastructure Queries ────────────────────────────────────────────
export function useInfraStatusQuery() {
    return useQuery({
        queryKey: queryKeys.infraStatus,
        queryFn: infraApi.getStatus,
        staleTime: 30_000,
    });
}
export function useInfraConfigQuery() {
    return useQuery({
        queryKey: ['infra', 'config'],
        queryFn: infraApi.getConfig,
        staleTime: 30_000,
    });
}
// ── Plugin Queries ────────────────────────────────────────────────────
export function usePluginsQuery() {
    return useQuery({
        queryKey: queryKeys.plugins,
        queryFn: pluginsApi.list,
        staleTime: 30_000,
    });
}
export function usePluginInstancesQuery(pluginId, enabled) {
    return useQuery({
        queryKey: queryKeys.pluginInstances(pluginId),
        queryFn: () => pluginInstancesApi.list(pluginId),
        enabled,
        staleTime: 30_000,
    });
}
export function useCreateInstanceMutation(pluginId) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body) => pluginInstancesApi.create(pluginId, body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
        },
    });
}
export function useRegenerateInstanceSecretMutation(pluginId) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (instanceId) => pluginInstancesApi.regenerateSecret(pluginId, instanceId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
        },
    });
}
export function useUpdateInstanceMutation(pluginId) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (params) => pluginInstancesApi.update(pluginId, params.instanceId, params.body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
        },
    });
}
export function useDeleteInstanceMutation(pluginId) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (instanceId) => pluginInstancesApi.remove(pluginId, instanceId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
        },
    });
}
export function useEnginesQuery() {
    return useQuery({
        queryKey: queryKeys.engines,
        queryFn: pluginsApi.getEngines,
        staleTime: 60_000,
    });
}
export function useCurrentEngineQuery() {
    return useQuery({
        queryKey: queryKeys.currentEngine,
        queryFn: pluginsApi.getCurrentEngine,
        staleTime: 60_000,
    });
}
// ── Stats Queries ─────────────────────────────────────────────────────
// /stats/* is ADMIN-only; a non-admin key gets 403 → don't retry, let the UI fall back gracefully.
export function useStatsOverviewQuery(enabled = true) {
    return useQuery({
        queryKey: queryKeys.statsOverview,
        queryFn: statsApi.getOverview,
        staleTime: 30_000,
        retry: false,
        enabled,
    });
}
export function useStatsMessagesQuery(period) {
    return useQuery({
        queryKey: queryKeys.statsMessages(period),
        queryFn: () => statsApi.getMessages(period),
        staleTime: 30_000,
        retry: false,
    });
}
