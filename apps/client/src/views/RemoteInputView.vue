<script setup lang="ts">
import BookmarkletInstaller from "@/components/BookmarkletInstaller.vue";
import ConnectionDialog from "@/components/ConnectionDialog.vue";
import ConnectionStatus from "@/components/ConnectionStatus.vue";
import InputComposer from "@/components/InputComposer.vue";
import InputHistory from "@/components/InputHistory.vue";
import { useRemoteInput } from "@/composables/useRemoteInput";

const {
  connectionMethod,
  connectionState,
  connectionUrl,
  webSocketUrl,
  hasConnectionConfig,
  showConnectionDialog,
  deviceName,
  serverInfo,
  clientCount,
  lastError,
  currentOperation,
  history,
  isBusy,
  connect,
  reconnect,
  disconnect,
  resetConnection,
  openConnectionSettings,
  closeConnectionSettings,
  sendInput,
  sendKey,
  clearHistory,
} = useRemoteInput();
</script>

<template>
  <main class="min-h-svh text-foreground">
    <section
      class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:gap-5 sm:px-6 sm:pt-6"
    >
      <ConnectionStatus
        :connection-method="connectionMethod"
        :connection-state="connectionState"
        :connection-url="connectionUrl"
        :server-info="serverInfo"
        :client-count="clientCount"
        :current-operation="currentOperation"
        :device-name="deviceName"
        :error="lastError"
        :on-reconnect="reconnect"
        :on-disconnect="disconnect"
        :on-reset="resetConnection"
        :on-open-settings="openConnectionSettings"
      />
      <div
        class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-5"
      >
        <InputComposer
          :connection-state="connectionState"
          :is-busy="isBusy"
          :on-send="sendInput"
          :on-send-key="sendKey"
        />
        <InputHistory
          :history="history"
          :can-resend="connectionState === 'ready' && !isBusy"
          :on-resend="sendInput"
          :on-clear="clearHistory"
        />
      </div>
      <BookmarkletInstaller />
    </section>

    <ConnectionDialog
      :open="showConnectionDialog"
      :current-method="connectionMethod"
      :current-url="webSocketUrl"
      :has-connection-config="hasConnectionConfig"
      :connection-state="connectionState"
      :error="lastError"
      :on-connect="connect"
      :on-close="closeConnectionSettings"
    />
  </main>
</template>
