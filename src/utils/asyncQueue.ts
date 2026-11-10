/** Serializes state transitions without making a rejected task poison the queue. */
export class AsyncQueue {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.tail.then(task);
        this.tail = result.catch(() => undefined);
        return result;
    }

    async idle() { await this.tail; }
}
