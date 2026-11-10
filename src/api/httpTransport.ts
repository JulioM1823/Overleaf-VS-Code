import fetch, { RequestInfo, RequestInit } from 'node-fetch';

/** Bound the entire request, including body consumption. Abort destroys the
 * socket; node-fetch's legacy body timeout merely rejects and leaves resources
 * behind on some error paths. Never retry a possibly committed mutation here. */
export async function fetchWithLimits(url: RequestInfo, options: RequestInit = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, options.timeout ?? 60_000);
    timeout.unref();
    const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort);
    if (options.signal?.aborted) { abort(); }
    try {
        const response = await fetch(url, {
            size: 64 * 1024 * 1024, ...options, timeout: 0, signal: controller.signal,
        });
        response.body.once('end', cleanup);
        response.body.once('error', cleanup);
        response.body.once('close', cleanup);
        return response;
    } catch (error) {
        cleanup();
        throw error;
    }
}
