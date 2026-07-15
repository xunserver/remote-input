import { useEffect, useState } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { Button } from "@shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shadcn/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@shadcn/field";
import { Input } from "@shadcn/input";
import { cn } from "@shadcn/utils";
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

  const defaultConfig = getDefaultConnectionConfig();
  const connectionUrl = buildSocketIoUrl(config);
  const isConnecting = connectionState === "connecting";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && hasConnectionConfig) {
          onClose();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-auto bottom-0 max-w-none translate-y-0 gap-5 rounded-b-none rounded-t-2xl border-b-0 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:top-1/2 sm:bottom-auto sm:max-w-md sm:-translate-y-1/2 sm:rounded-2xl sm:border-b sm:p-6"
        onEscapeKeyDown={(event) => {
          if (!hasConnectionConfig) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (!hasConnectionConfig) event.preventDefault();
        }}
      >
        <DialogHeader className="text-left">
          <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-border sm:hidden" />
          <DialogTitle>连接服务器</DialogTitle>
          <DialogDescription>填写服务器 IP 或主机名和端口，默认使用当前网页地址。</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            onConnect(connectionUrl);
          }}
        >
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="connection-host">IP 或主机名</FieldLabel>
              <Input
                id="connection-host"
                autoFocus
                value={config.host}
                placeholder={defaultConfig.host}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(event) => setConfig((current) => ({ ...current, host: event.target.value }))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="connection-port">端口</FieldLabel>
              <Input
                id="connection-port"
                value={config.port}
                placeholder={defaultConfig.port || (config.secure ? "443" : "80")}
                inputMode="numeric"
                pattern="[0-9]*"
                onChange={(event) => setConfig((current) => ({ ...current, port: event.target.value }))}
              />
            </Field>
          </FieldGroup>

          <FieldDescription className="truncate rounded-md bg-muted px-3 py-2 text-xs">{connectionUrl}</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}

          <DialogFooter className={cn("grid gap-2", hasConnectionConfig ? "grid-cols-2" : "grid-cols-1")}>
            {hasConnectionConfig ? (
              <Button type="button" variant="outline" className="h-11 w-full" onClick={onClose}>
                取消
              </Button>
            ) : null}
            <Button type="submit" className="h-11 w-full" disabled={isConnecting}>
              {isConnecting ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <PlugZap data-icon="inline-start" />
              )}
              {isConnecting ? "连接中" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
