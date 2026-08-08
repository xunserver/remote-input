<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Activity,
  Check,
  CircleAlert,
  Copy,
  FileText,
  Radio,
  Trash2,
  Unplug,
  Usb,
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
import { Spinner } from "@shadcn/spinner";
import {
  WebHidAgent,
  getWebHidSupport,
  type HidDeviceLike,
  type WebHidAgentState,
} from "@remote-input/web-agent-sdk";
import {
  createWebHidHistoryMessage,
  loadWebHidHistory,
  maxWebHidHistoryItems,
  saveWebHidHistory,
  type WebHidHistoryMessage,
} from "./history";

const state = ref<WebHidAgentState>("idle");
const deviceName = ref("");
const messages = ref<WebHidHistoryMessage[]>(loadWebHidHistory());
const error = ref("");
const copiedId = ref("");
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const support = getWebHidSupport();
const receivedText = computed(() =>
  messages.value.map((message) => message.text).join("\n"),
);
const isConnected = computed(() => state.value === "connected");
const isConnecting = computed(() => state.value === "connecting");
const statusLabel = computed(() => {
  if (state.value === "connected") return "已连接";
  if (state.value === "connecting") return "正在连接";
  if (state.value === "disconnected") return "连接已断开";
  return "等待连接";
});
const textSummary = computed(() =>
  messages.value.length === 0
    ? "0 个字符"
    : `${messages.value.length} 条 · ${receivedText.value.length.toLocaleString()} 个字符`,
);

watch(
  messages,
  (value) => {
    if (!saveWebHidHistory(value)) {
      error.value = "历史记录无法保存到浏览器本地存储。";
    }
  },
  { flush: "sync" },
);

const agent = new WebHidAgent({
  onText(command) {
    error.value = "";
    messages.value = [
      ...messages.value,
      createWebHidHistoryMessage(
        "key" in command ? `[${command.key}]` : command.text,
      ),
    ].slice(-maxWebHidHistoryItems);
  },
  onError(cause) {
    error.value = formatError(cause);
  },
  onStateChange(nextState, device) {
    state.value = nextState;
    deviceName.value = device?.productName ?? "";
  },
});

async function toggleConnection(): Promise<void> {
  error.value = "";
  try {
    if (isConnected.value) {
      await agent.disconnect();
    } else {
      await agent.connect();
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotFoundError") return;
    error.value = formatError(cause);
  }
}

async function copyMessage(message: WebHidHistoryMessage): Promise<void> {
  await copyText(message.text, message.id);
}

async function copyAll(): Promise<void> {
  if (!receivedText.value) return;
  await copyText(receivedText.value, "all");
}

async function copyText(text: string, id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copiedId.value = id;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedId.value = "";
    }, 1600);
  } catch (cause) {
    error.value = formatError(cause);
  }
}

function clearText(): void {
  messages.value = [];
  copiedId.value = "";
}

onMounted(() => {
  if (!support.supported) {
    error.value = support.reason === "insecure_context"
      ? "请通过 HTTPS 或 localhost 打开此页面。"
      : "当前浏览器不支持 WebHID，请使用桌面版 Chrome 或 Edge。";
    return;
  }
  void agent.connectAuthorized().catch((cause: unknown) => {
    error.value = formatError(cause);
  });
});

onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer);
  void agent.close();
});

function formatError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return "设备操作失败，请重新连接。";
}

function connectionTitle(device: HidDeviceLike | null): string {
  return device?.productName || deviceName.value || "Remote Input HID Relay";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
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
              <h1 class="text-xl font-semibold tracking-tight">远程接收</h1>
              <p class="text-sm text-muted-foreground">
                Remote Input WebHID
              </p>
            </div>
          </div>
          <Button
            :variant="isConnected ? 'outline' : 'default'"
            size="sm"
            :disabled="isConnecting || !support.supported"
            @click="toggleConnection"
          >
            <Spinner v-if="isConnecting" data-icon="inline-start" />
            <Unplug
              v-else-if="isConnected"
              data-icon="inline-start"
              aria-hidden="true"
            />
            <Usb v-else data-icon="inline-start" aria-hidden="true" />
            {{
              isConnected
                ? "断开设备"
                : isConnecting
                  ? "连接中"
                  : "连接设备"
            }}
          </Button>
        </div>

        <Card class="gap-0 overflow-hidden py-0 shadow-xs" aria-live="polite">
          <CardHeader
            class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-4"
          >
            <div
              class="flex size-9 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
              :class="{ 'bg-primary/10 text-primary': isConnected }"
            >
              <Activity aria-hidden="true" />
            </div>
            <div class="flex min-w-0 flex-col gap-0.5">
              <CardTitle class="text-sm">{{ statusLabel }}</CardTitle>
              <CardDescription class="truncate text-xs">
                {{ connectionTitle(agent.device) }}
              </CardDescription>
            </div>
            <Badge
              :variant="
                state === 'disconnected'
                  ? 'destructive'
                  : isConnected
                    ? 'secondary'
                    : 'outline'
              "
            >
              <Usb data-icon="inline-start" aria-hidden="true" />
              USB HID
            </Badge>
          </CardHeader>
          <CardContent
            class="grid grid-cols-2 gap-2 border-t bg-muted/30 px-3 py-3 sm:px-4"
          >
            <div
              class="flex min-w-0 flex-col rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
            >
              <span class="text-xs text-muted-foreground">连接状态</span>
              <span class="truncate text-sm font-medium">
                {{ statusLabel }}
              </span>
            </div>
            <div
              class="flex min-w-0 flex-col rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
            >
              <span class="text-xs text-muted-foreground">接收历史</span>
              <span class="truncate text-sm font-medium">
                {{ textSummary }}
              </span>
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

      <Card
        class="gap-0 overflow-hidden py-0 shadow-sm"
        aria-labelledby="receiver-title"
      >
        <CardHeader
          class="flex flex-row items-center justify-between gap-3 border-b px-4 py-4 sm:px-5"
        >
          <div class="flex min-w-0 items-center gap-3">
            <div
              class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
            >
              <FileText aria-hidden="true" />
            </div>
            <div class="flex min-w-0 flex-col gap-1">
              <CardTitle id="receiver-title" class="text-base">
                接收内容
              </CardTitle>
              <CardDescription>{{ textSummary }}</CardDescription>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              title="清空内容"
              aria-label="清空内容"
              :disabled="messages.length === 0"
              @click="clearText"
            >
              <Trash2 aria-hidden="true" />
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
              <Copy v-else data-icon="inline-start" aria-hidden="true" />
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
                <FileText aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>尚未收到文字</EmptyTitle>
              <EmptyDescription>
                连接 HID 设备后，接收到的文字会显示在这里
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
                  class="flex flex-row items-center justify-between gap-3 px-3 sm:px-4"
                >
                  <time
                    class="text-xs text-muted-foreground tabular-nums"
                    :datetime="message.receivedAt"
                    :title="
                      new Date(message.receivedAt).toLocaleString('zh-CN')
                    "
                  >
                    {{ formatTime(message.receivedAt) }}
                  </time>
                  <Button
                    variant="outline"
                    size="sm"
                    :aria-label="`复制 ${formatTime(message.receivedAt)} 的消息`"
                    @click="copyMessage(message)"
                  >
                    <Check
                      v-if="copiedId === message.id"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    <Copy
                      v-else
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {{ copiedId === message.id ? "已复制" : "复制" }}
                  </Button>
                </CardHeader>
                <CardContent class="px-3 sm:px-4">
                  <pre
                    class="m-0 whitespace-pre-wrap break-words font-sans text-[0.9375rem] leading-relaxed text-foreground"
                  >{{ message.text }}</pre>
                </CardContent>
              </Card>
            </li>
          </ol>
        </CardContent>
      </Card>
    </section>
  </main>
</template>
