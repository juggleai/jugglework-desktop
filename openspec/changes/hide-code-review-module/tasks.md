## 1. Implementation
- [x] 1.1 Add the `CODE_REVIEW_ENABLED` build flag, default off.
- [x] 1.2 Gate the More menu entry, pin action, and stored pin on the flag.
- [x] 1.3 Redirect Reviews routes to the last session when the flag is off.

## 2. Verification
- [x] 2.1 Add a navigation test that the module is hidden by default and every entry point is gated.
- [x] 2.2 Run app type checking and the app test suite; failures match the pre-change baseline.
