## Why

Desktop currently always shows Chat and Contacts, even when login or organization switching returns no IM bootstrap because the selected organization has not enabled IM. The cached bootstrap is token-scoped but not organization-scoped, so a previous organization's availability can also appear briefly after switching.

## What Changes

- Treat a complete server-returned IM bootstrap as the capability signal for both Chat and Contacts navigation.
- Hide both entries while authentication or organization capability resolution is incomplete, and when the active organization has no IM bootstrap.
- Bind persisted IM credentials to the active organization so stale credentials cannot expose another organization's navigation.

## Capabilities

### New Capabilities

- `im-navigation-availability`: Current-organization capability gating for Chat and Contacts.
