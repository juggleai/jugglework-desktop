# Cloud organization role access

This guide documents the approved cloud organization hierarchy as it exists today.

## Scope

Organization roles authorize access inside one cloud workspace. They are separate from platform admin access: platform admins are allowlisted operators for admin routes and the admin MCP surface, and organization `owner` or `admin` roles do not grant that platform access.

The web console enforces policy in the client by hiding or disabling actions, and the API enforces policy by rejecting unauthorized requests. UI disabling is not security enforcement; route guards and handler checks are the security boundary. Organization LLM providers are an operational Models surface outside Settings.

## Built-in hierarchy

The built-in organization roles are ordered:

1. `owner`
2. `admin`
3. `member`

`owner` satisfies every organization gate. `admin` satisfies every administrative gate except the owner-only operations below. `member` satisfies member gates only.

`super-admin` no longer exists: it was merged into `admin`, which inherited its full permission set. A membership still stored as `super-admin` is read as `admin`, and `super-admin` cannot be used as a custom role name.

Organizations may have multiple `admin` members. Each organization has exactly one protected `owner`; the owner role cannot be assigned through invitations or member role changes, and the owner member cannot be removed.

## Owner-only operations

Three operations stay exclusive to the current `owner`:

- Creating an organization. `POST /v1/org` requires the caller to already hold an active `owner` membership in some organization; anyone else receives `403 organization_owner_required`. A user who owns no organization gets their first one from deployment bootstrap or from an existing owner adding them.
- Deleting the organization.
- Transferring ownership. The target must be an active `admin`. After transfer, the target becomes the sole `owner` and the previous owner becomes an `admin`.

## Web console sidebar

For cloud organization admins (`owner` and `admin`), the sidebar order is:

- Dashboard
- Your Connections, when enabled
- Extensions
  - Marketplace
  - Sources
  - Plugins
  - Connectors
- Models
  - LLM Providers
- Members
- Analytics
- Settings
  - General
  - Diagnostics
  - Brand appearance
  - Desktop Policies
  - Stripe
  - API Keys
  - SSO
  - SCIM

Plain members have member access only: Dashboard, plus Your Connections when that capability is enabled.

## Role matrix

| Access or operation | `owner` | `admin` | `member` |
| --- | --- | --- | --- |
| Member-level workspace access | Yes | Yes | Yes |
| Operational mutation outside Settings | Yes | Yes | No |
| Settings visibility and reads | Yes | Yes | No in the console |
| Settings writes | Yes | Yes | No |
| Member role changes | Yes, except owner | Yes, except owner | No |
| Invitations | Invite assignable non-owner roles | Invite assignable non-owner roles | No |
| Removals | Remove non-owner members | Remove non-owner members | No |
| Custom role management | Yes | Yes | No |
| Organization creation | Yes | No | No |
| Organization deletion | Yes | No | No |
| Ownership transfer | Yes, to active `admin` | No | No |

The owner is the only undeletable member role. Admins and owners share every administrative capability; the difference is limited to creating an organization, deleting it, and transferring ownership.

## Custom roles

Custom roles can add delegated permissions where the API supports them, but they do not replace the built-in hierarchy. Built-in role names are protected, the owner role remains transfer-only, and the highest built-in role in a member's role string controls owner/admin/member gates.
