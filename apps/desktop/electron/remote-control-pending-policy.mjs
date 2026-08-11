function disabledPolicy() {
  return { enabled: false, steer: false, enqueue: false };
}

/**
 * Serializes the managed-server authorization state. Context is not published
 * to the server until the agent has accepted it. Every context refresh first
 * replaces prior authorization with the disabled policy, so a slow or failed
 * agent synchronization cannot retain stale managed-server authorization.
 */
export function createRemoteControlPendingPolicySynchronizer({ readSettings, postPolicy, normalizeContext }) {
  let context = null;
  let revision = 0;
  let operation = Promise.resolve();

  function enqueue(policyRevision, policyContext) {
    const pending = operation.catch(() => undefined).then(async () => {
      if (policyRevision !== revision) return;
      if (policyContext === null) {
        await postPolicy(disabledPolicy());
        return;
      }
      const settings = await readSettings();
      if (policyRevision !== revision) return;
      const gates = policyContext.featureGates;
      const policyAllowsRemote = policyContext.signedIn === true && policyContext.policyFresh === true &&
        gates.enrollment === true && gates.readOnlyControl === true && gates.sessionMutation === true;
      await postPolicy({
        enabled: policyAllowsRemote && settings.enabled === true,
        steer: policyAllowsRemote && settings.enabled === true && gates.busySessionSteer === true && settings.allowBusySessionSteer === true,
        enqueue: policyAllowsRemote && settings.enabled === true && gates.busySessionEnqueue === true && settings.allowBusySessionEnqueue === true,
      });
    });
    operation = pending;
    return pending;
  }

  function fence() {
    context = null;
    const policyRevision = ++revision;
    return enqueue(policyRevision, null);
  }

  function synchronize() {
    const policyRevision = ++revision;
    return enqueue(policyRevision, context);
  }

  async function syncContext(input, syncAgent) {
    let nextContext;
    try {
      nextContext = normalizeContext(input);
    } catch (validationError) {
      let fencingError;
      try { await fence(); } catch (error) { fencingError = error; }
      let agentError;
      try { await syncAgent(input); } catch (error) { agentError = error; }
      throw fencingError ?? agentError ?? validationError;
    }

    context = null;
    const requestRevision = ++revision;
    try {
      await enqueue(requestRevision, null);
      const status = await syncAgent(input);
      if (requestRevision !== revision) return status;
      context = nextContext;
      await enqueue(requestRevision, context);
      return status;
    } catch (error) {
      if (requestRevision === revision) await fence();
      throw error;
    }
  }

  return Object.freeze({ fence, synchronize, syncContext });
}
