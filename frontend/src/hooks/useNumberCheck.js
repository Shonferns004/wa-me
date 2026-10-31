import { createContext, useContext } from 'react';
// What each stopping status means, so a single unanswered lookup is not reported as the gateway refusing.
// The check route answers 400 only for a session that is not started, the same condition as a 409.
const STOP_REASON_KEYS = {
    400: 'numberChecker.stopped.reason409',
    409: 'numberChecker.stopped.reason409',
    429: 'numberChecker.stopped.reason429',
    503: 'numberChecker.stopped.reason503',
};
// `attempted` counts the lookup that stopped the run, which is the last one sent; only the rest were never sent.
export function batchStopMessage(t, { status, attempted, total }) {
    if (status === 0)
        return t('numberChecker.stopped.noAnswer', { attempted, total });
    const reason = t(STOP_REASON_KEYS[status] ?? 'numberChecker.stopped.reasonOther');
    const unsent = total - attempted;
    return unsent > 0
        ? t('numberChecker.stopped.partial', { reason, status, attempted, total, count: unsent })
        : t('numberChecker.stopped.last', { reason, status });
}
export const DEFAULT_BATCH_DELAY = 1000;
export const IDLE_RUN = {
    running: false,
    session: '',
    numbers: [],
    delay: DEFAULT_BATCH_DELAY,
    results: [],
    progress: { current: 0, total: 0 },
    stopped: null,
};
export const NumberCheckContext = createContext(undefined);
export function useNumberCheck() {
    const context = useContext(NumberCheckContext);
    if (context === undefined) {
        throw new Error('useNumberCheck must be used within a NumberCheckProvider');
    }
    return context;
}
