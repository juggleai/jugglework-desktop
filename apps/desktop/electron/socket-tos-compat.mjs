import { Socket } from "node:net";

const installed = Symbol.for("jugglework.socketTosCompat");

/**
 * 安装可选 QoS 兼容层；被系统拒绝的 IP_TOS 提示不能中断正常写入。
 * @param {object} [prototype] 当前运行时 Socket 原型；旧版 Node 可以不提供 QoS 方法
 */
export function installSocketTosCompat(prototype = Socket.prototype) {
  const target = /** @type {{setTypeOfService?: (...args: any[]) => any, [key: symbol]: unknown}} */ (prototype);
  const original = target.setTypeOfService;
  if (typeof original !== "function" || target[installed]) return false;
  Object.defineProperty(prototype, installed, { value: true });
  target.setTypeOfService = function (...args) {
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
