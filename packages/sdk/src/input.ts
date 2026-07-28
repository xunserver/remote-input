import type { JsonValue } from "@remote-input/protocol";

export const inputStatusMethod = "inputStatus";

export type InputControl = {
  paste: boolean;
  restoreClipboard: boolean;
};

export type SendTextOptions = Partial<InputControl> & {
  operationId?: string;
};

export type InputCommand = {
  operationId?: string;
  text: string;
  control: InputControl;
};

export type InputStatusStage =
  | "queued"
  | "processing"
  | "copied"
  | "pasted"
  | "clipboard_restored"
  | "succeeded"
  | "failed";

export type InputStatus = {
  operationId: string;
  stage: InputStatusStage;
  progress: number;
  message: string;
};

export type InputStatusListener = (status: InputStatus) => void;

export function createSendTextPayload(
  text: string,
  options: SendTextOptions = {},
): JsonValue {
  return {
    text,
    ...(options.operationId === undefined
      ? {}
      : { operationId: options.operationId }),
    control: {
      paste: options.paste ?? true,
      restoreClipboard: options.restoreClipboard ?? false,
    },
  };
}

export function parseInputCommand(payload: JsonValue): InputCommand {
  if (
    !isRecord(payload) ||
    typeof payload.text !== "string" ||
    Object.keys(payload).some(
      (key) => key !== "text" && key !== "operationId" && key !== "control",
    )
  ) {
    throw new TypeError("sendText payload must contain a string text field.");
  }
  const operationId = payload.operationId;
  if (
    operationId !== undefined &&
    (typeof operationId !== "string" || operationId.length === 0)
  ) {
    throw new TypeError("sendText operationId must be a non-empty string.");
  }
  const control = payload.control;
  if (
    control !== undefined &&
    (
      !isRecord(control) ||
      Object.keys(control).some(
        (key) => key !== "paste" && key !== "restoreClipboard",
      ) ||
      (control.paste !== undefined && typeof control.paste !== "boolean") ||
      (
        control.restoreClipboard !== undefined &&
        typeof control.restoreClipboard !== "boolean"
      )
    )
  ) {
    throw new TypeError("sendText control fields must be boolean.");
  }
  return {
    text: payload.text,
    ...(operationId === undefined ? {} : { operationId }),
    control: {
      paste: control?.paste === false ? false : true,
      restoreClipboard: control?.restoreClipboard === true,
    },
  };
}

export function parseInputStatus(payload: JsonValue): InputStatus {
  if (
    !isRecord(payload) ||
    typeof payload.operationId !== "string" ||
    payload.operationId.length === 0 ||
    !isInputStatusStage(payload.stage) ||
    typeof payload.progress !== "number" ||
    !Number.isFinite(payload.progress) ||
    payload.progress < 0 ||
    payload.progress > 100 ||
    typeof payload.message !== "string"
  ) {
    throw new TypeError("inputStatus payload is invalid.");
  }
  return {
    operationId: payload.operationId,
    stage: payload.stage,
    progress: payload.progress,
    message: payload.message,
  };
}

function isInputStatusStage(value: unknown): value is InputStatusStage {
  return (
    value === "queued" ||
    value === "processing" ||
    value === "copied" ||
    value === "pasted" ||
    value === "clipboard_restored" ||
    value === "succeeded" ||
    value === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
