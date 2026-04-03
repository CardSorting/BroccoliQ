export class Mutex {
	private queue: (() => void)[] = [];
	private locked = false;

	constructor(public name: string) {}

	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true;
			return () => this.release();
		}

		return new Promise((resolve) => {
			this.queue.push(() => resolve(() => this.release()));
		});
	}

	private release() {
		const next = this.queue.shift();
		if (next) {
			next();
		} else {
			this.locked = false;
		}
	}
}
