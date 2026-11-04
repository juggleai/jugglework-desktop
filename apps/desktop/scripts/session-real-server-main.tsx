// Seed only this disposable renderer's normal persistence, then use the actual
// index -> AppProviders -> DenSigninGate -> AppRoot -> SessionRoute entry.
const model = { providerID: "fixture", modelID: "synthetic" };
localStorage.setItem("jugglework.den.authToken", "synthetic-den-session");
localStorage.setItem("jugglework.preferences", JSON.stringify({
  hasCompletedOnboarding: true, analyticsEnabled: false, defaultModel: model,
}));
localStorage.setItem("jugglework.react.activeWorkspace", "smoke-workspace");
localStorage.setItem("jugglework.react.sessionByWorkspace", JSON.stringify({ "smoke-workspace": new URLSearchParams(location.search).get("session") ?? "smoke-session" }));
localStorage.setItem("jugglework.language", "en");
await import("@/index.react");
export {};
