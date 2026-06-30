export { connect } from "./bluetooth";
export { RemoteInputDevice } from "./device";
export { RemoteInputError } from "./errors";
export type { RemoteInputStatus } from "./types";

import { connect } from "./bluetooth";
import { RemoteInputDevice } from "./device";
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
  RemoteInputError,
  RemoteInputDevice,
  _internals,
};
