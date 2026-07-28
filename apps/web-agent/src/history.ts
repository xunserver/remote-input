export const webHidHistoryStorageKey = "remote-input.webhid-history.v1";
export const maxWebHidHistoryItems = 100;

export type WebHidHistoryMessage = {
  id: string;
  receivedAt: string;
  text: string;
};

type HistoryStorage = Pick<Storage, "getItem" | "setItem">;

export function loadWebHidHistory(
  storage: HistoryStorage | undefined = browserStorage(),
): WebHidHistoryMessage[] {
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(
      storage.getItem(webHidHistoryStorageKey) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter(isHistoryMessage)
      .slice(-maxWebHidHistoryItems)
      .map((message) => ({ ...message }));
  } catch {
    return [];
  }
}

export function saveWebHidHistory(
  messages: WebHidHistoryMessage[],
  storage: HistoryStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      webHidHistoryStorageKey,
      JSON.stringify(
        messages.slice(-maxWebHidHistoryItems).map((message) => ({
          id: message.id,
          receivedAt: message.receivedAt,
          text: message.text,
        })),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export function createWebHidHistoryMessage(
  text: string,
  receivedAt = new Date(),
  id = createMessageId(),
): WebHidHistoryMessage {
  return {
    id,
    receivedAt: receivedAt.toISOString(),
    text,
  };
}

function isHistoryMessage(value: unknown): value is WebHidHistoryMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.text === "string" &&
    typeof value.receivedAt === "string" &&
    Number.isFinite(Date.parse(value.receivedAt))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
