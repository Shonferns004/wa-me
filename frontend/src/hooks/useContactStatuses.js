import { useQuery } from '@tanstack/react-query';
import { sessionApi } from '../services/api';
export function useContactStatuses(sessionId, enabled = true) {
    return useQuery({
        queryKey: ['contact-statuses', sessionId],
        queryFn: async () => (await sessionApi.getContactStatuses(sessionId)).statuses,
        enabled: Boolean(sessionId) && enabled,
    });
}
