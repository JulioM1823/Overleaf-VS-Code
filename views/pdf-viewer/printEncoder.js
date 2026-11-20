// Encode one print page at a time off the webview's main thread. Chromium's
// main-thread PNG encoder may wait for an idle deadline on every toBlob call.
(function (root) {
    'use strict';
    const scriptUrl = root.document?.currentScript?.src;
    class PrintEncoder {
        constructor(workerUrl, environment = root) {
            this.environment = environment;
            this.closed = false;
            this.sequence = 0;
            this.pending = new Map();
            this.abort = new environment.AbortController();
            this.startupTimer = environment.setTimeout(() => this.abort.abort(), 15_000);
            this.ready = this.initialize(workerUrl).catch(error => {
                this.failure = error;
                this.dispose();
            }).finally(() => environment.clearTimeout(this.startupTimer));
        }
        async initialize(workerUrl) {
            const env = this.environment;
            const response = await env.fetch(workerUrl, {signal: this.abort.signal, credentials: 'omit'});
            if (!response.ok) { throw new Error('Print encoder is unavailable.'); }
            const bytes = await response.blob();
            if (this.closed) { return; }
            this.workerObjectUrl = env.URL.createObjectURL(bytes);
            this.worker = new env.Worker(this.workerObjectUrl);
            this.worker.onmessage = event => {
                const item = this.pending.get(event.data?.id);
                if (!item) { return; }
                this.pending.delete(event.data.id);
                env.clearTimeout(item.timer);
                if (event.data.blob) { item.resolve(event.data.blob); }
                else { item.reject(new Error('Print page could not be encoded.')); }
            };
            this.worker.onerror = event => {
                event.preventDefault?.();
                this.failure = new Error('Print encoder failed.');
                this.dispose();
            };
            this.worker.onmessageerror = this.worker.onerror;
        }
        async encode(canvas) {
            await this.ready;
            if (this.closed) { throw this.failure || new Error('Print encoding was cancelled.'); }
            const bitmap = await this.environment.createImageBitmap(canvas);
            if (this.closed) {
                bitmap.close();
                throw new Error('Print encoding was cancelled.');
            }
            const id = ++this.sequence;
            return new Promise((resolve, reject) => {
                const timer = this.environment.setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error('Print encoder timed out.'));
                    this.dispose();
                }, 15_000);
                this.pending.set(id, {resolve, reject, timer});
                try { this.worker.postMessage({id, bitmap}, [bitmap]); }
                catch (error) {
                    this.environment.clearTimeout(timer);
                    this.pending.delete(id);
                    bitmap.close();
                    reject(error);
                }
            });
        }
        dispose() {
            if (this.closed) { return; }
            this.closed = true;
            this.abort.abort();
            this.environment.clearTimeout(this.startupTimer);
            this.worker?.terminate();
            if (this.workerObjectUrl) { this.environment.URL.revokeObjectURL(this.workerObjectUrl); }
            for (const item of this.pending.values()) {
                this.environment.clearTimeout(item.timer);
                item.reject(new Error('Print encoding was cancelled.'));
            }
            this.pending.clear();
        }
    }
    const api = {
        PrintEncoder,
        create() {
            if (!scriptUrl || typeof root.Worker !== 'function' || typeof root.createImageBitmap !== 'function'
                || typeof root.OffscreenCanvas?.prototype?.convertToBlob !== 'function') { return null; }
            return new PrintEncoder(new URL('printEncoderWorker.js', scriptUrl).toString());
        },
    };
    if (typeof module === 'object' && module.exports) { module.exports = api; }
    else { root.OverleafPdfPrintEncoder = api; }
}(globalThis));
