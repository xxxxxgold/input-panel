import type {
  PagePreloadPriority,
  PagePreloadResult,
  PagePreloadTarget,
  PagePreloadTask
} from "./page-preload";

const PAGE_PRELOAD_PRIORITY: Record<PagePreloadPriority, number> = {
  idle: 0,
  intent: 1,
  navigate: 2
};

export class PagePreloadCoordinator {
  private readonly maxCompletedPages: number;
  private readonly completed = new Set<PagePreloadTarget>();
  private readonly queued: Array<{
    target: PagePreloadTarget;
    task: PagePreloadTask;
    priority: PagePreloadPriority;
    resolve: (result: PagePreloadResult) => void;
  }> = [];
  private readonly inFlight = new Map<PagePreloadTarget, Promise<PagePreloadResult>>();
  private draining = false;

  constructor(options: { maxCompletedPages: number }) {
    this.maxCompletedPages = options.maxCompletedPages;
  }

  enqueue(
    target: PagePreloadTarget,
    task: PagePreloadTask,
    priority: PagePreloadPriority = "intent"
  ): Promise<PagePreloadResult> {
    const existing = this.inFlight.get(target);
    if (existing) {
      this.promoteQueuedTarget(target, task, priority);
      return existing;
    }
    if (this.completed.has(target)) {
      return Promise.resolve("completed");
    }
    if (this.completed.size >= this.maxCompletedPages) {
      return Promise.resolve("skipped-budget");
    }

    let resolveTask!: (result: PagePreloadResult) => void;
    const pending = new Promise<PagePreloadResult>((resolve) => {
      resolveTask = resolve;
    });
    this.inFlight.set(target, pending);
    this.queued.push({ target, task, priority, resolve: resolveTask });
    void this.drain();
    return pending;
  }

  private async drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queued.length > 0) {
        const next = this.queued.shift();
        if (!next) {
          continue;
        }
        if (this.completed.size >= this.maxCompletedPages) {
          next.resolve("skipped-budget");
          this.inFlight.delete(next.target);
          continue;
        }
        try {
          const result = await next.task();
          if (result === "skipped") {
            next.resolve("skipped");
          } else {
            this.completed.add(next.target);
            next.resolve("completed");
          }
        } catch {
          next.resolve("failed");
        } finally {
          this.inFlight.delete(next.target);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private promoteQueuedTarget(
    target: PagePreloadTarget,
    task: PagePreloadTask,
    priority: PagePreloadPriority
  ) {
    const index = this.queued.findIndex((entry) => entry.target === target);
    if (index < 0) {
      return;
    }
    const [queued] = this.queued.splice(index, 1);
    if (!queued) {
      return;
    }
    if (PAGE_PRELOAD_PRIORITY[priority] > PAGE_PRELOAD_PRIORITY[queued.priority]) {
      queued.task = task;
      queued.priority = priority;
    }
    this.queued.unshift(queued);
  }
}
