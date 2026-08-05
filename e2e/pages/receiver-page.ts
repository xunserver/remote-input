import { expect, type Page } from "@playwright/test";

export class ReceiverPage {
  constructor(readonly page: Page) {}

  async open(): Promise<void> {
    await this.page.goto("/receive/");
    await expect(
      this.page.getByRole("heading", { name: "接收看板" }),
    ).toBeVisible();
    await expect(this.page.getByText("实时连接", { exact: true })).toBeVisible();
  }

  message(text: string) {
    return this.page.getByRole("listitem").filter({
      has: this.page.locator("pre", { hasText: text }),
    });
  }

  async expectCompletedMessage(text: string): Promise<void> {
    const message = this.message(text);
    await expect(message.locator("pre")).toHaveText(text);
    await expect(message.getByText("WebSocket", { exact: true })).toBeVisible();
    await expect(message.getByText("已完成", { exact: true })).toBeVisible();
  }

  async clearMessages(): Promise<void> {
    await this.page.getByRole("button", { name: "清空", exact: true }).click();
    await expect(this.page.getByText("尚未收到消息")).toBeVisible();
    await expect(this.page.getByText("0 条 · 0 字符")).toBeVisible();
  }
}
