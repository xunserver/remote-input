import { useEffect, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { Button } from "@shadcn/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shadcn/card";
import { Input } from "@shadcn/input";
import type { ConnectionConfig, ConnectionState } from "@/types/remote-input";
import { buildSocketIoUrl, getConfigFromUrl, getDefaultConnectionConfig } from "@/utils/connection";

type ConnectionDialogProps = {
  open: boolean;
  currentUrl: string;
  hasConnectionConfig: boolean;
  connectionState: ConnectionState;
  error: string;
  onConnect: (url: string) => void;
  onClose: () => void;
};

export function ConnectionDialog({
  open,
  currentUrl,
  hasConnectionConfig,
  connectionState,
  error,
  onConnect,
  onClose,
}: ConnectionDialogProps) {
  const [config, setConfig] = useState<ConnectionConfig>(() => getConfigFromUrl(currentUrl));

  useEffect(() => {
    if (open) {
      setConfig(getConfigFromUrl(currentUrl));
    }
  }, [currentUrl, open]);

  if (!open) {
    return null;
  }

  const defaultConfig = getDefaultConnectionConfig();
  const connectionUrl = buildSocketIoUrl(config);
  const isConnecting = connectionState === "connecting";

  return (
    <div className="fixed inset-0 flex items-end bg-background/80 p-3 backdrop-blur-sm sm:items-center sm:justify-center">
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-dialog-title"
        className="w-full rounded-lg shadow-lg sm:max-w-md"
      >
        <CardHeader>
          <CardTitle id="connection-dialog-title">连接服务器</CardTitle>
          <CardDescription>填写服务器 IP 或主机名和端口，默认使用当前网页地址。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onConnect(connectionUrl);
            }}
          >
            <label className="flex flex-col gap-2 text-sm font-medium">
              IP 或主机名
              <Input
                autoFocus
                value={config.host}
                placeholder={defaultConfig.host}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => setConfig((current) => ({ ...current, host: event.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium">
              端口
              <Input
                value={config.port}
                placeholder={defaultConfig.port || (config.secure ? "443" : "80")}
                inputMode="numeric"
                pattern="[0-9]*"
                onChange={(event) => setConfig((current) => ({ ...current, port: event.target.value }))}
              />
            </label>
            <p className="truncate text-xs text-muted-foreground">{connectionUrl}</p>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              {hasConnectionConfig ? (
                <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
                  取消
                </Button>
              ) : null}
              <Button type="submit" className="h-11 flex-1" disabled={isConnecting}>
                {isConnecting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <PlugZap data-icon="inline-start" />
                )}
                {isConnecting ? "连接中" : "连接"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
