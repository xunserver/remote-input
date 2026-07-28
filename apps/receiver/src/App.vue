<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
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
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"><Radio :size="22" aria-hidden="true" /></span>
        <div>
          <h1>接收看板</h1>
          <p>Remote Input PC Agent</p>
        </div>
      </div>
      <span class="stream-state" :class="{ connected: streamConnected }">
        <span class="status-dot" />
        {{ streamConnected ? "实时连接" : "正在重连" }}
      </span>
    </header>

    <section class="status-grid" aria-label="连接状态">
      <div class="status-card">
        <Usb :size="20" aria-hidden="true" />
        <div>
          <span>USB HID</span>
          <strong>{{ hidLabel }}</strong>
        </div>
      </div>
      <div class="status-card">
        <Wifi :size="20" aria-hidden="true" />
        <div>
          <span>WebSocket</span>
          <strong>{{ runtimeStatus.websocketClients }} 个发送端</strong>
        </div>
      </div>
      <div class="status-card">
        <Laptop :size="20" aria-hidden="true" />
        <div>
          <span>接收历史</span>
          <strong>{{ messages.length }} 条 · {{ totalCharacters }} 字符</strong>
        </div>
      </div>
    </section>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="18" aria-hidden="true" />
      <span>{{ error }}</span>
    </div>

    <section class="receiver">
      <div class="receiver-toolbar">
        <div>
          <h2>接收内容</h2>
          <p>最近 100 条，仅保存在本机内存中</p>
        </div>
        <div class="toolbar-actions">
          <button
            class="secondary-button"
            type="button"
            :disabled="messages.length === 0"
            @click="clearMessages"
          >
            <Trash2 :size="17" aria-hidden="true" />
            清空
          </button>
          <button
            class="primary-button"
            type="button"
            :disabled="messages.length === 0"
            @click="copyAll"
          >
            <Check v-if="copiedId === 'all'" :size="17" aria-hidden="true" />
            <ClipboardCopy v-else :size="17" aria-hidden="true" />
            {{ copiedId === "all" ? "已复制" : "复制全部" }}
          </button>
        </div>
      </div>

      <div v-if="messages.length === 0" class="empty-state">
        <Radio :size="34" stroke-width="1.5" aria-hidden="true" />
        <strong>尚未收到消息</strong>
        <span>WebSocket 或 ESP32 HID 发来的文字会显示在这里</span>
      </div>

      <ol v-else class="message-list">
        <li v-for="message in messages" :key="message.id" class="message-card">
          <div class="message-meta">
            <span class="source">
              <Usb v-if="message.source === 'hid'" :size="15" aria-hidden="true" />
              <Wifi v-else :size="15" aria-hidden="true" />
              {{ sourceLabel(message.source) }}
            </span>
            <time :datetime="message.receivedAt">
              {{ formatTime(message.receivedAt) }}
            </time>
            <span class="message-status" :class="message.status">
              {{ statusLabel(message.status) }}
            </span>
            <button
              class="icon-button"
              type="button"
              title="复制这条消息"
              @click="copyMessage(message)"
            >
              <Check v-if="copiedId === message.id" :size="16" aria-hidden="true" />
              <Copy v-else :size="16" aria-hidden="true" />
            </button>
          </div>
          <pre>{{ message.text }}</pre>
          <p v-if="message.error" class="message-error">{{ message.error }}</p>
        </li>
      </ol>
    </section>
  </main>
</template>
