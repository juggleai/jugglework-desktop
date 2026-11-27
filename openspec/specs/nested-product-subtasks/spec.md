# nested-product-subtasks Specification

## Purpose

TBD - created by archiving change add-nested-product-subtasks. Update Purpose after archive.

## Requirements

### Requirement: Independent nested tasks
The server SHALL support an active, editable same-organization parent at creation. A task editor may later set, replace or detach the parent through a versioned relations command with edit access to affected parents. Nesting SHALL NOT inherit access, filings, assignees, or completion policy. Lifecycle and filing operations SHALL affect only the addressed task.

#### Scenario: Complete and file tasks independently
- **WHEN** a user completes or files a parent or any descendant
- **THEN** the operation changes only the addressed task, subject to its usual permissions and completion rules

#### Scenario: Create another level
- **WHEN** an authorized user creates a child of an existing subtask
- **THEN** the new task has that subtask as its direct parent and is otherwise an independent task

### Requirement: Permission-filtered task hierarchy
The server SHALL paginate visible, nondeleted direct children for an accessible active parent, and only return visible active parent summaries. List and detail SHALL project the visible direct child total and completed count and each task's reply count without exposing inaccessible relationships.

#### Scenario: Parent access changes
- **WHEN** the parent becomes inaccessible, was historically soft-deleted, or is permanently deleted while the subtask remains visible
- **THEN** the visible subtask remains accessible without the parent's identity or title

### Requirement: Desktop hierarchical task list
Desktop List SHALL expand visible child branches by default and allow independent collapse. All tasks, Created by me, Assigned by me, and Completed SHALL offer an outer-subtask visibility setting, defaulting to Show. Assigned to me, Following, and specific task lists SHALL show matching outer subtasks by default. Outer subtasks SHALL link to visible parents. Titles SHALL show direct child progress, attachment counts, and a comment icon and count when comments exist.

#### Scenario: Both parent and child match the current filter
- **WHEN** a user expands a parent while outer subtasks are shown and the child also matches the outer filters
- **THEN** the child is shown under its parent and remains its own root result with a parent link

#### Scenario: Hide outer subtasks
- **WHEN** the user selects Hide in a system task collection
- **THEN** the outer query excludes all subtasks, including those with an unavailable parent
- **AND** the user can still expand visible parents and open their visible children

### Requirement: Desktop subtask details
Task detail SHALL show direct children and progress, open any visible child as its own task, and offer individual completion actions subject to existing authorization. Authorized users SHALL be able to add a subtask inline with an optional due date and assignees.

#### Scenario: Create from detail
- **WHEN** the user submits a nonempty inline subtask draft
- **THEN** the Desktop creates it linked to the current task, shows it in the subtask section, and refreshes progress
- **AND** failed submissions retain the draft for retry

#### Scenario: Creation is discoverable before the first subtask
- **WHEN** the user opens an editable task with no subtasks
- **THEN** the subtask section shows its Add subtask action near the top of detail
- **AND** if the server does not support subtasks, the action is disabled with an explanation and no create request is sent

#### Scenario: Direct subtask progress changes
- **WHEN** at least one direct subtask is visible
- **THEN** the detail shows the completed count out of the total, with a gray track at zero, blue fill for partial completion, and green fill at full completion

#### Scenario: Set the deadline on an inline subtask draft
- **WHEN** an authorized user opens the creation row below the child list
- **THEN** the row provides title entry, a deadline control, and an assignee control inline
- **AND** the deadline control uses the task deadline picker for a date, optional specific time, or clearing the value, without start-date or reminder controls
- **AND** the chosen values are not persisted until the user submits the draft

#### Scenario: Display a selected deadline consistently
- **WHEN** an inline draft or an existing child has a deadline
- **THEN** both rows show a compact localized date, optional time, deadline label, and bell marker beside the assignee control

#### Scenario: Click outside an inline draft
- **WHEN** the user clicks outside a nonempty draft and its date and assignee pickers
- **THEN** Desktop submits that draft once using its current deadline and assignees
- **AND** clicks within the pickers, empty titles, and active text composition do not trigger submission

#### Scenario: Reveal row actions on interaction
- **WHEN** the user hovers or focuses a subtask row
- **THEN** empty editable deadline and assignee controls become visible without hiding filled values
- **AND** an existing child's separate arrow opens its detail

#### Scenario: Edit an existing child inline
- **WHEN** an authorized user changes a child's title and leaves the field, selects or clears its deadline, or edits its assignees
- **THEN** Desktop saves only the intended changes against that child's current authorization and version
- **AND** a failed title save retains the draft, and clearing the deadline does not edit its start date

#### Scenario: Display multiple assignees compactly
- **WHEN** a subtask has two assignees or more
- **THEN** two assignees appear as overlapping avatars, and more than two appear as the first avatar and a count of the remaining assignees

### Requirement: Consistent direct sibling ordering
Desktop SHALL preserve the Server's direct sibling order across pages and surfaces. Untouched siblings SHALL default to addition order, and the task list's sort controls SHALL affect only outer rows.

#### Scenario: Reveal the reorder handle
- **WHEN** the pointer enters a reorderable subtask row or the user focuses its handle with the keyboard
- **THEN** the normally hidden handle becomes visible without moving the other row controls

#### Scenario: Move a subtask relative to a sibling
- **WHEN** an authorized user drags a subtask by its handle or uses the handle's arrow keys
- **THEN** Desktop stores its placement relative to a visible direct sibling and refreshes the detail and expanded branches

#### Scenario: Reordering is not available
- **WHEN** the parent is read-only or the server does not advertise reorder support
- **THEN** Desktop shows no reorder handles and sends no order update

#### Scenario: The order update fails
- **WHEN** the server rejects a subtask move
- **THEN** Desktop shows an error and continues to use the server's order rather than leaving an unsaved reorder in place

#### Scenario: Load more after the order changes
- **WHEN** the server rejects an outdated direct-child cursor
- **THEN** Desktop reloads from the first page instead of merging the obsolete order with the new one
