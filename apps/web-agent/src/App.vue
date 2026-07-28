<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  Check,
  CircleAlert,
  Copy,
  FileText,
  Radio,
  Trash2,
  Unplug,
  Usb,
} from "@lucide/vue";
import {
  WebHidAgent,
  getWebHidSupport,
  type HidDeviceLike,
  type WebHidAgentState,
} from "@remote-input/web-agent-sdk";

const state = ref<WebHidAgentState>("idle");
const deviceName = ref("");
const messages = ref<string[]>([]);
const error = ref("");
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const support = getWebHidSupport();
const receivedText = computed(() => messages.value.join("\n"));
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

const agent = new WebHidAgent({
  onText(command) {
    messages.value = [...messages.value, command.text];
    error.value = "";
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

async function copyText(): Promise<void> {
  if (!receivedText.value) return;
  try {
    await navigator.clipboard.writeText(receivedText.value);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch (cause) {
    error.value = formatError(cause);
  }
}

function clearText(): void {
  messages.value = [];
  copied.value = false;
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
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"><Radio :size="22" aria-hidden="true" /></span>
        <div>
          <h1>远程接收</h1>
          <p>Remote Input WebHID</p>
        </div>
      </div>
      <button
        class="connection-button"
        :class="{ connected: isConnected }"
        type="button"
        :disabled="isConnecting || !support.supported"
        @click="toggleConnection"
      >
        <Unplug v-if="isConnected" :size="17" aria-hidden="true" />
        <Usb v-else :size="17" aria-hidden="true" />
        {{ isConnected ? "断开设备" : isConnecting ? "连接中" : "连接设备" }}
      </button>
    </header>

    <section class="status-band" aria-live="polite">
      <div class="status-main">
        <span class="status-dot" :class="state" />
        <div>
          <strong>{{ statusLabel }}</strong>
          <span>{{ connectionTitle(agent.device) }}</span>
        </div>
      </div>
      <div class="transport-label">
        <Usb :size="16" aria-hidden="true" />
        USB HID
      </div>
    </section>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="18" aria-hidden="true" />
      <span>{{ error }}</span>
    </div>

    <section class="receiver" aria-labelledby="receiver-title">
      <div class="receiver-toolbar">
        <div class="receiver-heading">
          <FileText :size="19" aria-hidden="true" />
          <div>
            <h2 id="receiver-title">接收内容</h2>
            <span>{{ textSummary }}</span>
          </div>
        </div>
        <div class="toolbar-actions">
          <button
            class="icon-button"
            type="button"
            title="清空内容"
            aria-label="清空内容"
            :disabled="messages.length === 0"
            @click="clearText"
          >
            <Trash2 :size="18" aria-hidden="true" />
          </button>
          <button
            class="copy-button"
            type="button"
            :disabled="messages.length === 0"
            @click="copyText"
          >
            <Check v-if="copied" :size="18" aria-hidden="true" />
            <Copy v-else :size="18" aria-hidden="true" />
            {{ copied ? "已复制" : "复制全部" }}
          </button>
        </div>
      </div>

      <div class="text-surface" :class="{ empty: !receivedText }">
        <pre v-if="receivedText">{{ receivedText }}</pre>
        <div v-else class="empty-state">
          <FileText :size="30" stroke-width="1.5" aria-hidden="true" />
          <span>尚未收到文字</span>
        </div>
      </div>
    </section>
  </main>
</template>
