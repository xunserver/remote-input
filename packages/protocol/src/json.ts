export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 在不调用 getter 或 toJSON 的前提下生成与源值脱离的 JSON 快照。
 *
 * 返回快照而非校验后再次读取源值，可避免 Proxy、访问器或后续修改改变
 * JSON.stringify 实际观察到的内容。隐藏属性和数组额外属性会被拒绝，
 * 因此通过校验的值只有一种明确的线上表示。
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

  // 只追踪当前递归路径：拒绝循环引用，但允许同一对象在不同分支重复出现。
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
  // 只接受连续索引和标准 length；稀疏项、额外属性及访问器均会被拒绝。
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    ownKeys.length !== length + 1
  ) {
    return undefined;
  }

  const result: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
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
  // 只接受普通对象或 null 原型对象，排除实例自带的序列化语义。
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
    // 避免 "__proto__" 命中继承的 setter 并修改结果对象的原型。
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  return result;
}
