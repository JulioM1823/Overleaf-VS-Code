interface Batch<T> {
    value: T,
    promise: Promise<void>,
    resolve: () => void,
    reject: (error: unknown) => void,
}

/** Complete snapshots supersede earlier snapshots waiting behind an active
 * write. Keep at most one active and one pending payload. Never use for deltas
 * or ordered user operations. Every caller observes the write covering it. */
export class LatestTaskQueue<T> {
    private active?: Batch<T>;
    private pending?: Batch<T>;

    constructor(private readonly write: (value: T) => Promise<void>) {}

    enqueue(value: T): Promise<void> {
        if (this.pending) {
            this.pending.value = value;
            return this.pending.promise;
        }
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
        const batch = {value, promise, resolve, reject};
        if (this.active) { this.pending = batch; }
        else { this.start(batch); }
        return promise;
    }

    private start(batch: Batch<T>) {
        this.active = batch;
        // Both success and failure advance the queue. Keep the rejected write
        // observable on batch.promise without creating an unhandled chain.
        Promise.resolve().then(() => this.write(batch.value)).then(
            () => this.finish(batch, true), error => this.finish(batch, false, error),
        );
    }

    private finish(batch: Batch<T>, succeeded: boolean, error?: unknown) {
        const pending = this.pending;
        this.pending = undefined;
        this.active = undefined;
        if (pending) { this.start(pending); }
        if (succeeded) { batch.resolve(); } else { batch.reject(error); }
    }

    async idle() {
        while (this.active) { await this.active.promise.catch(() => undefined); }
    }
}
