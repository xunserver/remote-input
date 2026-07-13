# @remote-copy/sdk

Framework-independent client SDK for the remote input protocol.

## Usage

```ts
import { RemoteInputClient, WebSocketTransport } from "@remote-copy/sdk";

const client = new RemoteInputClient({ deviceName: "Browser" });

const unsubscribe = client.subscribe((state) => {
  console.log(state.connectionState, state.serverInfo, state.currentStatus);
});

client.connect(new WebSocketTransport("ws://127.0.0.1:17888/ws"));
client.sendInput("Hello");

unsubscribe();
client.disconnect();
```

## Boundaries

The SDK owns transport lifecycle, protocol messages, connection state, server state, and input progress. It does not depend on React, UI components, local storage, or input history.

Alternative transports implement `InputTransport`. A BLE transport can encode outgoing protocol messages and emit decoded incoming messages without changing the client API.
