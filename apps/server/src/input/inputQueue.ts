import { protocolVersion, type OperationState, type OperationStatus, type ProtocolMessage } from "@remote-copy/shared";
import { writeClipboardAndPaste } from "../os/clipboard";

export type InputClient = {
  id: string;
  send: (message: ProtocolMessage) => void;
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
  private readonly queue: InputJob[] = [];
  private readonly operations = new Map<string, StoredOperation>();
  private processing = false;

  enqueue(job: InputJob): void {
    this.queue.push(job);
    this.sendStatus(
      job,
      "accepted",
      "queued",
      15,
      `已进入队列，前面还有 ${Math.max(0, this.queue.length - 1)} 条。`,
    );
    void this.process();
  }

  getStatus(clientId: string, operationId: string): OperationStatus | null {
    const operation = this.operations.get(operationId);
    return operation?.clientId === clientId ? operation.status : null;
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
    const previous = this.operations.get(job.operationId)?.status;
    const status: OperationStatus = {
      operationId: job.operationId,
      revision: (previous?.revision ?? 0) + 1,
      state,
      stage,
      progress,
      message,
    };
    this.operations.set(job.operationId, {
      clientId: job.client.id,
      status,
    });
    job.client.send({
      v: protocolVersion,
      kind: "event",
      name: "operation.status",
      body: status,
    });
  }
}
