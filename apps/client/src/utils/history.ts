import type { HistoryItem, OperationState } from "@/types/remote-input";

export const maxHistoryItems = 20;

const historyStorageKey = "remote-copy.input-history";

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(parseHistoryItem)
      .filter((item): item is HistoryItem => item !== null)
      .slice(0, maxHistoryItems);
  } catch {
    return [];
  }
}

export function saveHistory(history: HistoryItem[]): void {
  try {
    localStorage.setItem(
      historyStorageKey,
      JSON.stringify(history.slice(0, maxHistoryItems)),
    );
  } catch {
    // History persistence is optional and must not affect protocol state.
  }
}

function parseHistoryItem(value: unknown): HistoryItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.text !== "string" ||
    typeof item.sentAt !== "string" ||
    typeof item.message !== "string" ||
    typeof item.progress !== "number"
  ) {
    return null;
  }

  const operation = normalizeOperationState(item.status, item.stage);
  if (!operation) {
    return null;
  }

  return {
    id: item.id,
    text: item.text,
    sentAt: item.sentAt,
    status: operation.state,
    stage: operation.stage,
    message: item.message,
    progress: item.progress,
  };
}

function normalizeOperationState(
  status: unknown,
  stage: unknown,
): { state: OperationState; stage: string } | null {
  if (status === "processing" || status === "succeeded" || status === "failed") {
    return {
      state: status,
      stage: typeof stage === "string" ? stage : status,
    };
  }

  if (status === "copying" || status === "pasting") {
    return { state: "processing", stage: status };
  }
  if (status === "done") {
    return { state: "succeeded", stage: "done" };
  }

  return null;
}
