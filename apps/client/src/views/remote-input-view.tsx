import { ConnectionDialog } from "@/components/connection-dialog";
import { ConnectionStatus } from "@/components/connection-status";
import { InputComposer } from "@/components/input-composer";
import { InputHistory } from "@/components/input-history";
import { useRemoteInput } from "@/hooks/use-remote-input";

export function RemoteInputView() {
  const remoteInput = useRemoteInput();

  return (
    <main className="min-h-svh text-foreground">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:gap-5 sm:px-6 sm:pt-6">
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
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-5">
          <InputComposer
            connectionState={remoteInput.connectionState}
            isBusy={remoteInput.isBusy}
            onSend={remoteInput.sendInput}
          />
          <InputHistory
            history={remoteInput.history}
            canResend={remoteInput.connectionState === "ready" && !remoteInput.isBusy}
            onResend={remoteInput.sendInput}
            onClear={remoteInput.clearHistory}
          />
        </div>
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
