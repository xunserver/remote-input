import {
  type MessageStore,
  type ReceivedMessage,
} from "../messages/message-store.js";
import type {
  InputStatus,
  InputStatusStage,
  RemoteInputCommand,
} from "@remote-input/sdk";

type InputJob = {
  command: RemoteInputCommand;
  message: ReceivedMessage;
  onStatus?: (status: InputStatus) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type InputProcessor = (
  command: RemoteInputCommand,
  onStage: (stage: InputStatusStage, message: string) => void,
) => Promise<void>;

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

  enqueue(
    message: ReceivedMessage,
    command: RemoteInputCommand,
    onStatus?: (status: InputStatus) => void,
  ): Promise<void> {
    emitStatus(command, onStatus, "queued", 10, "输入已进入接收队列。");
    if (this.queue.length >= this.maxWaitingJobs) {
      const error = new InputQueueFullError();
      this.store.update(message.id, {
        status: "failed",
        error: error.message,
      });
      emitStatus(command, onStatus, "failed", 100, error.message);
      return Promise.reject(error);
    }

    const completion = new Promise<void>((resolve, reject) => {
      this.queue.push({
        command,
        message,
        ...(onStatus === undefined ? {} : { onStatus }),
        resolve,
        reject,
      });
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
      emitStatus(
        job.command,
        job.onStatus,
        "processing",
        25,
        "接收端正在处理输入。",
      );
      try {
        await this.processor(job.command, (stage, message) => {
          emitStatus(
            job.command,
            job.onStatus,
            stage,
            stageProgress(stage),
            message,
          );
        });
        this.store.update(job.message.id, { status: "succeeded" });
        emitStatus(
          job.command,
          job.onStatus,
          "succeeded",
          100,
          "key" in job.command
            ? `接收端已按下 ${job.command.key}。`
            : job.command.control.paste
              ? "接收端已完成输入。"
              : "接收端已复制到剪贴板。",
        );
        job.resolve();
      } catch (error) {
        this.store.update(job.message.id, {
          status: "failed",
          error: formatError(error),
        });
        emitStatus(
          job.command,
          job.onStatus,
          "failed",
          100,
          formatError(error),
        );
        job.reject(error);
      }
    }

    this.processing = false;
  }
}

function emitStatus(
  command: RemoteInputCommand,
  listener: ((status: InputStatus) => void) | undefined,
  stage: InputStatusStage,
  progress: number,
  message: string,
): void {
  if (!command.operationId || !listener) return;
  listener({
    operationId: command.operationId,
    stage,
    progress,
    message,
  });
}

function stageProgress(stage: InputStatusStage): number {
  if (stage === "copied") return 50;
  if (stage === "pasted") return 75;
  if (stage === "key_pressed") return 75;
  if (stage === "clipboard_restored") return 90;
  return 25;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "输入处理失败。";
}
