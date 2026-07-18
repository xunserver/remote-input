import type { LucideIcon } from "lucide-react";
import { Activity, CheckCircle2, Keyboard, RefreshCw, Server, Settings2, Users } from "lucide-react";
import { Button } from "@shadcn/button";
import { Card, CardContent, CardDescription, CardHeader } from "@shadcn/card";
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

export function ConnectionStatus({
  connectionState,
  connectionUrl,
  serverInfo,
  clientCount,
  currentOperation,
  deviceName,
  error,
  onReconnect,
  onOpenSettings,
}: ConnectionStatusProps) {
  const isReady = connectionState === "ready";
  const peerEndpoint = getPeerEndpoint(connectionUrl, serverInfo);
  const statusMessage =
    error ||
    currentOperation?.message ||
    (currentOperation ? statusLabel(currentOperation.state, currentOperation.stage) : isReady ? "" : "连接服务器后即可开始发送");

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Keyboard aria-hidden="true" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-xl font-semibold tracking-tight">远程输入</h1>
            <p className="text-sm text-muted-foreground">把文字快速发送到另一台设备</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="连接设置"
            aria-label="连接设置"
            onClick={onOpenSettings}
          >
            <Settings2 />
          </Button>
        </div>
      </div>

      <Card className="gap-0 overflow-hidden py-0 shadow-xs">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 sm:px-4">
          <div
            className={cn(
              "flex size-9 items-center justify-center rounded-full bg-secondary text-secondary-foreground",
              isReady && "bg-primary/10 text-primary",
            )}
          >
            <Activity aria-hidden="true" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">{connectionLabel(connectionState)}</span>
            <CardDescription className="truncate text-xs">{peerEndpoint || "等待对端信息"}</CardDescription>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              title="重新连接"
              aria-label="重新连接"
              disabled={connectionState === "connecting"}
              onClick={onReconnect}
            >
              <RefreshCw className={cn(connectionState === "connecting" && "animate-spin")} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 border-t bg-muted/30 px-3 py-3 sm:px-4">
          <div className="grid grid-cols-2 gap-2">
            <StatusTile icon={Server} label="连接对端" value={deviceName || "等待识别"} />
            <StatusTile icon={Users} label="在线客户端" value={`${clientCount} 个`} muted={clientCount === 0} />
          </div>
          {statusMessage ? (
            <div className="flex items-center gap-2 px-3">
              <CheckCircle2 className={cn("shrink-0 text-muted-foreground", isReady && "text-primary")} />
              <p className={cn("min-w-0 flex-1 text-sm text-muted-foreground", error && "text-destructive")}>{statusMessage}</p>
              {currentOperation ? (
                <span className="shrink-0 text-xs font-medium tabular-nums">{currentOperation.progress}%</span>
              ) : null}
            </div>
          ) : null}
          {currentOperation ? <Progress value={currentOperation.progress} className="h-1.5" /> : null}
        </CardContent>
      </Card>
    </header>
  );
}

function getPeerEndpoint(connectionUrl: string, serverInfo: ServerInfo | null): string {
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

function StatusTile({
  icon: Icon,
  label,
  value,
  muted = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-background px-3 py-2 shadow-xs ring-1 ring-border/70">
      <Icon className={cn("shrink-0", muted && "text-muted-foreground")} />
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="truncate text-sm font-medium">{value}</span>
      </div>
    </div>
  );
}
