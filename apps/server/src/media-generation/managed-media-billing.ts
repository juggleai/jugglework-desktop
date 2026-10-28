const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Effective imported metadata gates native media, never monetary accounting. */
export function managedMediaBillingReady(model: Record<string, unknown>): boolean {
  const billing = model.managedMediaBilling;
  if (!isRecord(billing) || billing.required !== true) return true;
  return billing.version === 1 && billing.supported === true;
}

export const MANAGED_MEDIA_BILLING_DIAGNOSTIC = "The serving gateway has not enabled managed media billing for this model.";
