<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ExternalLink,
  RefreshCw,
  SendHorizonal,
  Settings2,
  X,
} from "@lucide/vue";
import { Button } from "@shadcn/button";
import { Spinner } from "@shadcn/spinner";
import { Textarea } from "@shadcn/textarea";
import ConnectionDialog from "@/components/ConnectionDialog.vue";
import { useRemoteInput } from "@/composables/useRemoteInput";
import {
  getFullSenderUrl,
  readBookmarkletSelectionFromHash,
  type BookmarkletMessage,
} from "@/utils/bookmarklet";

const {
  connectionMethod,
  connectionState,
  webSocketUrl,
  hasConnectionConfig,
  showConnectionDialog,
  currentOperation,
  isBusy,
  lastError,
  connect,
  reconnect,
  openConnectionSettings,
  closeConnectionSettings,
  sendInput,
} = useRemoteInput();

const text = ref("");
const sent = ref(false);
const fullSenderUrl = getFullSenderUrl();
let closeTimer: number | undefined;
let pendingOperationId: string | undefined;

function getMessageTarget(): Window {
  return window.opener && !window.opener.closed
    ? window.opener
    : window.parent;
}

const canSend = computed(
  () =>
    connectionState.value === "ready" &&
    text.value.trim().length > 0 &&
    !isBusy.value,
);
const statusText = computed(() => {
  if (sent.value) {
    return "发送成功";
  }
  if (currentOperation.value?.state === "failed") {
    return currentOperation.value.message;
  }
  if (connectionState.value === "connecting") {
    return "正在连接发送端…";
  }
  if (connectionState.value === "ready") {
    return `${text.value.length.toLocaleString()} 个字符`;
  }
  if (lastError.value) {
    return lastError.value;
  }
  if (connectionState.value === "disconnected") {
    return "连接已断开，请重新连接";
  }
  return "请选择蓝牙或 WebSocket 完成连接";
});

function postToParent(message: BookmarkletMessage): void {
  const target = getMessageTarget();
  if (target !== window) {
    target.postMessage(message, "*");
  }
}

function close(): void {
  if (window.parent === window) {
    window.close();
    return;
  }
  postToParent({ type: "remote-input:close" });
}

function handleMessage(event: MessageEvent<BookmarkletMessage>): void {
  if (
    event.source !== getMessageTarget() ||
    !event.data ||
    event.data.type !== "remote-input:selection"
  ) {
    return;
  }
  text.value = event.data.text;
  sent.value = false;
  if (event.data.autoSend && connectionState.value === "ready") {
    void send();
  }
}

async function send(): Promise<void> {
  if (!canSend.value) {
    return;
  }
  const accepted = await sendInput(text.value, {
    paste: true,
    restoreClipboard: true,
  });
  if (!accepted) {
    return;
  }

  const operation = currentOperation.value;
  if (
    connectionMethod.value === "bluetooth" &&
    operation?.state === "processing"
  ) {
    pendingOperationId = operation.operationId;
    return;
  }
  finishSuccessfulSend();
}

function finishSuccessfulSend(): void {
  if (sent.value) {
    return;
  }
  pendingOperationId = undefined;
  sent.value = true;
  closeTimer = window.setTimeout(close, 700);
}

watch(currentOperation, (operation) => {
  if (!pendingOperationId || operation?.operationId !== pendingOperationId) {
    return;
  }
  if (operation.state === "succeeded") {
    finishSuccessfulSend();
  } else if (operation.state === "failed") {
    pendingOperationId = undefined;
  }
});

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

onMounted(() => {
  text.value = readBookmarkletSelectionFromHash();
  window.addEventListener("message", handleMessage);
  postToParent({ type: "remote-input:ready" });
});

onUnmounted(() => {
  window.removeEventListener("message", handleMessage);
  if (closeTimer !== undefined) {
    window.clearTimeout(closeTimer);
  }
});
</script>

<template>
  <main class="flex min-h-svh flex-col bg-background text-foreground">
    <header class="flex h-14 shrink-0 items-center justify-between border-b px-4">
      <div class="min-w-0">
        <h1 class="truncate text-sm font-semibold">快速发送选中文本</h1>
        <p class="truncate text-xs text-muted-foreground">
          Enter 发送，Shift + Enter 换行
        </p>
      </div>
      <div class="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="连接设置"
          title="连接设置"
          @click="openConnectionSettings"
        >
          <Settings2 aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="关闭悬浮窗" @click="close">
          <X aria-hidden="true" />
        </Button>
      </div>
    </header>

    <section class="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <Textarea
        v-model="text"
        autofocus
        placeholder="请先在网页中选中文字，也可以直接在这里输入…"
        class="min-h-0 flex-1 resize-none p-3 text-sm"
        :disabled="isBusy"
        @keydown="handleKeyDown"
      />
      <div class="flex min-h-8 items-center gap-2">
        <p
          class="min-w-0 flex-1 text-xs"
          :class="
            currentOperation?.state === 'failed' || connectionState === 'error'
              ? 'text-destructive'
              : sent
                ? 'text-emerald-600'
                : 'text-muted-foreground'
          "
        >
          {{ statusText }}
        </p>
        <Button
          v-if="
            !showConnectionDialog &&
            (connectionState === 'error' || connectionState === 'disconnected')
          "
          variant="outline"
          size="sm"
          @click="reconnect"
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          重新连接
        </Button>
      </div>
      <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Button class="h-11" :disabled="!canSend" @click="send">
          <Spinner v-if="isBusy" data-icon="inline-start" />
          <SendHorizonal v-else data-icon="inline-start" aria-hidden="true" />
          {{ isBusy ? "发送中" : sent ? "已发送" : "发送并粘贴" }}
        </Button>
        <Button
          as-child
          variant="outline"
          size="icon"
          class="size-11"
          title="打开完整发送页"
        >
          <a :href="fullSenderUrl" target="_blank" rel="noreferrer">
            <ExternalLink aria-label="打开完整发送页" />
          </a>
        </Button>
      </div>
    </section>
  </main>

  <ConnectionDialog
    :open="showConnectionDialog"
    :current-method="connectionMethod"
    :current-url="webSocketUrl"
    :has-connection-config="hasConnectionConfig"
    :connection-state="connectionState"
    :error="lastError"
    :on-connect="connect"
    :on-close="closeConnectionSettings"
  />
</template>
