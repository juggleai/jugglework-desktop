# Desktop active-day reporting

## Purpose

Count foreground Desktop activity without collecting input content or treating background work as user activity.

## ADDED Requirements

### Requirement: Report actual foreground interactions
The Desktop SHALL report activity only after a trusted pointer or keyboard interaction in a visible, focused window whose validated signed-in session still matches current settings. It SHALL POST to `/jwork/api/v1/activity/active-day` on that deployment using the business session bearer, without query parameters or a body.

#### Scenario: Interact after sign-in
- **WHEN** the user interacts with the focused Desktop window using a current signed-in session
- **THEN** the Desktop can report activity without sending input contents, an account ID, or a date in the request payload

#### Scenario: Restore the app without interacting
- **WHEN** a session is restored or refreshed in the background, or an input event is synthetic or received in an unfocused or hidden window
- **THEN** the Desktop does not post an activity signal

### Requirement: Throttle reports without disrupting sign-in
The Desktop SHALL suppress concurrent repeats within a window and use successful receipts per deployment, account and UTC day. Receipts SHALL NOT include credentials or input details. Failures SHALL NOT change session state and SHALL be retried only on a later foreground interaction after cooldown, at most three attempts per UTC day per deployment and account within a window.

#### Scenario: Reopen after an acknowledged report
- **WHEN** storage is available and the same account is used again on the same deployment and UTC day
- **THEN** no new report is sent, even after reopening the Desktop

#### Scenario: The deployment does not accept the report
- **WHEN** the request fails, including on a server that does not support the endpoint
- **THEN** the user remains signed in and the Desktop does not schedule a background retry or backfill past days
