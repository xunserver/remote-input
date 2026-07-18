import assert from "node:assert/strict";
import test from "node:test";

import {
  isJsonValue,
  snapshotJsonValue,
} from "../dist/json.js";

test("JSON snapshots are detached and preserve valid nested data", () => {
  const shared = { value: "original" };
  const source = {
    array: [1, true, null, shared],
    object: shared,
  };

  const snapshot = snapshotJsonValue(source);
  assert.deepEqual(snapshot, {
    array: [1, true, null, { value: "original" }],
    object: { value: "original" },
  });
  shared.value = "mutated";
  source.array[0] = 99;
  assert.deepEqual(snapshot, {
    array: [1, true, null, { value: "original" }],
    object: { value: "original" },
  });
  assert.equal(isJsonValue(source), true);
});

test("strict JSON validation rejects every unsupported nested value", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse.length = 1;

  for (const value of [
    undefined,
    1n,
    Symbol("value"),
    () => undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    { nested: undefined },
    [undefined],
    cyclic,
    sparse,
    new Date(),
  ]) {
    assert.equal(snapshotJsonValue(value), undefined);
    assert.equal(isJsonValue(value), false);
  }
});

test("accessors, hidden serialization hooks, symbols, and array extras are rejected", () => {
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("must not run");
    },
  });

  const hiddenToJSON = { value: "safe" };
  Object.defineProperty(hiddenToJSON, "toJSON", {
    enumerable: false,
    value() {
      return { value: 1n };
    },
  });

  const hidden = { value: "safe" };
  Object.defineProperty(hidden, "secret", {
    enumerable: false,
    value: "hidden",
  });

  const arrayExtra = ["safe"];
  arrayExtra.extra = "hidden by JSON.stringify";

  const symbolProperty = { value: "safe" };
  symbolProperty[Symbol("secret")] = "hidden";

  for (const value of [
    accessor,
    hiddenToJSON,
    hidden,
    arrayExtra,
    symbolProperty,
  ]) {
    assert.equal(snapshotJsonValue(value), undefined);
  }
});

test("null-prototype objects and __proto__ keys snapshot safely", () => {
  const source = Object.create(null);
  source.__proto__ = { safe: true };
  source.value = "ok";

  const snapshot = snapshotJsonValue(source);
  assert.ok(snapshot);
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  const roundTrip = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(Object.keys(roundTrip), ["__proto__", "value"]);
  assert.deepEqual(roundTrip["__proto__"], { safe: true });
  assert.equal(roundTrip.value, "ok");
});
