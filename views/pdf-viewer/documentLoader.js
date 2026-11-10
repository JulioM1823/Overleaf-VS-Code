(function (root) {
    'use strict';

    // A task owns its PDF worker even after its document is displayed. Keep
    // the last working document until a replacement loads successfully.
    class PdfDocumentLoader {
        constructor(createTask, display, reportError) {
            this.createTask = createTask;
            this.display = display;
            this.reportError = reportError;
            this.generation = 0;
            this.disposed = false;
            this.released = new WeakMap();
            this.cleanup = Promise.resolve();
        }

        release(task) {
            if (!task || this.released.has(task)) { return; }
            let destruction;
            try { destruction = Promise.resolve(task.destroy()); }
            catch (error) { destruction = Promise.reject(error); }
            const finished = destruction.catch(() => this.reportError());
            this.released.set(task, finished);
            this.cleanup = Promise.all([this.cleanup, finished]).then(() => undefined);
        }

        async update(options) {
            if (this.disposed) { return false; }
            const generation = ++this.generation;
            this.release(this.loading);
            this.loading = undefined;
            await this.cleanup;
            if (this.disposed || generation!==this.generation) { return false; }
            let task;
            try {
                task = this.createTask(options);
                this.loading = task;
                const document = await task.promise;
                if (this.disposed || generation!==this.generation) {
                    this.release(task);
                    return false;
                }
                this.display(document);
                const previous = this.current;
                this.current = task;
                this.loading = undefined;
                this.release(previous);
                return true;
            } catch (_error) {
                this.release(task);
                if (this.loading===task) { this.loading = undefined; }
                if (!this.disposed && generation===this.generation) { this.reportError(); }
                return false;
            }
        }

        async dispose() {
            this.disposed = true;
            this.generation++;
            this.release(this.loading);
            this.release(this.current);
            this.loading = this.current = undefined;
            await this.cleanup;
        }
    }

    if (typeof module==='object' && module.exports) { module.exports = {PdfDocumentLoader}; }
    else { root.OverleafPdfDocumentLoader = PdfDocumentLoader; }
}(globalThis));
