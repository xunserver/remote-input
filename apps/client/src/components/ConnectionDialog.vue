<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Bluetooth, PlugZap, Server } from "@lucide/vue";
import { Button } from "@shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shadcn/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@shadcn/field";
import { Input } from "@shadcn/input";
import { Spinner } from "@shadcn/spinner";
import { cn } from "@shadcn/utils";
import type {
  ConnectionConfig,
  ConnectionMethod,
  ConnectionState,
} from "@/types/remote-input";
import {
  buildWebSocketUrl,
  getConfigFromUrl,
  getDefaultConnectionConfig,
} from "@/utils/connection";

type ConnectionDialogProps = {
  open: boolean;
  currentMethod: ConnectionMethod;
  currentUrl: string;
  hasConnectionConfig: boolean;
  connectionState: ConnectionState;
  error: string;
  onConnect: (method: ConnectionMethod, url?: string) => void;
  onClose: () => void;
};

const props = defineProps<ConnectionDialogProps>();
const selectedMethod = ref<ConnectionMethod>(props.currentMethod);
const config = reactive<ConnectionConfig>(getConfigFromUrl(props.currentUrl));
const defaultConfig = getDefaultConnectionConfig();
const connectionUrl = computed(() => buildWebSocketUrl(config));
const isConnecting = computed(() => props.connectionState === "connecting");

watch(
  [() => props.currentMethod, () => props.currentUrl, () => props.open],
  ([currentMethod, currentUrl, open]) => {
    if (open) {
      selectedMethod.value = currentMethod;
      Object.assign(config, getConfigFromUrl(currentUrl));
    }
  },
);

function handleOpenChange(nextOpen: boolean): void {
  if (!nextOpen && props.hasConnectionConfig) props.onClose();
}

function preventInitialClose(event: Event): void {
  if (!props.hasConnectionConfig) event.preventDefault();
}

function connect(): void {
  if (!isConnecting.value) {
    props.onConnect(
      selectedMethod.value,
      selectedMethod.value === "websocket" ? connectionUrl.value : undefined,
    );
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="handleOpenChange">
    <DialogContent
      :show-close-button="false"
      class="top-auto bottom-0 max-w-none translate-y-0 gap-5 rounded-b-none rounded-t-2xl border-b-0 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:top-1/2 sm:bottom-auto sm:max-w-md sm:-translate-y-1/2 sm:rounded-2xl sm:border-b sm:p-6"
      @escape-key-down="preventInitialClose"
      @pointer-down-outside="preventInitialClose"
    >
      <DialogHeader class="text-left">
        <div class="mx-auto mb-1 h-1 w-10 rounded-full bg-border sm:hidden" />
        <DialogTitle>选择连接方式</DialogTitle>
        <DialogDescription>
          通过蓝牙直连 ESP32，或连接到 WebSocket 服务器。
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-5" @submit.prevent="connect">
        <div class="grid grid-cols-2 gap-3" role="radiogroup" aria-label="连接方式">
          <button
            type="button"
            role="radio"
            :aria-checked="selectedMethod === 'bluetooth'"
            :class="cn(
              'flex min-h-24 flex-col items-start gap-2 rounded-xl border bg-background p-4 text-left transition-colors hover:bg-muted/60',
              selectedMethod === 'bluetooth' && 'border-primary bg-primary/5 ring-1 ring-primary',
            )"
            @click="selectedMethod = 'bluetooth'"
          >
            <Bluetooth class="size-5" aria-hidden="true" />
            <span class="text-sm font-medium">蓝牙连接</span>
            <span class="text-xs text-muted-foreground">直连 ESP32-S3</span>
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="selectedMethod === 'websocket'"
            :class="cn(
              'flex min-h-24 flex-col items-start gap-2 rounded-xl border bg-background p-4 text-left transition-colors hover:bg-muted/60',
              selectedMethod === 'websocket' && 'border-primary bg-primary/5 ring-1 ring-primary',
            )"
            @click="selectedMethod = 'websocket'"
          >
            <Server class="size-5" aria-hidden="true" />
            <span class="text-sm font-medium">WebSocket</span>
            <span class="text-xs text-muted-foreground">连接 WS Server</span>
          </button>
        </div>

        <template v-if="selectedMethod === 'websocket'">
          <FieldGroup class="gap-4">
            <Field>
              <FieldLabel for="connection-host">IP 或主机名</FieldLabel>
              <Input
                id="connection-host"
                v-model="config.host"
                :placeholder="defaultConfig.host"
                autocapitalize="none"
                autocorrect="off"
              />
            </Field>
            <Field>
              <FieldLabel for="connection-port">端口</FieldLabel>
              <Input
                id="connection-port"
                v-model="config.port"
                :placeholder="defaultConfig.port || (config.secure ? '443' : '80')"
                inputmode="numeric"
                pattern="[0-9]*"
              />
            </Field>
          </FieldGroup>
          <FieldDescription class="truncate rounded-md bg-muted px-3 py-2 text-xs">
            {{ connectionUrl }}
          </FieldDescription>
        </template>
        <FieldDescription v-else>
          点击连接后，浏览器会请求蓝牙访问权限并让你选择附近的 Remote Input 设备。
        </FieldDescription>

        <FieldError v-if="props.error">{{ props.error }}</FieldError>

        <DialogFooter
          :class="cn(
            'grid gap-2',
            props.hasConnectionConfig ? 'grid-cols-2' : 'grid-cols-1',
          )"
        >
          <Button
            v-if="props.hasConnectionConfig"
            type="button"
            variant="outline"
            class="h-11 w-full"
            @click="props.onClose"
          >
            取消
          </Button>
          <Button type="submit" class="h-11 w-full" :disabled="isConnecting">
            <Spinner v-if="isConnecting" data-icon="inline-start" />
            <Bluetooth
              v-else-if="selectedMethod === 'bluetooth'"
              data-icon="inline-start"
              aria-hidden="true"
            />
            <PlugZap v-else data-icon="inline-start" aria-hidden="true" />
            {{
              isConnecting
                ? "连接中"
                : selectedMethod === "bluetooth"
                  ? "选择蓝牙设备"
                  : "连接服务器"
            }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
