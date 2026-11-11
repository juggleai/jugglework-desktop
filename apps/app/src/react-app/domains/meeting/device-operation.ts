/** A stuck SDK promise must not hold the UI forever or mutate a later session. */
export function withMeetingDeviceDeadline<T>(
  operation: () => Promise<T>,
  expire: () => void,
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { expire(); }
      catch { /* Always release the awaiting UI even if cleanup reports an error. */ }
      reject(new Error("设备切换超时，已停止本机音视频，请重新加入会议。"));
    }, timeoutMs);
    Promise.resolve().then(operation).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}
