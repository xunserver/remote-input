import type { ServerMessage } from "@remote-copy/shared";
import { writeClipboardAndPaste } from "../os/clipboard";

export type InputClient = {
  send: (message: ServerMessage) => void;
};

type InputJob = {
  client: InputClient;
  requestId: string;
  text: string;
};

type InputStatus = Extract<ServerMessage, { type: "input-status" }>["status"];

export class InputQueue {
  private readonly queue: InputJob[] = [];
  private processing = false;

  enqueue(job: InputJob): void {
    this.queue.push(job);
    this.sendStatus(job, "queued", 15, `已进入队列，前面还有 ${Math.max(0, this.queue.length - 1)} 条。`);
    void this.process();
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
        this.sendStatus(job, "copying", 35, "正在写入当前机器剪贴板。");
        await writeClipboardAndPaste(job.text, () => {
          this.sendStatus(job, "pasting", 70, "剪贴板已写入，正在触发粘贴。");
        });
        this.sendStatus(job, "done", 100, "远端输入完成。");
      } catch (error) {
        const message = error instanceof Error ? error.message : "远端输入失败。";
        this.sendStatus(job, "failed", 100, message);
        console.error("Input failed:", error);
      }
    }

    this.processing = false;
  }

  private sendStatus(job: InputJob, status: InputStatus, progress: number, message: string): void {
    job.client.send({
      type: "input-status",
      requestId: job.requestId,
      status,
      progress,
      message,
    });
  }
}
