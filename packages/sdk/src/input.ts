import type { JsonValue } from "@remote-input/protocol";

export const inputStatusMethod = "inputStatus";

export const keyboardKeys = [
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
] as const;

export type KeyboardKey = (typeof keyboardKeys)[number];

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

export type KeyCommand = {
  operationId?: string;
  key: KeyboardKey;
};

export type RemoteInputCommand = InputCommand | KeyCommand;

export type InputStatusStage =
  | "queued"
  | "processing"
  | "copied"
  | "pasted"
  | "key_pressed"
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

export function createSendKeyPayload(
  key: KeyboardKey,
  operationId?: string,
): JsonValue {
  if (!isKeyboardKey(key)) {
    throw new TypeError("sendKey requires a supported keyboard key.");
  }
  return {
    key,
    ...(operationId === undefined ? {} : { operationId }),
  };
}

export function parseKeyCommand(payload: JsonValue): KeyCommand {
  if (
    !isRecord(payload) ||
    !isKeyboardKey(payload.key) ||
    Object.keys(payload).some(
      (key) => key !== "key" && key !== "operationId",
    )
  ) {
    throw new TypeError("sendKey payload must contain a supported key.");
  }
  const operationId = payload.operationId;
  if (
    operationId !== undefined &&
    (typeof operationId !== "string" || operationId.length === 0)
  ) {
    throw new TypeError("sendKey operationId must be a non-empty string.");
  }
  return {
    key: payload.key,
    ...(operationId === undefined ? {} : { operationId }),
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
    value === "key_pressed" ||
    value === "clipboard_restored" ||
    value === "succeeded" ||
    value === "failed"
  );
}

export function isKeyboardKey(value: unknown): value is KeyboardKey {
  return typeof value === "string" &&
    (keyboardKeys as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
