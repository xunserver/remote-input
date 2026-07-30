<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Activity,
  Check,
  CircleAlert,
  ClipboardCopy,
  Copy,
  Laptop,
  Radio,
  Trash2,
  Usb,
  Wifi,
} from "@lucide/vue";
import { Badge } from "@shadcn/badge";
import { Button } from "@shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@shadcn/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@shadcn/empty";

type MessageSource = "websocket" | "hid";
type MessageStatus = "queued" | "processing" | "succeeded" | "failed";

type ReceivedMessage = {
  id: string;
  source: MessageSource;
  text: string;
  receivedAt: string;
  status: MessageStatus;
  error?: string;
};

type RuntimeStatus = {
  hid: {
    state: "waiting" | "connected" | "disconnected";
    deviceName: string;
  };
  websocketClients: number;
};

type SnapshotEvent = {
  messages: ReceivedMessage[];
  status: RuntimeStatus;
};

const messages = ref<ReceivedMessage[]>([]);
const runtimeStatus = ref<RuntimeStatus>({
  hid: { state: "waiting", deviceName: "" },
  websocketClients: 0,
});
const streamConnected = ref(false);
const error = ref("");
const copiedId = ref("");
let stream: EventSource | undefined;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const totalCharacters = computed(() =>
  messages.value.reduce((total, message) => total + message.text.length, 0),
);
const allText = computed(() =>
  messages.value.map((message) => message.text).join("\n"),
);
const hidLabel = computed(() => {
  if (runtimeStatus.value.hid.state === "connected") {
    return runtimeStatus.value.hid.deviceName || "ESP32-S3 已连接";
  }
  if (runtimeStatus.value.hid.state === "disconnected") return "HID 已断开";
  return "等待 HID";
});

onMounted(() => {
  stream = new EventSource(eventUrl());
  stream.onopen = () => {
    streamConnected.value = true;
    error.value = "";
  };
  stream.onerror = () => {
    streamConnected.value = false;
    error.value = "实时连接已断开，正在自动重连。";
  };
  stream.addEventListener("snapshot", (event) => {
    const snapshot = parseJson<SnapshotEvent>(event);
    if (!snapshot) return;
    messages.value = snapshot.messages;
    runtimeStatus.value = snapshot.status;
  });
  stream.addEventListener("message", (event) => {
    const message = parseJson<ReceivedMessage>(event);
    if (!message) return;
    const index = messages.value.findIndex((item) => item.id === message.id);
    if (index < 0) {
      messages.value = [...messages.value, message].slice(-100);
    } else {
      const next = [...messages.value];
      next[index] = message;
      messages.value = next;
    }
  });
  stream.addEventListener("cleared", () => {
    messages.value = [];
  });
  stream.addEventListener("status", (event) => {
    const status = parseJson<RuntimeStatus>(event);
    if (status) runtimeStatus.value = status;
  });
});

onUnmounted(() => {
  stream?.close();
  if (copyTimer) clearTimeout(copyTimer);
});

async function copyMessage(message: ReceivedMessage): Promise<void> {
  await copyText(message.text, message.id);
}

async function copyAll(): Promise<void> {
  if (!allText.value) return;
  await copyText(allText.value, "all");
}

async function copyText(text: string, id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = id;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedId.value = "";
    }, 1_600);
  } catch (cause) {
    error.value = formatError(cause);
  }
}

async function clearMessages(): Promise<void> {
  try {
    const response = await fetch(apiUrl("/api/messages"), {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("清空消息失败。");
  } catch (cause) {
    error.value = formatError(cause);
  }
}

function parseJson<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    error.value = "收到无法解析的服务端事件。";
    return null;
  }
}

function sourceLabel(source: MessageSource): string {
  return source === "hid" ? "ESP32 HID" : "WebSocket";
}

function statusLabel(status: MessageStatus): string {
  if (status === "queued") return "排队中";
  if (status === "processing") return "处理中";
  if (status === "succeeded") return "已完成";
  return "失败";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "操作失败。";
}

function eventUrl(): string {
  return apiUrl("/events");
}

function apiUrl(path: string): string {
  return import.meta.env.DEV ? path : new URL(path, window.location.origin).href;
}
</script>

<template>
  <main class="min-h-svh text-foreground">
    <section
      class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:gap-5 sm:px-6 sm:pt-6"
    >
      <header class="flex flex-col gap-4">
        <div class="flex items-center justify-between gap-3 px-1">
          <div class="flex min-w-0 items-center gap-3">
            <div
              class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
            >
              <Radio aria-hidden="true" />
            </div>
            <div class="flex min-w-0 flex-col gap-0.5">
              <h1 class="text-xl font-semibold tracking-tight">接收看板</h1>
              <p class="text-sm text-muted-foreground">
                Remote Input PC Agent
              </p>
            </div>
          </div>
          <Badge
            :variant="streamConnected ? 'secondary' : 'destructive'"
            class="gap-1.5"
          >
            <span
              class="size-1.5 rounded-full bg-current"
              :class="{ 'animate-pulse': !streamConnected }"
            />
            {{ streamConnected ? "实时连接" : "正在重连" }}
          </Badge>
        </div>

        <Card class="gap-0 overflow-hidden py-0 shadow-xs">
          <CardHeader
            class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-3 py-3 sm:px-4"
          >
            <div
              class="flex size-9 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
            >
              <Activity aria-hidden="true" />
            </div>
            <div class="flex min-w-0 flex-col gap-0.5">
              <CardTitle class="text-sm">接收服务状态</CardTitle>
              <CardDescription class="text-xs">
                同时监听 USB HID 与 WebSocket 输入
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent
            class="grid gap-2 border-t bg-muted/30 px-3 py-3 sm:grid-cols-3 sm:px-4"
            aria-label="连接状态"
          >
            <div
              class="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
            >
              <Usb class="shrink-0" aria-hidden="true" />
              <div class="flex min-w-0 flex-col">
                <span class="text-xs text-muted-foreground">USB HID</span>
                <span class="truncate text-sm font-medium">{{ hidLabel }}</span>
              </div>
            </div>
            <div
              class="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
            >
              <Wifi class="shrink-0" aria-hidden="true" />
              <div class="flex min-w-0 flex-col">
                <span class="text-xs text-muted-foreground">WebSocket</span>
                <span class="truncate text-sm font-medium">
                  {{ runtimeStatus.websocketClients }} 个发送端
                </span>
              </div>
            </div>
            <div
              class="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
            >
              <Laptop class="shrink-0" aria-hidden="true" />
              <div class="flex min-w-0 flex-col">
                <span class="text-xs text-muted-foreground">接收历史</span>
                <span class="truncate text-sm font-medium">
                  {{ messages.length }} 条 · {{ totalCharacters }} 字符
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </header>

      <div
        v-if="error"
        class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        role="alert"
      >
        <CircleAlert class="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{{ error }}</span>
      </div>

      <Card class="gap-0 overflow-hidden py-0 shadow-sm">
        <CardHeader
          class="flex flex-row items-center justify-between gap-3 border-b px-4 py-4 sm:px-5"
        >
          <div class="flex min-w-0 flex-col gap-1">
            <div class="flex items-center gap-2">
              <CardTitle class="text-base">接收内容</CardTitle>
              <Badge v-if="messages.length > 0" variant="secondary">
                {{ messages.length }}
              </Badge>
            </div>
            <CardDescription>
              最近 100 条，仅保存在本机内存中
            </CardDescription>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              :disabled="messages.length === 0"
              @click="clearMessages"
            >
              <Trash2 data-icon="inline-start" aria-hidden="true" />
              清空
            </Button>
            <Button
              size="sm"
              :disabled="messages.length === 0"
              @click="copyAll"
            >
              <Check
                v-if="copiedId === 'all'"
                data-icon="inline-start"
                aria-hidden="true"
              />
              <ClipboardCopy
                v-else
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ copiedId === "all" ? "已复制" : "复制全部" }}
            </Button>
          </div>
        </CardHeader>

        <CardContent class="p-0">
          <Empty
            v-if="messages.length === 0"
            class="min-h-80 rounded-none border-0"
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Radio aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>尚未收到消息</EmptyTitle>
              <EmptyDescription>
                WebSocket 或 ESP32 HID 发来的文字会显示在这里
              </EmptyDescription>
            </EmptyHeader>
          </Empty>

          <ol
            v-else
            class="grid max-h-[calc(100svh-19rem)] min-h-60 gap-3 overflow-auto bg-muted/30 p-3 sm:p-4"
          >
            <li v-for="message in messages" :key="message.id">
              <Card size="sm" class="gap-2 shadow-xs">
                <CardHeader
                  class="flex flex-row items-center gap-2 px-3 sm:px-4"
                >
                  <Badge variant="outline">
                    <Usb
                      v-if="message.source === 'hid'"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    <Wifi
                      v-else
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {{ sourceLabel(message.source) }}
                  </Badge>
                  <time
                    class="text-xs text-muted-foreground tabular-nums"
                    :datetime="message.receivedAt"
                  >
                    {{ formatTime(message.receivedAt) }}
                  </time>
                  <Badge
                    :variant="
                      message.status === 'failed'
                        ? 'destructive'
                        : message.status === 'succeeded'
                          ? 'secondary'
                          : 'outline'
                    "
                  >
                    {{ statusLabel(message.status) }}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="ml-auto"
                    title="复制这条消息"
                    aria-label="复制这条消息"
                    @click="copyMessage(message)"
                  >
                    <Check
                      v-if="copiedId === message.id"
                      aria-hidden="true"
                    />
                    <Copy v-else aria-hidden="true" />
                  </Button>
                </CardHeader>
                <CardContent class="px-3 sm:px-4">
                  <pre
                    class="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground"
                  >{{ message.text }}</pre>
                  <p
                    v-if="message.error"
                    class="mt-2 text-xs text-destructive"
                  >
                    {{ message.error }}
                  </p>
                </CardContent>
              </Card>
            </li>
          </ol>
        </CardContent>
      </Card>
    </section>
  </main>
</template>
