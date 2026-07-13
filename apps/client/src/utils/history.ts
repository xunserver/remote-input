import type { HistoryItem } from "@/types/remote-input";

export const maxHistoryItems = 20;

const historyStorageKey = "remote-copy.input-history";

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as HistoryItem[]).slice(0, maxHistoryItems) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: HistoryItem[]): void {
  localStorage.setItem(historyStorageKey, JSON.stringify(history.slice(0, maxHistoryItems)));
}
