# Cloud organization roles - owner, admin, and member

1. The console sidebar documents the workspace areas clearly: Extensions contains Marketplace, Sources, Plugins, and Connectors; Models contains JuggleWork Models and LLM Providers; Members and Analytics stand alone; Settings contains General, Diagnostics, Brand appearance, Desktop Policies, Stripe, API Keys, SSO, and SCIM.

2. Signed in as an admin, I can change a teammate's role and create or delete custom roles. Admin absorbed the old super-admin role, so there is no longer a tier between admin and owner.

3. Admins are no longer read-only in Settings. The organization name field and the save control are enabled, and the read-only notice that used to tell admins to ask an owner is gone.

4. A plain member sees none of it: the sidebar drops Members, Analytics, and Settings, and direct API calls to create a member, create a role, or change someone's role are all rejected.

5. Creating an organization is the owner's alone. The owner's request is accepted, and the same request from an admin is refused with organization_owner_required.
