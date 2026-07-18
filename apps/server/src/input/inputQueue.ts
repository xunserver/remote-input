import { writeClipboardAndPaste } from "../os/clipboard.js";

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

export class InputQueue {
  private static readonly maxQueueJobs = 100;
  private readonly queue: InputJob[] = [];
  private processing = false;

  constructor(
    private readonly processor: InputProcessor = writeClipboardAndPaste,
  ) {}

  enqueue(text: string): Promise<void> {
    if (this.queue.length >= InputQueue.maxQueueJobs) {
      return Promise.reject(new InputQueueFullError());
    }

    const completion = new Promise<void>((resolve, reject) => {
      this.queue.push({ text, resolve, reject });
    });
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
        job.reject(error);
      }
    }

    this.processing = false;
  }
}
