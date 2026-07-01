export { connect, connectBle } from "./bluetooth";
export { RemoteInputClient, RemoteInputDevice } from "./device";
export { RemoteInputError } from "./errors";
export type { RemoteInputStatus } from "./types";
export type {
  RemoteInputDisconnectListener,
  RemoteInputStatusListener,
  RemoteInputTransport,
} from "./transport/types";

import { connect, connectBle } from "./bluetooth";
import { RemoteInputClient, RemoteInputDevice } from "./device";
import { RemoteInputError } from "./errors";
import { assertTextSize, constants, createDataFrames, decodeStatusFrame, encodeControlFrame } from "./protocol";

export const _internals = {
  encodeControlFrame,
  createDataFrames,
  decodeStatusFrame,
  assertTextSize,
  constants,
};

export const RemoteInput = {
  connect,
  connectBle,
  RemoteInputError,
  RemoteInputClient,
  RemoteInputDevice,
  _internals,
};
