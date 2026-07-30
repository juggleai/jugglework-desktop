declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasJuggleWorkModelsAvailable,
  isJuggleWorkModelsPromoEligible,
  isJuggleWorkModelsPromoEligibleForDenBaseUrl,
  shouldShowJuggleWorkModelsPromo,
  wasJuggleWorkModelsStartupPromoShown,
} from "./jugglework-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("JuggleWork Models promo eligibility", () => {
  test("is disabled even for the legacy hosted Den URL", () => {
    expect(isJuggleWorkModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(false);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isJuggleWorkModelsPromoEligible()).toBe(false);
    expect(shouldShowJuggleWorkModelsPromo()).toBe(false);
    expect(wasJuggleWorkModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasJuggleWorkModelsAvailable", () => {
  test("requires a connected jugglework provider with at least one model", () => {
    expect(
      hasJuggleWorkModelsAvailable({
        providerConnectedIds: ["jugglework"],
        providers: [{ id: "jugglework", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasJuggleWorkModelsAvailable({
        providerConnectedIds: ["jugglework"],
        providers: [{ id: "jugglework", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});
