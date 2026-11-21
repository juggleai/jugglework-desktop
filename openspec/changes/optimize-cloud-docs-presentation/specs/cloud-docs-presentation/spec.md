## ADDED Requirements

### Requirement: Stable native document visibility

Desktop SHALL keep visited cloud document instances alive across normal navigation and SHALL only show or focus their native view when the owning surface and selected tab are visible. Ordinary navigation hints SHALL NOT replace the document with a snapshot.

#### Scenario: Hover navigation with a hidden retained session
- **WHEN** a cloud document is visible and the user hovers left navigation or a retained session preview
- **THEN** ordinary hints do not hide the document, and the hidden session cannot claim or focus a native document
- **AND** returning to that session reuses its existing document instance

### Requirement: Operable native document occlusion

Desktop SHALL preserve operation of intersecting menus and modal dialogs with a document snapshot or explicit themed fallback. Stale asynchronous results SHALL NOT alter a new active source.

#### Scenario: Snapshot capture fails
- **WHEN** a genuine occluder intersects the document and capture returns no image or fails
- **THEN** Desktop commits a themed placeholder before hiding the native view so the menu remains operable
- **AND** closing the occluder restores the same native instance before releasing the placeholder

### Requirement: Consistent loading without authorization caching

Managed document initialization SHALL use a consistent loading presentation without blocking editor initialization. Office type resolution SHALL share only in-flight requests scoped to context, workspace and document; authorization, collaboration and save flows SHALL remain unchanged.

#### Scenario: Concurrent lookup and context change
- **WHEN** multiple consumers resolve the same document while its request is pending
- **THEN** they share the pending result and release it after settlement
- **AND** a context change rejects old lookups without publishing old results or removing a new context's request
