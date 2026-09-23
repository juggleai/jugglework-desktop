## Purpose

Keep chat error presentation focused while retaining the underlying diagnostic records and truthful execution state for troubleshooting.

## ADDED Requirements

### Requirement: Hide explicit missing-file session error cards

The chat SHALL omit the session error card for an explicitly identified missing-file diagnostic, including any suggested replacement paths, for both live errors and historical error messages. It SHALL preserve underlying records and task state.

#### Scenario: Missing file with suggestions
- **WHEN** a session error begins with File not found and contains suggested alternative paths
- **THEN** neither the red card nor the suggestions are rendered in the chat error surface

#### Scenario: Historical missing-file message
- **WHEN** a historical synthetic session error contains the same missing-file diagnostic
- **THEN** it is omitted from the error-card surface without modifying history

#### Scenario: File-read ENOENT
- **WHEN** a session error reports ENOENT for a filesystem read or metadata operation
- **THEN** its session error card is omitted

### Requirement: Preserve other error presentation

The chat SHALL retain error cards for errors not explicitly classified as missing files.

#### Scenario: Unrelated failure
- **WHEN** a session reports a permission, authentication, model, network, or executable launch failure
- **THEN** its existing error card remains visible

#### Scenario: Diagnostic merely quotes missing-file text
- **WHEN** an unrelated diagnostic only mentions File not found in its body
- **THEN** that phrase does not suppress the error card
