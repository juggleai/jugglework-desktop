# Task List Derived Access

## Purpose

定义直接分享和清单角色派生的任务读写权限；不反向授予其他清单的权限。

## ADDED Requirements

### Requirement: One task model with independent direct sharing
Tasks SHALL NOT be classified as private or shared types. The system SHALL support direct task sharing without requiring a list. An unshared task SHALL NOT become organization-visible merely because the legacy task type is retired.

#### Scenario: Create a task without sharing it
- **WHEN** a member creates a task without other participants, share grants, or a list that grants other people access
- **THEN** other organization members do not gain access merely by belonging to the organization

#### Scenario: Share a task without sharing its lists
- **WHEN** a member with task-sharing authority grants someone direct read access
- **THEN** the recipient can read the task but does not gain access to its lists or receive identifiers or names of lists they cannot view

### Requirement: Shared lists grant role-based task access
Readers of an enabled list SHALL be able to read its existing and subsequently filed non-deleted tasks. Editors and owners SHALL additionally be able to edit content, dates and assignees, and complete or reopen tasks subject to the existing per-assignee completion policy. The grant SHALL NOT confer task-sharing management, deletion, restoration, or access to other lists. Sharing an enabled list SHALL NOT be blocked by a legacy task visibility value.

#### Scenario: Invite a collaborator to an existing list
- **WHEN** an authorized list manager shares a list containing tasks previously labeled private
- **THEN** the collaborator can read those tasks without a separate task share, and their direct task permissions remain unchanged

#### Scenario: Access later filings according to list role
- **WHEN** a task is filed in an enabled list with a reader and an editor, neither of whom has a direct task role
- **THEN** both can read it, only the editor can edit, assign or mark an ordinary task complete, and neither can manage task sharing, delete or restore it based on the list grant alone

### Requirement: Confirm read or edit audience expansion
The system SHALL require task and destination-list edit permission and task-sharing authority to add a task to an enabled list. It SHALL confirm a filing to a list with other recipients or a list change that widens read or edit access. Read-only access SHALL NOT allow re-sharing via a list, during filing or later.

#### Scenario: Cancel adding a task to a shared list
- **WHEN** the user declines confirmation of a filing that would grant new access
- **THEN** neither the filing nor the resulting access is created

#### Scenario: Task read alone cannot be used to gain edit access
- **WHEN** a task viewer attempts to add it to an enabled list they own
- **THEN** the filing is denied even if the viewer is the only member of that list

#### Scenario: Filing first does not authorize sharing later
- **WHEN** a list manager tries to widen the audience of a list containing a task they cannot share with the new audience
- **THEN** the list audience remains unchanged until the affected share is authorized or the filing is removed; the system does not silently hide selected tasks after a successful share

### Requirement: Union and revocation of independent sources
Task read and edit access SHALL each be the union of valid direct grants and the corresponding grants from linked lists within the current organization. Removing or downgrading a collaborator, narrowing a list audience, removing a filing, or deleting a list SHALL revoke only the affected grant. Archiving a list alone SHALL NOT revoke access.

#### Scenario: Remove access through one of two lists
- **WHEN** a task is in lists A and B and the member loses access through A
- **THEN** a grant through B or through direct task sharing still allows the member to read the single original task
- **AND** the member cannot discover list A through the task if A is no longer visible to them

#### Scenario: Downgrade the last edit source
- **WHEN** the member loses their last task edit grant but remains a reader via another source
- **THEN** the task remains readable but no task update or old mutation replay can be authorized by the revoked role

#### Scenario: Lose the last access source
- **WHEN** a member no longer has any task read grant
- **THEN** server reads, searches, activity and direct links no longer disclose the task, and Desktop discards affected cached results on authorization refresh

### Requirement: Review legacy audience changes before activation
The rollout SHALL preserve existing task identity, list filings and direct access. Existing lists SHALL remain on legacy authorization until read and edit audience changes are explicitly reviewed and authorized.

#### Scenario: Upgrade a list previously used only for classification
- **WHEN** a legacy list already contains tasks that its collaborators could not read before the change
- **THEN** rollout does not silently expose those tasks, and authorized activation applies the new rule consistently to the whole list
