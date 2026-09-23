## Context

Server catalog v2 adds `lite_team` as the lowest organization tier. Desktop uses closed tier, catalog, billing, and order validators even though purchase selection is now hosted by the Server Console.

## Decisions

- Add the exact `lite_team` wire token only to organization-tier validation.
- Accept both new unpaid Lite Team and historical unpaid Team baselines without rewriting either value.
- Require the complete six-plan catalog and derive its expected size from the tier-kind map.
- Accept Lite Team for existing-tenant and new-organization order targets while retaining all existing amount, state, scope, and payment validation.
- Keep `membership=team` as the broad hosted organization-plan selector; Desktop does not reproduce plan ranks, prices, seat rules, or checkout behavior.

## Risks

- Older servers still return catalog v1 with five plans. Desktop's billing catalog parser is synchronized to the current complete catalog contract; historical order payloads remain independently parseable.
- Legacy unpaid organizations may retain Team. Both Team and Lite Team are accepted only for zero-value unpaid organization billing projections.
