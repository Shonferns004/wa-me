function wait(ms, signal) {
    return new Promise(resolve => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish);
    });
}
function toFailure(target, err) {
    const status = err?.status;
    const error = err instanceof Error ? err.message : String(err);
    return typeof status === 'number' ? { target, error, status } : { target, error };
}
export async function sendSequentially(targets, send, { delayMs, signal, stopOn, sleep = wait, onProgress }) {
    const failures = [];
    let sent = 0;
    for (const [index, target] of targets.entries()) {
        if (index > 0)
            await sleep(delayMs, signal);
        if (signal?.aborted)
            return { sent, failures, notAttempted: targets.slice(index), stoppedBy: 'abort' };
        onProgress?.(index + 1, targets.length);
        try {
            await send(target);
            sent += 1;
        }
        catch (err) {
            failures.push(toFailure(target, err));
            if (stopOn?.(err))
                return { sent, failures, notAttempted: targets.slice(index + 1), stoppedBy: 'refusal' };
        }
    }
    return { sent, failures, notAttempted: [] };
}
