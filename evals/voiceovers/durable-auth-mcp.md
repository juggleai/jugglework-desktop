# durable-auth-mcp — Sign in once and stay connected

1. Maya signs into JuggleWork and connects a shared MCP. She completes the provider's consent once, and the connection shows Ready.

2. More than seven days of normal desktop and MCP use pass. Maya opens JuggleWork and continues working without being sent through sign-in again, because active sessions renew quietly in the background.

3. The MCP access token expires and the agent engine restarts. JuggleWork silently uses the stored refresh grant and returns the connection to Ready—without opening a browser, consent screen, security check, or engine-reload prompt.

4. JuggleWork Cloud temporarily becomes unreachable. Maya's local work remains available and JuggleWork shows that it is reconnecting; it does not erase her session or redirect her to sign-in. When service returns, the account state recovers automatically.

5. Later, Maya adds another shared MCP after her JuggleWork sign-in is more than fifteen minutes old. JuggleWork does not insert a redundant identity check before the provider's consent flow, so one provider sign-in completes setup.

6. Maya attempts a genuinely sensitive action, such as transferring ownership, rotating an API key, or changing SSO. JuggleWork asks her to confirm her identity once and automatically resumes the pending action.

7. When Maya explicitly signs out, an administrator removes her membership, or credentials are revoked, her JuggleWork sessions and MCP access stop immediately.

8. An MCP client connected before this update asks for offline access so it can refresh quietly. JuggleWork upgrades that client's refresh permission and shows workspace authorization instead of returning an invalid-scope error.
