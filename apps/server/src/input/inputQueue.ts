import type { OperationState, OperationStatus } from "@remote-copy/protocol";
import { writeClipboardAndPaste } from "../os/clipboard.js";

export type InputClient = {
  id: string;
  notifyStatus: (status: OperationStatus) => Promise<void>;
};

type InputJob = {
  client: InputClient;
  operationId: string;
  text: string;
};

type StoredOperation = {
  clientId: string;
  status: OperationStatus;
};

export class InputQueue {
  private static readonly maxQueueJobs = 100;
  private static readonly maxStoredOperations = 1_000;
  private readonly queue: InputJob[] = [];
  private readonly operations = new Map<string, StoredOperation>();
  private processing = false;

  enqueue(job: InputJob): boolean {
    if (this.queue.length >= InputQueue.maxQueueJobs) {
      return false;
    }
    this.queue.push(job);
    this.sendStatus(
      job,
      "accepted",
      "queued",
      15,
      `已进入队列，前面还有 ${Math.max(0, this.queue.length - 1)} 条。`,
    );
    void this.process();
    return true;
  }

  getStatus(clientId: string, operationId: string): OperationStatus | null {
    return this.operations.get(operationKey(clientId, operationId))?.status ?? null;
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
        this.sendStatus(job, "processing", "copying", 35, "正在写入当前机器剪贴板。");
        await writeClipboardAndPaste(job.text, () => {
          this.sendStatus(job, "processing", "pasting", 70, "剪贴板已写入，正在触发粘贴。");
        });
        this.sendStatus(job, "succeeded", "done", 100, "当前下游已完成输入请求。");
      } catch (error) {
        const message = error instanceof Error ? error.message : "当前下游处理输入失败。";
        this.sendStatus(job, "failed", "failed", 100, message);
        console.error("Input failed:", error);
      }
    }

    this.processing = false;
  }

  private sendStatus(
    job: InputJob,
    state: OperationState,
    stage: string,
    progress: number,
    message: string,
  ): void {
    const key = operationKey(job.client.id, job.operationId);
    const previous = this.operations.get(key)?.status;
    const status: OperationStatus = {
      operationId: job.operationId,
      revision: (previous?.revision ?? 0) + 1,
      state,
      stage,
      progress,
      message,
    };
    this.operations.set(key, {
      clientId: job.client.id,
      status,
    });
    while (this.operations.size > InputQueue.maxStoredOperations) {
      const oldest = this.operations.keys().next().value;
      if (oldest === undefined) break;
      this.operations.delete(oldest);
    }
    void job.client.notifyStatus(status).catch((error) => {
      console.error("Failed to notify operation status:", error);
    });
  }
}

function operationKey(clientId: string, operationId: string): string {
  return `${clientId}\u0000${operationId}`;
}
