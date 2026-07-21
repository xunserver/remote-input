<script setup lang="ts">
import { computed } from "vue";
import {
  Activity,
  CheckCircle2,
  Keyboard,
  RefreshCw,
  Server,
  Settings2,
  Users,
} from "@lucide/vue";
import { Button } from "@shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@shadcn/card";
import { Progress } from "@shadcn/progress";
import { cn } from "@shadcn/utils";
import {
  connectionLabel,
  statusLabel,
  type ConnectionState,
  type OperationStatus,
  type ServerInfo,
} from "@/types/remote-input";

type ConnectionStatusProps = {
  connectionState: ConnectionState;
  connectionUrl: string;
  serverInfo: ServerInfo | null;
  clientCount: number;
  currentOperation: OperationStatus | null;
  deviceName: string;
  error: string;
  onReconnect: () => void;
  onOpenSettings: () => void;
};

const props = defineProps<ConnectionStatusProps>();

const isReady = computed(() => props.connectionState === "ready");
const peerEndpoint = computed(() =>
  getPeerEndpoint(props.connectionUrl, props.serverInfo),
);
const statusMessage = computed(
  () =>
    props.error ||
    props.currentOperation?.message ||
    (props.currentOperation
      ? statusLabel(
          props.currentOperation.state,
          props.currentOperation.stage,
        )
      : isReady.value
        ? ""
        : "连接服务器后即可开始发送"),
);

function getPeerEndpoint(
  connectionUrl: string,
  serverInfo: ServerInfo | null,
): string {
  if (!serverInfo) {
    return "";
  }

  try {
    const hostname = new URL(connectionUrl).hostname;
    if (hostname) {
      return `${hostname}:${serverInfo.port}`;
    }
  } catch {
    // 握手返回的服务端地址仍可作为回退，不显示未经确认的网页来源地址。
  }

  const address = serverInfo.lanAddresses[0];
  return address ? `${address}:${serverInfo.port}` : `端口 ${serverInfo.port}`;
}
</script>

<template>
  <header class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-3 px-1">
      <div class="flex min-w-0 items-center gap-3">
        <div
          class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
        >
          <Keyboard aria-hidden="true" />
        </div>
        <div class="flex min-w-0 flex-col gap-0.5">
          <h1 class="text-xl font-semibold tracking-tight">远程输入</h1>
          <p class="text-sm text-muted-foreground">
            把文字快速发送到另一台设备
          </p>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          title="连接设置"
          aria-label="连接设置"
          @click="props.onOpenSettings"
        >
          <Settings2 data-icon="inline-start" aria-hidden="true" />
        </Button>
      </div>
    </div>

    <Card class="gap-0 overflow-hidden py-0 shadow-xs">
      <CardHeader
        class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-4"
      >
        <div
          :class="
            cn(
              'flex size-9 items-center justify-center rounded-full bg-secondary text-secondary-foreground',
              isReady && 'bg-primary/10 text-primary',
            )
          "
        >
          <Activity aria-hidden="true" />
        </div>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-sm font-medium">
            {{ connectionLabel(props.connectionState) }}
          </span>
          <CardDescription class="truncate text-xs">
            {{ peerEndpoint || "等待对端信息" }}
          </CardDescription>
        </div>
        <div class="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="重新连接"
            aria-label="重新连接"
            :disabled="props.connectionState === 'connecting'"
            @click="props.onReconnect"
          >
            <RefreshCw
              data-icon="inline-start"
              aria-hidden="true"
              :class="
                cn(props.connectionState === 'connecting' && 'animate-spin')
              "
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent
        class="flex flex-col gap-3 border-t bg-muted/30 px-3 py-3 sm:px-4"
      >
        <div class="grid grid-cols-2 gap-2">
          <div
            class="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
          >
            <Server class="shrink-0" aria-hidden="true" />
            <div class="flex min-w-0 flex-col">
              <span class="text-xs text-muted-foreground">连接对端</span>
              <span class="truncate text-sm font-medium">
                {{ props.deviceName || "等待识别" }}
              </span>
            </div>
          </div>
          <div
            class="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70"
          >
            <Users
              aria-hidden="true"
              :class="
                cn(
                  'shrink-0',
                  props.clientCount === 0 && 'text-muted-foreground',
                )
              "
            />
            <div class="flex min-w-0 flex-col">
              <span class="text-xs text-muted-foreground">在线客户端</span>
              <span class="truncate text-sm font-medium">
                {{ props.clientCount }} 个
              </span>
            </div>
          </div>
        </div>
        <div v-if="statusMessage" class="flex items-center gap-2 px-3">
          <CheckCircle2
            aria-hidden="true"
            :class="
              cn(
                'shrink-0 text-muted-foreground',
                isReady && 'text-primary',
              )
            "
          />
          <p
            :class="
              cn(
                'min-w-0 flex-1 text-sm text-muted-foreground',
                props.error && 'text-destructive',
              )
            "
          >
            {{ statusMessage }}
          </p>
          <span
            v-if="props.currentOperation"
            class="shrink-0 text-xs font-medium tabular-nums"
          >
            {{ props.currentOperation.progress }}%
          </span>
        </div>
        <Progress
          v-if="props.currentOperation"
          :model-value="props.currentOperation.progress"
          class="h-1.5"
        />
      </CardContent>
    </Card>
  </header>
</template>
