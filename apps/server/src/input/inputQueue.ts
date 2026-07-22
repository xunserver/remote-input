type InputJob = {
  text: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type InputProcessor = (text: string) => Promise<void>;

export class InputQueueFullError extends Error {
  constructor() {
    super("输入队列已满。");
    this.name = "InputQueueFullError";
  }
}

/** 以单消费者串行执行输入任务，enqueue 的 Promise 跟随对应任务完成或失败。 */
export class InputQueue {
  private static readonly maxQueueJobs = 100;
  private readonly queue: InputJob[] = [];
  private processing = false;

  constructor(private readonly processor: InputProcessor) {}

  enqueue(text: string): Promise<void> {
    // 执行中的任务已移出数组；这里限制的是等待任务数，不包含当前任务。
    if (this.queue.length >= InputQueue.maxQueueJobs) {
      return Promise.reject(new InputQueueFullError());
    }

    const completion = new Promise<void>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
    });
    // process() 会在首次让出事件循环前设置锁，并发入队不会启动第二个消费者。
    void this.process();
    return completion;
  }

  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        continue;
      }

      try {
        await this.processor(job.text);
        job.resolve();
      } catch (error) {
        // 单项失败只结算对应任务，不能中断后续输入的处理。
        job.reject(error);
      }
    }

    this.processing = false;
  }
}
