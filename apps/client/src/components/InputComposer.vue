<script setup lang="ts">
import { computed, ref } from "vue";
import { SendHorizonal, SlidersHorizontal } from "@lucide/vue";
import { Button } from "@shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shadcn/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@shadcn/dialog";
import { Field, FieldGroup, FieldLabel } from "@shadcn/field";
import { Spinner } from "@shadcn/spinner";
import { Textarea } from "@shadcn/textarea";
import type { ConnectionState } from "@/types/remote-input";
import type { InputControl } from "@remote-input/sdk";
import type { KeyboardKey } from "@remote-input/sdk";

type InputMode = "single" | "multi";

type InputComposerProps = {
  connectionState: ConnectionState;
  isBusy: boolean;
  onSend: (text: string, control: InputControl) => Promise<boolean>;
  onSendKey: (key: KeyboardKey) => Promise<boolean>;
};

const quickKeys: { key: KeyboardKey; label: string }[] = [
  { key: "Enter", label: "Enter" },
  { key: "Backspace", label: "Backspace" },
  { key: "Tab", label: "Tab" },
  { key: "Escape", label: "Esc" },
  { key: "Delete", label: "Delete" },
  { key: "Home", label: "Home" },
  { key: "End", label: "End" },
  { key: "PageUp", label: "PgUp" },
  { key: "PageDown", label: "PgDn" },
  { key: "ArrowLeft", label: "←" },
  { key: "ArrowUp", label: "↑" },
  { key: "ArrowDown", label: "↓" },
  { key: "ArrowRight", label: "→" },
  { key: "Space", label: "Space" },
];

const props = defineProps<InputComposerProps>();
const mode = ref<InputMode>("single");
const text = ref("");
const sendInFlight = ref(false);
const paste = ref(true);
const restoreClipboard = ref(true);
const sendEnterAfterText = ref(false);

const isReady = computed(() => props.connectionState === "ready");
const isSending = computed(() => props.isBusy || sendInFlight.value);
const canSend = computed(
  () => isReady.value && text.value.trim().length > 0 && !isSending.value,
);
const isMultiLine = computed({
  get: () => mode.value === "multi",
  set: (checked: boolean) => {
    mode.value = checked ? "multi" : "single";
  },
});

async function send(): Promise<void> {
  if (!canSend.value) {
    return;
  }

  sendInFlight.value = true;
  try {
    const sent = await props.onSend(text.value, {
      paste: paste.value,
      restoreClipboard: restoreClipboard.value,
    });
    if (sent) {
      text.value = "";
      if (sendEnterAfterText.value) {
        await props.onSendKey("Enter");
      }
    }
  } finally {
    sendInFlight.value = false;
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  if (
    mode.value === "single" &&
    event.key === "Enter" &&
    !event.isComposing
  ) {
    event.preventDefault();
    void send();
  }
}
</script>

<template>
  <Dialog>
    <Card class="gap-0 overflow-hidden py-0 shadow-sm">
      <CardHeader class="gap-4 px-4 py-4 sm:px-5">
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <CardTitle class="text-base">发送文字</CardTitle>
            <CardDescription>
              {{
                mode === "single"
                  ? "按 Enter 立即发送"
                  : "支持换行，点击按钮发送"
              }}
            </CardDescription>
          </div>
          <DialogTrigger as-child>
            <Button
              variant="outline"
              size="sm"
              class="sm:hidden"
              aria-label="打开发送设置"
            >
              <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />
              设置
            </Button>
          </DialogTrigger>
        </div>

        <fieldset
          class="hidden gap-2 rounded-lg border bg-muted/30 p-2 sm:grid sm:grid-cols-3"
        >
          <legend class="sr-only">发送控制</legend>
          <label
            for="multi-line-mode"
            class="flex cursor-pointer items-start gap-3 rounded-md bg-background px-3 py-2.5"
          >
            <input
              id="multi-line-mode"
              v-model="isMultiLine"
              type="checkbox"
              class="mt-0.5 size-4 shrink-0 accent-foreground"
            />
            <span class="min-w-0">
              <span class="block text-sm font-medium">多行输入</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">
                Enter 换行，点击按钮发送
              </span>
            </span>
          </label>
          <label
            for="paste-after-copy"
            class="flex cursor-pointer items-start gap-3 rounded-md bg-background px-3 py-2.5"
          >
            <input
              id="paste-after-copy"
              v-model="paste"
              type="checkbox"
              class="mt-0.5 size-4 shrink-0 accent-foreground"
            />
            <span class="min-w-0">
              <span class="block text-sm font-medium">自动粘贴</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">
                复制后立即在接收端粘贴
              </span>
            </span>
          </label>
          <label
            for="restore-clipboard"
            class="flex cursor-pointer items-start gap-3 rounded-md bg-background px-3 py-2.5"
          >
            <input
              id="restore-clipboard"
              v-model="restoreClipboard"
              type="checkbox"
              class="mt-0.5 size-4 shrink-0 accent-foreground"
            />
            <span class="min-w-0">
              <span class="block text-sm font-medium">保留原剪贴板</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">
                输入完成后恢复原内容
              </span>
            </span>
          </label>
        </fieldset>
      </CardHeader>

      <CardContent class="px-4 pb-4 sm:px-5">
        <FieldGroup>
          <Field>
            <FieldLabel for="remote-input-text" class="sr-only">
              发送文字
            </FieldLabel>
            <Textarea
              id="remote-input-text"
              v-model="text"
              autofocus
              :enterkeyhint="mode === 'single' ? 'send' : 'enter'"
              :placeholder="
                isReady ? '在这里输入或粘贴文字…' : '连接对端后即可输入'
              "
              :disabled="!isReady || isSending"
              class="min-h-44 resize-none border-0 bg-muted/60 p-4 text-base shadow-none focus-visible:bg-background focus-visible:ring-2 sm:min-h-56"
              @keydown="handleKeyDown"
            />
          </Field>
        </FieldGroup>
      </CardContent>

      <CardFooter
        class="flex-col gap-3 border-t bg-muted/20 px-4 py-3 sm:flex-row sm:justify-between sm:px-5"
      >
        <p class="w-full text-xs text-muted-foreground sm:w-auto">
          {{
            isReady
              ? `${text.length.toLocaleString()} 个字符`
              : "请先完成对端连接"
          }}
        </p>
        <div class="flex w-full items-center gap-3 sm:w-auto">
          <label
            for="send-enter-after-text"
            class="flex shrink-0 cursor-pointer items-center gap-2 text-sm"
          >
            <input
              id="send-enter-after-text"
              v-model="sendEnterAfterText"
              type="checkbox"
              class="size-4 shrink-0 accent-foreground"
              :disabled="!isReady || isSending"
            />
            <span>Enter</span>
          </label>
          <Button
            data-testid="send-button"
            size="lg"
            class="h-12 min-w-0 flex-1 sm:min-w-32"
            :disabled="!canSend"
            @click="send"
          >
            <Spinner v-if="isSending" data-icon="inline-start" />
            <SendHorizonal
              v-else
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ isSending ? "发送中" : "发送" }}
          </Button>
        </div>
      </CardFooter>

      <div class="border-t px-4 py-3 sm:px-5">
        <div class="mb-2 flex items-center justify-between gap-3">
          <p class="text-sm font-medium">常用按键</p>
          <p class="text-xs text-muted-foreground">发送到当前活动窗口</p>
        </div>
        <div class="flex flex-wrap gap-2" role="group" aria-label="常用按键">
          <Button
            v-for="item in quickKeys"
            :key="item.key"
            type="button"
            variant="outline"
            size="sm"
            class="min-w-11 font-mono"
            :class="{ 'min-w-24': item.key === 'Backspace' || item.key === 'Space' }"
            :disabled="!isReady || isSending"
            :aria-label="`发送 ${item.key} 键`"
            @click="props.onSendKey(item.key)"
          >
            {{ item.label }}
          </Button>
        </div>
      </div>
    </Card>

    <DialogContent
      :show-close-button="false"
      class="top-auto bottom-0 max-w-none translate-y-0 gap-5 rounded-b-none rounded-t-2xl border-b-0 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:hidden"
    >
      <DialogHeader class="text-left">
        <div class="mx-auto mb-1 h-1 w-10 rounded-full bg-border" />
        <DialogTitle>发送设置</DialogTitle>
        <DialogDescription>
          调整输入方式以及接收端的剪贴板行为。
        </DialogDescription>
      </DialogHeader>

      <fieldset class="grid gap-2">
        <legend class="sr-only">发送控制</legend>
        <label
          for="multi-line-mode-mobile"
          class="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3"
        >
          <input
            id="multi-line-mode-mobile"
            v-model="isMultiLine"
            type="checkbox"
            class="mt-0.5 size-4 shrink-0 accent-foreground"
          />
          <span>
            <span class="block text-sm font-medium">多行输入</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">
              Enter 换行，点击按钮发送
            </span>
          </span>
        </label>
        <label
          for="paste-after-copy-mobile"
          class="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3"
        >
          <input
            id="paste-after-copy-mobile"
            v-model="paste"
            type="checkbox"
            class="mt-0.5 size-4 shrink-0 accent-foreground"
          />
          <span>
            <span class="block text-sm font-medium">自动粘贴</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">
              复制后立即在接收端粘贴
            </span>
          </span>
        </label>
        <label
          for="restore-clipboard-mobile"
          class="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3"
        >
          <input
            id="restore-clipboard-mobile"
            v-model="restoreClipboard"
            type="checkbox"
            class="mt-0.5 size-4 shrink-0 accent-foreground"
          />
          <span>
            <span class="block text-sm font-medium">保留原剪贴板</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">
              输入完成后恢复原内容
            </span>
          </span>
        </label>
      </fieldset>

      <DialogFooter class="grid grid-cols-1">
        <DialogClose as-child>
          <Button class="h-11 w-full">完成</Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
