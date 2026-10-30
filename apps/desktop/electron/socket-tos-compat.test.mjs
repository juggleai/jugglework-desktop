import assert from "node:assert/strict";
import { test } from "node:test";
import { installSocketTosCompat } from "./socket-tos-compat.mjs";

test("unsupported Node versions are unchanged", () => {
  for (const prototype of [{}, { setTypeOfService: undefined }, { setTypeOfService: null }, { setTypeOfService: 0 }]) {
    const descriptors = Object.getOwnPropertyDescriptors(prototype);
    assert.equal(installSocketTosCompat(prototype), false);
    assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), descriptors);
  }
});

test("QoS EINVAL is best effort and preserves chainability", () => {
  const prototype = {
    setTypeOfService(value) {
      assert.equal(value, 0);
      throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL", syscall: "setTypeOfService" });
    },
  };
  assert.equal(installSocketTosCompat(prototype), true);
  /** @type {typeof prototype} */
  const socket = Object.create(prototype);
  assert.equal(socket.setTypeOfService(0), socket);
  const wrapped = prototype.setTypeOfService;
  assert.equal(installSocketTosCompat(prototype), false);
  assert.equal(prototype.setTypeOfService, wrapped);
});

test("successful calls retain arguments, receiver and return value", () => {
  const prototype = { setTypeOfService(value) { this.value = value; return this; } };
  installSocketTosCompat(prototype);
  /** @type {typeof prototype & { value?: number }} */
  const socket = Object.create(prototype);
  assert.equal(socket.setTypeOfService(32), socket);
  assert.equal(socket.value, 32);
});

test("argument errors and unrelated socket failures remain fatal", () => {
  for (const properties of [
    { code: "ERR_OUT_OF_RANGE" },
    { code: "EINVAL", syscall: "write" },
    { code: "EBADF", syscall: "setTypeOfService" },
  ]) {
    const error = Object.assign(new Error("failure"), properties);
    const prototype = { setTypeOfService() { throw error; } };
    installSocketTosCompat(prototype);
    assert.throws(() => prototype.setTypeOfService(), (thrown) => thrown === error);
  }
});
