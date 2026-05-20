export type PromptQueueItem = { content: string };

/**
 * Small FIFO queue with async waiting, used to serialize prompts until Claude
 * returns to an idle state.
 */
export class PromptQueue {
  private queue: PromptQueueItem[] = [];
  private waitResolvers: Array<(hasItem: boolean) => void> = [];
  private closed = false;

  /**
   * Adds an item and wakes one pending waiter.
   */
  enqueue(item: PromptQueueItem): void {
    if (this.closed) return;
    this.queue.push(item);
    this.wakeOne(true);
  }

  dequeue(): PromptQueueItem | undefined {
    return this.queue.shift();
  }

  get length(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Resolves when an item is available, or false if the queue is closed.
   */
  waitForItem(): Promise<boolean> {
    if (this.queue.length > 0) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise(resolve => { this.waitResolvers.push(resolve); });
  }

  /**
   * Prevents new items and wakes all pending waiters.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const resolvers = this.waitResolvers.splice(0);
    for (const resolve of resolvers) resolve(false);
  }

  private wakeOne(hasItem: boolean): void {
    const resolve = this.waitResolvers.shift();
    if (resolve) resolve(hasItem);
  }
}
