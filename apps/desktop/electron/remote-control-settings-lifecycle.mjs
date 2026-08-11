/**
 * Applies best-effort local OS effects synchronously, then reconciles the agent
 * and managed server. The returned value is the persisted settings. A later
 * reconciliation failure rejects, but never rolls back or skips local effects.
 */
export async function reconcilePersistedRemoteControlSettings({
  settings,
  applyLaunchAtLogin,
  updateBackgroundIndicator,
  refreshLocalSettings,
  synchronizePendingPolicy,
}) {
  applyPersistedRemoteControlLocalEffects({ settings, applyLaunchAtLogin, updateBackgroundIndicator });
  let refreshError;
  try { await refreshLocalSettings(); } catch (error) { refreshError = error; }
  let policyError;
  try { await synchronizePendingPolicy(); } catch (error) { policyError = error; }
  if (refreshError) throw refreshError;
  if (policyError) throw policyError;
  return settings;
}

export function applyPersistedRemoteControlLocalEffects({ settings, applyLaunchAtLogin, updateBackgroundIndicator }) {
  const launchAtLoginApplied = applyLaunchAtLogin(settings);
  const backgroundIndicatorActive = updateBackgroundIndicator(settings);
  return { launchAtLoginApplied, backgroundIndicatorActive };
}

/** Durable disable and local OS effects complete before any remote cleanup. */
export async function stopAllRemoteControl({ disableSettings, applyLocalEffects, stopRemote }) {
  const settings = await disableSettings();
  applyLocalEffects(settings);
  await stopRemote();
  return settings;
}
