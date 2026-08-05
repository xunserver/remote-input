import { expect, type Page } from "@playwright/test";

export class SenderPage {
  constructor(readonly page: Page) {}

  get input() {
    return this.page.getByLabel("发送文字", { exact: true });
  }

  get recentHistory() {
    return this.page.locator("section").filter({
      has: this.page.getByRole("heading", { name: "最近发送" }),
    });
  }

  get sendButton() {
    return this.page.getByTestId("send-button");
  }

  async open(): Promise<void> {
    await this.page.goto("/");
    await expect(
      this.page.getByRole("heading", { name: "选择连接方式" }),
    ).toBeVisible();
  }

  async openConnected(): Promise<void> {
    await this.page.goto("/");
    await this.expectReady();
  }

  async selectWebSocket(
    host = "127.0.0.1",
    port = "17889",
  ): Promise<void> {
    await this.page.getByRole("radio", { name: /WebSocket/ }).click();
    await this.page.getByLabel("IP 或主机名").fill(host);
    await this.page.getByLabel("端口").fill(port);
  }

  async submitConnection(): Promise<void> {
    await this.page
      .getByRole("button", { name: "连接服务器", exact: true })
      .click();
  }

  async connectWebSocket(): Promise<void> {
    await this.selectWebSocket();
    await this.submitConnection();
    await this.expectReady();
  }

  async expectReady(): Promise<void> {
    await expect(this.page.getByText("已就绪", { exact: true })).toBeVisible();
    await expect(this.page.getByText("Remote Input Server")).toBeVisible();
  }

  async expectSent(
    text: string,
    status: "pasted" | "copied" = "pasted",
  ): Promise<void> {
    await expect(this.input).toHaveValue("");
    await expect(
      this.page.getByText(
        status === "pasted"
          ? "接收端已完成输入。"
          : "接收端已复制到剪贴板。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(this.recentHistory.getByText(text, { exact: true }))
      .toBeVisible();
  }

  async send(
    text: string,
    status: "pasted" | "copied" = "pasted",
  ): Promise<void> {
    await this.input.fill(text);
    await this.sendButton.click();
    await this.expectSent(text, status);
  }
}
