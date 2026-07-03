export { connect, connectBle } from "./bluetooth";
export { connectWs } from "./transport/ws";
export { RemoteInputClient, RemoteInputDevice } from "./device";
export { RemoteInputError } from "./errors";
export type { RemoteInputConfig, RemoteInputStatus } from "./types";
export {
  RIB32_CHUNK_BYTES,
  RIB32_VERSION,
  base32Decode,
  base32Encode,
  crc32,
  createRib32DecoderState,
  formatRib32Frames,
  getRib32LineErrors,
  getRib32Tasks,
  ingestRib32Text,
} from "./base32Frame";
export {
  RemoteInputDecoder,
  createRib32InputDecoder,
} from "./decoder";
export type {
  Rib32DecoderSnapshot,
  Rib32DecoderUpdate,
  Rib32InputDecoderOptions,
} from "./decoder";
export type {
  Rib32DecoderState,
  Rib32TaskStatus,
  Rib32TaskView,
} from "./base32Frame";
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
import { RemoteInputDecoder, createRib32InputDecoder } from "./decoder";
import {
  RIB32_CHUNK_BYTES,
  RIB32_VERSION,
  base32Decode,
  base32Encode,
  crc32,
  createRib32DecoderState,
  formatRib32Frames,
  getRib32LineErrors,
  getRib32Tasks,
  ingestRib32Text,
} from "./base32Frame";

export const _internals = {
  encodeControlFrame,
  encodeConfigFrame,
  createDataFrames,
  decodeStatusFrame,
  assertConfig,
  assertTextSize,
  constants,
  RIB32_VERSION,
  RIB32_CHUNK_BYTES,
  base32Encode,
  base32Decode,
  crc32,
  formatRib32Frames,
  createRib32DecoderState,
  ingestRib32Text,
  getRib32LineErrors,
  getRib32Tasks,
};

export const RemoteInput = {
  connect,
  connectBle,
  connectWs,
  RemoteInputError,
  RemoteInputClient,
  RemoteInputDevice,
  RemoteInputDecoder,
  createRib32InputDecoder,
  _internals,
};
