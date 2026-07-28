<script setup lang="ts">
import { computed, ref } from "vue";
import { SendHorizonal } from "@lucide/vue";
import { Button } from "@shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@shadcn/card";
import { Field, FieldGroup, FieldLabel } from "@shadcn/field";
import { Spinner } from "@shadcn/spinner";
import { Switch } from "@shadcn/switch";
import { Textarea } from "@shadcn/textarea";
import type { ConnectionState } from "@/types/remote-input";
import type { InputControl } from "@remote-input/sdk";

type InputMode = "single" | "multi";

type InputComposerProps = {
  connectionState: ConnectionState;
  isBusy: boolean;
  onSend: (text: string, control: InputControl) => Promise<boolean>;
};

const props = defineProps<InputComposerProps>();
const mode = ref<InputMode>("single");
const text = ref("");
const sendInFlight = ref(false);
const paste = ref(true);
const restoreClipboard = ref(false);

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
    if (await props.onSend(text.value, {
      paste: paste.value,
      restoreClipboard: restoreClipboard.value,
    })) {
      text.value = "";
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
  <Card class="gap-0 overflow-hidden py-0 shadow-sm">
    <CardHeader
      class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:px-5"
    >
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
      <Field orientation="horizontal" class="w-auto shrink-0 gap-2">
        <FieldLabel
          for="multi-line-mode"
          class="text-sm font-normal text-muted-foreground"
        >
          多行
        </FieldLabel>
        <Switch
          id="multi-line-mode"
          v-model="isMultiLine"
          aria-label="切换多行输入"
        />
      </Field>
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
      <div class="mt-4 grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-2">
        <Field orientation="horizontal" class="justify-between gap-3">
          <div>
            <FieldLabel for="paste-after-copy">自动粘贴</FieldLabel>
            <p class="text-xs text-muted-foreground">关闭后只复制到接收端剪贴板</p>
          </div>
          <Switch
            id="paste-after-copy"
            v-model="paste"
            aria-label="复制后自动粘贴"
          />
        </Field>
        <Field orientation="horizontal" class="justify-between gap-3">
          <div>
            <FieldLabel for="restore-clipboard">恢复剪贴板</FieldLabel>
            <p class="text-xs text-muted-foreground">输入完成后恢复接收端原内容</p>
          </div>
          <Switch
            id="restore-clipboard"
            v-model="restoreClipboard"
            aria-label="输入后恢复原剪贴板"
          />
        </Field>
      </div>
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
      <Button
        size="lg"
        class="h-12 w-full sm:w-auto sm:min-w-32"
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
    </CardFooter>
  </Card>
</template>
