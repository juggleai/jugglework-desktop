## Why

JuggleWork Server now exposes `lite_team` as the lowest organization membership tier and publishes a six-plan `membership-cny-v2` catalog. Desktop currently treats tenant tiers and billing plans as a closed five-value set, so it rejects Lite Team accounts, catalogs, and orders returned by the server.

## What Changes

- Accept `lite_team` as an organization tenant tier throughout Desktop's Den API contracts.
- Parse the six-plan server catalog and Lite Team organization orders while preserving the existing strict financial and tenant-kind validation.
- Show Lite Team's product label in the account menu and keep the existing Owner-only upgrade link to the server-owned team purchase page.
- Update the synchronized billing fixture and focused contract tests.

## Capabilities

### New Capabilities

### Modified Capabilities

- `desktop-membership-navigation`: Desktop recognizes Lite Team accounts and continues routing eligible organization Owners to the server-owned team membership page.

## Impact

The change affects the Desktop Den client contract parser, account-menu tier labels, i18n entries, billing fixtures, and focused unit tests. It does not add a local purchase dialog or change payment handling; the server console remains authoritative for plan selection and Alipay checkout.
