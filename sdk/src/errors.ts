export class RemoteInputError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "RemoteInputError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

export function getErrorName(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  }
  return fallback;
}
