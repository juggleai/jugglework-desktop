import { Socket } from "node:net";

const installed = Symbol.for("jugglework.socketTosCompat");

/** QoS is optional; a rejected IP_TOS hint must not crash Undici's write path. */
export function installSocketTosCompat(prototype = Socket.prototype) {
  const original = prototype.setTypeOfService;
  if (typeof original !== "function" || prototype[installed]) return false;
  Object.defineProperty(prototype, installed, { value: true });
  prototype.setTypeOfService = function (...args) {
    try {
      return Reflect.apply(original, this, args);
    } catch (error) {
      if (error?.code === "EINVAL" && error?.syscall === "setTypeOfService") {
        return this;
      }
      throw error;
    }
  };
  return true;
}

// Imported first by main.mjs, before modules can start native fetch requests.
installSocketTosCompat();
