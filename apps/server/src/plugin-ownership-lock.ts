const pluginOwnershipTails = new Map<string, Promise<void>>();

export async function withPluginOwnershipLock<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pluginOwnershipTails.get(pluginId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pluginOwnershipTails.set(pluginId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (pluginOwnershipTails.get(pluginId) === current) pluginOwnershipTails.delete(pluginId);
  }
}
