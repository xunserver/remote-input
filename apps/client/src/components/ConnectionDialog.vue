<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { PlugZap } from "@lucide/vue";
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
  ConnectionState,
} from "@/types/remote-input";
import {
  buildWebSocketUrl,
  getConfigFromUrl,
  getDefaultConnectionConfig,
} from "@/utils/connection";

type ConnectionDialogProps = {
  open: boolean;
  currentUrl: string;
  hasConnectionConfig: boolean;
  connectionState: ConnectionState;
  error: string;
  onConnect: (url: string) => void;
  onClose: () => void;
};

const props = defineProps<ConnectionDialogProps>();
const config = reactive<ConnectionConfig>(getConfigFromUrl(props.currentUrl));
const defaultConfig = getDefaultConnectionConfig();
const connectionUrl = computed(() => buildWebSocketUrl(config));
const isConnecting = computed(
  () => props.connectionState === "connecting",
);

watch(
  [() => props.currentUrl, () => props.open],
  ([currentUrl, open]) => {
    if (open) {
      Object.assign(config, getConfigFromUrl(currentUrl));
    }
  },
);

function handleOpenChange(nextOpen: boolean): void {
  if (!nextOpen && props.hasConnectionConfig) {
    props.onClose();
  }
}

function preventInitialClose(event: Event): void {
  if (!props.hasConnectionConfig) {
    event.preventDefault();
  }
}

function connect(): void {
  if (!isConnecting.value) {
    props.onConnect(connectionUrl.value);
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
        <DialogTitle>连接服务器</DialogTitle>
        <DialogDescription>
          填写服务器 IP 或主机名和端口，默认使用当前网页地址。
        </DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-5" @submit.prevent="connect">
        <FieldGroup class="gap-4">
          <Field>
            <FieldLabel for="connection-host">IP 或主机名</FieldLabel>
            <Input
              id="connection-host"
              v-model="config.host"
              autofocus
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
              :placeholder="
                defaultConfig.port || (config.secure ? '443' : '80')
              "
              inputmode="numeric"
              pattern="[0-9]*"
            />
          </Field>
        </FieldGroup>

        <FieldDescription
          class="truncate rounded-md bg-muted px-3 py-2 text-xs"
        >
          {{ connectionUrl }}
        </FieldDescription>
        <FieldError v-if="props.error">{{ props.error }}</FieldError>

        <DialogFooter
          :class="
            cn(
              'grid gap-2',
              props.hasConnectionConfig ? 'grid-cols-2' : 'grid-cols-1',
            )
          "
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
          <Button
            type="submit"
            class="h-11 w-full"
            :disabled="isConnecting"
          >
            <Spinner v-if="isConnecting" data-icon="inline-start" />
            <PlugZap
              v-else
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{ isConnecting ? "连接中" : "连接" }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
