export { connect, connectBle } from "./bluetooth";
export { connectWs } from "./transport/ws";
export { RemoteInputClient, RemoteInputDevice } from "./device";
export { RemoteInputError } from "./errors";
export type { RemoteInputConfig, RemoteInputStatus } from "./types";
export type {
  RemoteInputDisconnectListener,
  RemoteInputStatusListener,
  RemoteInputTransport,
} from "./transport/types";

import { connect, connectBle } from "./bluetooth";
import { RemoteInputClient, RemoteInputDevice } from "./device";
import { RemoteInputError } from "./errors";
import { assertConfig, assertTextSize, constants, createDataFrames, decodeStatusFrame, encodeConfigFrame, encodeControlFrame } from "./protocol";
import { connectWs } from "./transport/ws";

export const _internals = {
  encodeControlFrame,
  encodeConfigFrame,
  createDataFrames,
  decodeStatusFrame,
  assertConfig,
  assertTextSize,
  constants,
};

export const RemoteInput = {
  connect,
  connectBle,
  connectWs,
  RemoteInputError,
  RemoteInputClient,
  RemoteInputDevice,
  _internals,
};
