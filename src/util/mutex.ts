/** A FIFO async lock. `run` executes `fn` once every earlier holder has finished. */
export class Mutex {
    private tail: Promise<void> = Promise.resolve();
    private waiting = 0;

    get pending(): number {
        return this.waiting;
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.waiting++;
        const previous = this.tail;
        let release!: () => void;
        this.tail = new Promise<void>(resolve => (release = resolve));
        try {
            await previous;
            return await fn();
        } finally {
            this.waiting--;
            release();
        }
    }
}
