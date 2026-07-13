import type { SendInputErrorCode } from "./types.js";

export class SendInputError extends Error {
  constructor(
    readonly code: SendInputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SendInputError";
  }
}
