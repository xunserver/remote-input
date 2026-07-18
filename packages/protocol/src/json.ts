export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Produces a detached JSON snapshot without invoking getters or toJSON hooks.
 *
 * Returning the snapshot (instead of validating and later reading the source
 * again) closes the gap where a Proxy, accessor, or mutation can change what
 * JSON.stringify observes. Hidden properties and array extras are rejected so
 * an accepted value has one unambiguous wire representation.
 */
export function snapshotJsonValue(value: unknown): JsonValue | undefined {
  try {
    return snapshot(value, new WeakSet<object>());
  } catch {
    return undefined;
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  return snapshotJsonValue(value) !== undefined;
}

function snapshot(
  value: unknown,
  ancestors: WeakSet<object>,
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "object" || ancestors.has(value)) {
    return undefined;
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? snapshotArray(value, ancestors)
      : snapshotObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotArray(
  value: unknown[],
  ancestors: WeakSet<object>,
): JsonValue[] | undefined {
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    ownKeys.length !== lengthDescriptor.value + 1
  ) {
    return undefined;
  }

  const result: JsonValue[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key) {
      return undefined;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    const child = snapshot(descriptor.value, ancestors);
    if (child === undefined) {
      return undefined;
    }
    result.push(child);
  }

  return ownKeys.at(-1) === "length" ? result : undefined;
}

function snapshotObject(
  value: object,
  ancestors: WeakSet<object>,
): { [key: string]: JsonValue } | undefined {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }

  const result: { [key: string]: JsonValue } = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    const child = snapshot(descriptor.value, ancestors);
    if (child === undefined) {
      return undefined;
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  return result;
}
