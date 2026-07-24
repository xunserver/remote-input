<script setup lang="ts">
import { computed } from "vue";
import { Bluetooth } from "@lucide/vue";
import { Button } from "@shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shadcn/dialog";
import { FieldError } from "@shadcn/field";
import { Spinner } from "@shadcn/spinner";
import type { ConnectionState } from "@/types/remote-input";

type ConnectionDialogProps = {
  open: boolean;
  currentUrl: string;
  hasConnectionConfig: boolean;
  connectionState: ConnectionState;
  error: string;
  onConnect: () => void;
  onClose: () => void;
};

const props = defineProps<ConnectionDialogProps>();
const isConnecting = computed(() => props.connectionState === "connecting");

function handleOpenChange(nextOpen: boolean): void {
  if (!nextOpen && props.hasConnectionConfig) props.onClose();
}

function preventInitialClose(event: Event): void {
  if (!props.hasConnectionConfig) event.preventDefault();
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
        <DialogTitle>连接 ESP32-S3</DialogTitle>
        <DialogDescription>
          选择附近的 Remote Copy 设备。浏览器会请求蓝牙访问权限。
        </DialogDescription>
      </DialogHeader>

      <FieldError v-if="props.error">{{ props.error }}</FieldError>

      <DialogFooter class="grid gap-2" :class="props.hasConnectionConfig ? 'grid-cols-2' : 'grid-cols-1'">
        <Button v-if="props.hasConnectionConfig" type="button" variant="outline" class="h-11 w-full" @click="props.onClose">
          取消
        </Button>
        <Button type="button" class="h-11 w-full" :disabled="isConnecting" @click="props.onConnect">
          <Spinner v-if="isConnecting" data-icon="inline-start" />
          <Bluetooth v-else data-icon="inline-start" aria-hidden="true" />
          {{ isConnecting ? "连接中" : "选择蓝牙设备" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
