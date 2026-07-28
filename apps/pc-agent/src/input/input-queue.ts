import {
  type MessageStore,
  type ReceivedMessage,
} from "../messages/message-store.js";

type InputJob = {
  message: ReceivedMessage;
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

/** Serializes all operating-system input side effects across every source. */
export class InputQueue {
  private readonly queue: InputJob[] = [];
  private processing = false;

  constructor(
    private readonly store: MessageStore,
    private readonly processor: InputProcessor,
    private readonly maxWaitingJobs = 100,
  ) {}

  enqueue(message: ReceivedMessage): Promise<void> {
    if (this.queue.length >= this.maxWaitingJobs) {
      const error = new InputQueueFullError();
      this.store.update(message.id, {
        status: "failed",
        error: error.message,
      });
      return Promise.reject(error);
    }

    const completion = new Promise<void>((resolve, reject) => {
      this.queue.push({ message, resolve, reject });
    });
    void this.process();
    return completion;
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) continue;
      this.store.update(job.message.id, { status: "processing" });
      try {
        await this.processor(job.message.text);
        this.store.update(job.message.id, { status: "succeeded" });
        job.resolve();
      } catch (error) {
        this.store.update(job.message.id, {
          status: "failed",
          error: formatError(error),
        });
        job.reject(error);
      }
    }

    this.processing = false;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "输入处理失败。";
}
