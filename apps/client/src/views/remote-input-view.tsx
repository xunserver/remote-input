import { ConnectionDialog } from "@/components/connection-dialog";
import { ConnectionStatus } from "@/components/connection-status";
import { InputComposer } from "@/components/input-composer";
import { InputHistory } from "@/components/input-history";
import { useRemoteInput } from "@/hooks/use-remote-input";

export function RemoteInputView() {
  const remoteInput = useRemoteInput();

  return (
    <main className="min-h-svh bg-muted/40 text-foreground">
      <section className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-3 p-3 sm:gap-4 sm:p-5">
        <ConnectionStatus
          connectionState={remoteInput.connectionState}
          connectionUrl={remoteInput.connectionUrl}
          serverInfo={remoteInput.serverInfo}
          clientCount={remoteInput.clientCount}
          currentOperation={remoteInput.currentOperation}
          deviceName={remoteInput.deviceName}
          error={remoteInput.lastError}
          onReconnect={remoteInput.reconnect}
          onOpenSettings={remoteInput.openConnectionSettings}
        />
        <InputComposer
          connectionState={remoteInput.connectionState}
          isBusy={remoteInput.isBusy}
          onSend={remoteInput.sendInput}
        />
        <InputHistory history={remoteInput.history} onClear={remoteInput.clearHistory} />
      </section>

      <ConnectionDialog
        open={remoteInput.showConnectionDialog}
        currentUrl={remoteInput.connectionUrl}
        hasConnectionConfig={remoteInput.hasConnectionConfig}
        connectionState={remoteInput.connectionState}
        error={remoteInput.lastError}
        onConnect={remoteInput.connect}
        onClose={remoteInput.closeConnectionSettings}
      />
    </main>
  );
}
