import { useQuery } from '@tanstack/react-query';
import { sessionApi } from '../services/api';
/** Fetches a channel's recent posts. Disabled until both ids are present; mirrors useChatMessages' shape. */
export function useChannelMessages(sessionId, channelId) {
    return useQuery({
        queryKey: ['channel-messages', sessionId, channelId],
        queryFn: () => sessionApi.getChannelMessages(sessionId, channelId),
        enabled: Boolean(sessionId && channelId),
    });
}
