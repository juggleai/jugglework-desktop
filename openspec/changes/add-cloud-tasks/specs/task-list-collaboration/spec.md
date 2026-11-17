## ADDED Requirements

### Requirement: Task lists
The system SHALL allow organization members to create task lists with a name, description, visual marker, visibility, one owner, administrators, members, and archived state.

#### Scenario: Create private list
- **WHEN** a member creates a list without sharing it
- **THEN** the list is private and the creator becomes its owner and administrator

### Requirement: Task-list collaboration summary
The Desktop SHALL show the first five currently authorized task-list viewers as member avatars in the selected task-list header and SHALL represent any additional viewers with a numeric overflow badge. The avatar group SHALL open collaborator management, while the adjacent Share action SHALL open the add-collaborator flow. A member without `canManageMembers` SHALL receive a read-only collaborator view without mutation controls.

#### Scenario: View collaborators without management permission
- **WHEN** a member can view the list but cannot manage its members
- **THEN** the header and dialog show authorized collaborators but do not expose mutation controls

#### Scenario: More than five collaborators
- **WHEN** a selected task list has more than five authorized viewers
- **THEN** the header shows the first five avatars and a `+N` badge for the remaining viewers

### Requirement: Manage existing task-list collaborators
The collaborator-management dialog SHALL list everyone represented by the current task-list authorization, identify the member referenced by `creatorMemberId` as Owner, and map the persisted `member` and `administrator` roles to Can read and Can edit. A permitted administrator SHALL be able to change those roles or remove a non-owner explicit collaborator, saving all draft changes in one list update when Done is selected. The owner SHALL NOT expose role or removal controls.

#### Scenario: Edit and remove collaborators
- **WHEN** a permitted administrator changes one explicit collaborator to Can edit, removes another, and selects Done
- **THEN** the Desktop submits one latest-version update that preserves the current owner as administrator and applies both changes

### Requirement: Transfer task-list ownership
The system SHALL allow only the current task-list owner to transfer ownership to an existing explicit collaborator through a dedicated optimistic and idempotent operation. The new owner SHALL become an administrator, the previous owner SHALL remain an administrator, and exactly one member SHALL be identified as Owner after the transfer. The Desktop SHALL expose Set as owner only to the current owner and SHALL update the collaborator view from the authoritative result.

#### Scenario: Owner transfers to an existing collaborator
- **WHEN** the current owner selects Set as owner for an existing explicit collaborator using the current list version
- **THEN** the system makes that collaborator the sole owner and an administrator
- **AND** the previous owner remains an administrator with edit access

#### Scenario: Administrator cannot transfer ownership
- **WHEN** an administrator who is not the current owner attempts to transfer ownership
- **THEN** the system rejects the operation and does not change the owner

#### Scenario: Target must already collaborate
- **WHEN** the current owner attempts to transfer ownership to a member who is not an explicit task-list collaborator
- **THEN** the system rejects the operation and does not change list membership

#### Scenario: Target collaboration changes concurrently
- **WHEN** the selected target is no longer an explicit collaborator when the ownership transfer transaction executes
- **THEN** the system rejects the operation without changing the owner, member roles, version, or idempotency receipt

#### Scenario: Owner selects themselves
- **WHEN** the current owner attempts to transfer ownership to themselves
- **THEN** the system rejects the no-op without incrementing the task-list version

### Requirement: Add collaborators from management
The collaborator-management dialog's Add collaborator action SHALL open the existing explicit-search and chip-selection flow. Canceling or completing that flow SHALL return to collaborator management.

#### Scenario: Add from collaborator management
- **WHEN** a permitted administrator selects Add collaborator from the management dialog
- **THEN** the Desktop opens the explicit-search add flow
- **AND** closing or completing that flow returns to collaborator management

### Requirement: Explicit collaborator search and selection
The Share dialog SHALL initially show existing collaborator avatars and a search input without listing the whole member or group directory. It SHALL show matching current-organization members and visible groups only after submission of a non-empty query. Selecting a result SHALL collapse the results and retain that person or group as a removable chip without mutating the list.

#### Scenario: Search before selecting collaborators
- **WHEN** a permitted administrator opens the Share dialog
- **THEN** the Desktop shows existing collaborator avatars and the search input without showing directory results
- **AND** matching results appear only after a non-empty query is submitted with Enter or the search control
- **AND** selecting a result collapses the results and adds a removable chip without mutating the task list

### Requirement: Append collaborators on confirmation
A member with `canManageMembers` SHALL be able to append organization members without removing existing collaborators in this flow. The Desktop SHALL preserve the current owner as administrator and all existing roles, assign the member role to new collaborators, promote private lists to members visibility, and preserve organization visibility.

#### Scenario: Share a private list with people
- **WHEN** a permitted administrator searches, selects one or more organization members as chips, and confirms
- **THEN** the Desktop updates the list using its latest version, preserves all existing collaborators and roles, preserves the current owner as administrator, appends the selected collaborators as members, and promotes private visibility to members

### Requirement: Group collaborator snapshot
The Desktop SHALL wait until confirmation before paging through selected groups, matching their user IDs to current organization members, and appending those organization member IDs. The Task list SHALL persist member IDs rather than a group identity, so later group membership changes SHALL NOT automatically alter task-list authorization.

#### Scenario: Add a group as collaborators
- **WHEN** a permitted administrator selects a visible group as a chip and confirms
- **THEN** the Desktop then expands current group users that map to current organization members and includes them in the explicit list-member update
- **AND** users outside the current organization are ignored

### Requirement: Single list membership
The system SHALL allow a task to belong to at most one task list in MVP.

#### Scenario: Move task between lists
- **WHEN** an authorized member moves a task to a different list
- **THEN** the previous list relationship is replaced and a task event is recorded

### Requirement: List-derived authorization
The system SHALL grant task access from current list membership and SHALL revoke only that derived access when a member leaves the list or the task leaves the list.

#### Scenario: Remove list member
- **WHEN** an administrator removes a list member who has no other task role
- **THEN** that member immediately loses access to member-visible tasks in the list

### Requirement: Private task sharing confirmation
The system SHALL prevent a private task from entering a shared list until an authorized administrator confirms changing the task to members or organization visibility.

#### Scenario: Add private task to shared list
- **WHEN** a user selects a shared list for a private task
- **THEN** the system requires explicit visibility confirmation before moving the task

#### Scenario: Cancel private task sharing
- **WHEN** the user cancels the visibility confirmation
- **THEN** the Desktop sends no move or visibility mutation and preserves the displayed task list

#### Scenario: Authorize and scope a Desktop sharing confirmation
- **WHEN** a private task is moved to a shared list through the Desktop list picker
- **THEN** the Desktop loads current task and destination-list permissions, requires task member/visibility management and destination add-task permission, and explains that confirming changes visibility to members and grants authorized list members access
- **AND** it sends the move with the current task version only after confirmation while the captured deployment, user, organization, and page lifetime remain valid

### Requirement: Archive and restore lists
The system SHALL allow list administrators to archive and restore lists without deleting their tasks.

#### Scenario: Archive list
- **WHEN** an administrator archives a list
- **THEN** the list disappears from default navigation while its tasks and permissions remain intact

### Requirement: Rename a task list
The Desktop SHALL expose Rename task list from the selected-list overflow menu only when the authoritative list capability includes `canEdit`, and SHALL submit the trimmed non-empty name through the existing optimistic and idempotent list update contract.

#### Scenario: Administrator renames a list
- **WHEN** a member with `canEdit` enters a changed non-empty name and confirms
- **THEN** the Desktop updates the list using its current version and refreshes the selected-list title from the authoritative result

### Requirement: Permanently delete an owned task list
The system SHALL allow only the current task-list owner to permanently delete the list through a dedicated optimistic and idempotent operation. The service SHALL determine ownership from the currently locked list record and SHALL preserve successful idempotent replay after the list record no longer exists. The Desktop SHALL expose Delete task list only when the authoritative capability includes `canDelete`.

#### Scenario: Non-owner administrator cannot delete
- **WHEN** an administrator who is not the current owner views the selected-list overflow menu
- **THEN** Rename may be available but Delete task list is not exposed

#### Scenario: Replay a completed list deletion
- **WHEN** the owner repeats the same deletion request with the same idempotency key and payload after the list is gone
- **THEN** the system returns the original successful result without requiring the deleted list record

### Requirement: Atomically handle tasks during list deletion
Deleting a task list SHALL by default retain every task and clear its list relationship in the same transaction that permanently deletes the list. When the owner explicitly selects `deleteUnassignedTasks`, the server SHALL determine current assignee relationships in that transaction, soft-delete active tasks with no assignee using the existing 30-day recovery metadata and reminder cancellation semantics, and retain assigned tasks while clearing their list relationship. The list itself SHALL NOT be recoverable.

#### Scenario: Delete list and retain tasks by default
- **WHEN** the owner confirms deletion without selecting the unassigned-task option
- **THEN** every task is retained, moved out of the list, versioned, and receives a list-change event before the list is permanently deleted

#### Scenario: Delete currently unassigned tasks
- **WHEN** the owner confirms deletion with `deleteUnassignedTasks` selected
- **THEN** tasks with no assignee at transaction time are soft-deleted with a 30-day restore window
- **AND** assigned tasks are retained and moved out of the list
- **AND** the assignee decision does not rely on a Desktop snapshot
