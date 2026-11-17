# Change: Simplify the application navigation rail

## Why
The 北数Work distribution needs a shorter left navigation rail. Contacts and Toon Factory are not part of the current product surface, and the remaining More-menu destinations are used often enough that they should be visible without opening the menu.

## What Changes
- Add `CONTACTS_NAVIGATION_ENABLED`, default off, to hide the Contacts rail button. Contacts stays reachable inside the Messages view.
- Add `TOON_FACTORY_NAVIGATION_ENABLED`, default off, to hide the Toon Factory More-menu row and pin action, and to ignore a previously stored Toon Factory pin. The Toon Factory route stays available.
- Pin Tasks, Calendar, and Meetings to the rail by default when the user has never saved a pin choice. A saved choice, including an empty list, always wins.

## Impact
- Affected spec: `app-navigation-rail`
- Affected files: `app-navigation-rail.tsx`, `app-navigation-pins.ts`, and their tests
- Existing users who already changed their pins keep their current rail; no stored data is migrated.
