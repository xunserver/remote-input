import type { LucideIcon } from "lucide-react";
import { CheckCircle2, Clock3, LinkIcon, RefreshCw, Server, Settings2 } from "lucide-react";
import type { ServerInfo } from "@remote-copy/sdk";
import { Badge } from "@shadcn/badge";
import { Button } from "@shadcn/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@shadcn/card";
import { Progress } from "@shadcn/progress";
import { cn } from "@shadcn/utils";
import { connectionLabel, statusLabel, type ConnectionState, type InputStatus } from "@/types/remote-input";

type ConnectionStatusProps = {
  connectionState: ConnectionState;
  connectionUrl: string;
  serverInfo: ServerInfo | null;
  clientCount: number;
  currentStatus: InputStatus | null;
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
  currentStatus,
  deviceName,
  error,
  onReconnect,
  onOpenSettings,
}: ConnectionStatusProps) {
  return (
    <Card className="rounded-lg shadow-sm">
      <CardHeader className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="text-lg">远程输入</CardTitle>
            <CardDescription className="truncate">{connectionUrl}</CardDescription>
          </div>
          <Badge variant={connectionState === "ready" ? "default" : "secondary"}>
            {connectionLabel(connectionState)}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <StatusTile icon={Server} label="服务器" value={serverInfo ? `:${serverInfo.port}` : "未知"} />
          <StatusTile icon={LinkIcon} label="客户端" value={`${clientCount} 个`} muted={clientCount === 0} />
          <StatusTile icon={Clock3} label="输入进度" value={`${currentStatus?.progress ?? 0}%`} />
          <StatusTile icon={CheckCircle2} label="当前状态" value={statusLabel(currentStatus?.status)} />
        </div>

        <Progress value={currentStatus?.progress ?? 0} />
        <div className="flex items-center justify-between gap-2">
          <p className={cn("min-h-5 min-w-0 flex-1 text-sm text-muted-foreground", error && "text-destructive")}>
            {error ||
              currentStatus?.message ||
              (currentStatus ? statusLabel(currentStatus.status) : deviceName ? `${deviceName} 已准备输入` : "等待连接服务器")}
          </p>
          <div className="flex shrink-0 items-center gap-1">
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
            <Button variant="outline" size="sm" onClick={onOpenSettings}>
              <Settings2 data-icon="inline-start" />
              连接设置
            </Button>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
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
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border p-2">
      <Icon className={cn(muted && "text-muted-foreground")} />
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="truncate font-medium">{value}</span>
      </div>
    </div>
  );
}
