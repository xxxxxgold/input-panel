export type BoundedExecutor = {
  run<T>(task: () => Promise<T>): Promise<T>;
  map<T, TResult>(
    items: readonly T[],
    mapper: (item: T, index: number) => Promise<TResult>
  ): Promise<TResult[]>;
};

export function createBoundedExecutor(concurrency: number): BoundedExecutor {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }

  let activeCount = 0;
  const queue: Array<() => void> = [];

  const drain = () => {
    while (activeCount < concurrency) {
      const start = queue.shift();
      if (!start) {
        return;
      }
      activeCount += 1;
      start();
    }
  };

  const run = <T>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    queue.push(() => {
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    });
    drain();
  });

  const map = async <T, TResult>(
    items: readonly T[],
    mapper: (item: T, index: number) => Promise<TResult>
  ) => Promise.all(items.map((item, index) => run(() => mapper(item, index))));

  return { run, map };
}

export function boundedMap<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>
) {
  return createBoundedExecutor(concurrency).map(items, mapper);
}
