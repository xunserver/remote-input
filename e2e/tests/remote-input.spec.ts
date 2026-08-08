import {
  expect,
  test,
  type APIRequestContext,
  type ConsoleMessage,
  type Page,
} from "@playwright/test";
import { ReceiverPage } from "../pages/receiver-page";
import { SenderPage } from "../pages/sender-page";

type ReceivedMessage = {
  source: "websocket" | "hid";
  status: "queued" | "processing" | "succeeded" | "failed";
  text: string;
};

test.beforeEach(async ({ request }) => {
  await controlAgent(request, "start");
  const response = await request.delete("/api/messages");
  expect(response.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await controlAgent(request, "resume");
  await controlAgent(request, "start");
});

test("loads both apps, connects WebSocket, and reports no browser errors", async ({
  context,
  page,
}) => {
  const errors: string[] = [];
  collectBrowserErrors(page, errors);

  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  const receiverPage = await context.newPage();
  collectBrowserErrors(receiverPage, errors);
  const receiver = new ReceiverPage(receiverPage);
  await receiver.open();
  await expect(receiverPage.getByText("1 个发送端")).toBeVisible();
  expect(errors).toEqual([]);
});

test("recovers after connecting to an unavailable WebSocket endpoint", async ({
  page,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.selectWebSocket("127.0.0.1", "1");
  await sender.submitConnection();
  await expect(
    page.getByRole("alert").filter({
      hasText: /无法连接到服务器|连接尚未建立|无法确认是否交付/,
    }),
  ).toBeVisible();

  await sender.selectWebSocket();
  await sender.submitConnection();
  await sender.expectReady();
});

test("does not send empty or whitespace-only input", async ({
  page,
  request,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  await expect(sender.sendButton).toBeDisabled();
  await sender.input.fill("  \n\t");
  await expect(sender.sendButton).toBeDisabled();
  await sender.input.press("Enter");
  await expectMessageCount(request, 0);
  await expect(page.getByText("还没有发送记录")).toBeVisible();
});

test("sends single-line input with Enter", async ({ page, request }) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  const text = "按 Enter 发送";
  await sender.input.fill(text);
  await sender.input.press("Enter");
  await sender.expectSent(text);
  await expectMessages(request, [text]);
});

test("optionally presses Enter after sending text", async ({ page, request }) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  const text = "发送后确认";
  await page.getByLabel("Enter", { exact: true }).check();
  await sender.input.fill(text);
  await sender.sendButton.click();

  await expect(sender.input).toHaveValue("");
  await expectMessages(request, [text]);
  await expect(
    sender.recentHistory.getByText("[Enter]", { exact: true }),
  ).toHaveCount(0);
});

test("keeps Enter as a newline in multiline mode and honors copy-only control", async ({
  context,
  page,
  request,
}) => {
  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  await page.locator("#multi-line-mode").check();
  await page.locator("#paste-after-copy").uncheck();
  await page.locator("#restore-clipboard").uncheck();
  await sender.input.fill("第一行");
  await sender.input.press("Enter");
  await sender.input.pressSequentially("second line");
  const text = "第一行\nsecond line";
  await expect(sender.input).toHaveValue(text);
  await expectMessageCount(request, 0);

  await sender.sendButton.click();
  await sender.expectSent(text, "copied");
  await receiver.expectCompletedMessage(text);
  await expectMessages(request, [text]);
});

test("preserves Unicode and renders HTML-like input as inert text", async ({
  context,
  page,
  request,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  const text = `<script>alert("xss")</script> 你好 & "Remote" 👋`;
  await sender.send(text);
  await receiver.expectCompletedMessage(text);
  await expectMessages(request, [text]);
  expect(dialogs).toEqual([]);
});

test("sends a long mixed-Unicode message without truncation", async ({
  context,
  page,
  request,
}) => {
  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  const text = "远程Input🙂<>&".repeat(1_000);
  await sender.send(text);
  await receiver.expectCompletedMessage(text);
  await expectMessages(request, [text]);
});

test("restores existing messages from the receiver SSE snapshot", async ({
  context,
  page,
  request,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();
  const text = "先发送，后打开接收看板";
  await sender.send(text);
  await expectMessages(request, [text]);

  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  await receiver.expectCompletedMessage(text);
  await expect(receiver.page.getByText("1 条 · 11 字符")).toBeVisible();
});

test("persists connection and send history across a page reload", async ({
  page,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();
  const text = "刷新后仍保留";
  await sender.send(text);

  await page.reload();
  await sender.expectReady();
  await expect(sender.recentHistory.getByText(text, { exact: true }))
    .toBeVisible();
});

test("resends an item from local history", async ({ page, request }) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();
  const text = "历史重发";
  await sender.send(text);

  await sender.recentHistory.getByRole("button", { name: "重发" }).click();
  await expectMessages(request, [text, text]);
});

test("clears local send history without deleting receiver history", async ({
  context,
  page,
  request,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();
  const text = "仅清空发送历史";
  await sender.send(text);

  await page.getByRole("button", { name: "清空", exact: true }).click();
  await expect(page.getByText("还没有发送记录")).toBeVisible();
  await expectMessages(request, [text]);

  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  await receiver.expectCompletedMessage(text);
});

test("clears receiver history through SSE and the HTTP API", async ({
  context,
  page,
  request,
}) => {
  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();
  await sender.send("清空接收历史");

  await receiver.clearMessages();
  await expectMessages(request, []);
});

test("disables input after disconnect and enables it after reconnect", async ({
  page,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  await page.getByRole("button", { name: "断开连接" }).click();
  await expect(page.getByText("已断开", { exact: true })).toBeVisible();
  await expect(sender.input).toBeDisabled();
  await expect(sender.sendButton).toBeDisabled();

  await page.getByRole("button", { name: "重新连接" }).click();
  await sender.expectReady();
  await expect(sender.input).toBeEnabled();
});

test("prevents duplicate submission while a send is in progress", async ({
  page,
  request,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();
  const text = "发送中只提交一次";
  await sender.input.fill(text);

  await controlAgent(request, "pause");
  await sender.sendButton.click();
  await expect(sender.sendButton).toBeDisabled();
  await sender.sendButton.click({ force: true });
  await controlAgent(request, "resume");

  await sender.expectSent(text);
  await expectMessages(request, [text]);
});

test("shows an unexpected server disconnect and reconnects after restart", async ({
  page,
  request,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  await controlAgent(request, "stop");
  await expect(page.getByText("已断开", { exact: true })).toBeVisible();
  await expect(sender.input).toBeDisabled();

  await controlAgent(request, "start");
  await page.getByRole("button", { name: "重新连接" }).click();
  await sender.expectReady();
  await expect(sender.input).toBeEnabled();
});

test("updates the receiver when two senders connect and one closes", async ({
  context,
  page,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  const secondPage = await context.newPage();
  const secondSender = new SenderPage(secondPage);
  await secondSender.openConnected();

  const receiver = new ReceiverPage(await context.newPage());
  await receiver.open();
  await expect(receiver.page.getByText("2 个发送端")).toBeVisible();

  await secondPage.close();
  await expect(receiver.page.getByText("1 个发送端")).toBeVisible();
});

test("reset clears the saved connection and returns to initial setup", async ({
  page,
}) => {
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  await page.getByRole("button", { name: "重置连接" }).click();
  await expect(
    page.getByRole("heading", { name: "选择连接方式" }),
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /蓝牙连接/ })).toBeChecked();
  await expect(sender.input).toBeDisabled();
  expect(
    await page.evaluate(() => ({
      autoConnect: localStorage.getItem("remote-input.connection-auto-connect"),
      method: localStorage.getItem("remote-input.connection-method"),
      url: localStorage.getItem("remote-input.connection-url"),
    })),
  ).toEqual({ autoConnect: null, method: null, url: null });
});

test("exposes working send controls in the mobile settings sheet", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sender = new SenderPage(page);
  await sender.open();
  await sender.connectWebSocket();

  await page.getByRole("button", { name: "打开发送设置" }).click();
  await expect(page.getByRole("heading", { name: "发送设置" })).toBeVisible();
  await page.locator("#multi-line-mode-mobile").check();
  await page.locator("#paste-after-copy-mobile").uncheck();
  await page.locator("#restore-clipboard-mobile").uncheck();
  await page.getByRole("button", { name: "完成", exact: true }).click();

  await sender.input.fill("移动端第一行");
  await sender.input.press("Enter");
  await sender.input.pressSequentially("第二行");
  const text = "移动端第一行\n第二行";
  await expect(sender.input).toHaveValue(text);
  await expectMessageCount(request, 0);
  await sender.sendButton.click();
  await sender.expectSent(text, "copied");
  await expectMessages(request, [text]);
});

function collectBrowserErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    const isMissingFavicon =
      message.location().url === "http://127.0.0.1:17889/favicon.ico";
    if (message.type() === "error" && !isMissingFavicon) {
      errors.push(message.text());
    }
  });
}

async function getMessages(
  request: APIRequestContext,
): Promise<ReceivedMessage[]> {
  const response = await request.get("/api/messages");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { messages: ReceivedMessage[] }).messages;
}

async function expectMessageCount(
  request: APIRequestContext,
  expected: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const messages = await getMessages(request);
      return messages.filter((message) => message.status === "succeeded").length;
    })
    .toBe(expected);
}

async function expectMessages(
  request: APIRequestContext,
  expectedTexts: string[],
): Promise<void> {
  await expect
    .poll(async () => {
      const messages = await getMessages(request);
      if (messages.some((message) => message.status !== "succeeded")) {
        return null;
      }
      return messages.map((message) => message.text);
    })
    .toEqual(expectedTexts);
}

async function controlAgent(
  request: APIRequestContext,
  action: "pause" | "resume" | "start" | "stop",
): Promise<void> {
  const response = await request.post(
    `http://127.0.0.1:17890/${action}`,
    { timeout: 15_000 },
  );
  expect(response.ok()).toBe(true);
}
