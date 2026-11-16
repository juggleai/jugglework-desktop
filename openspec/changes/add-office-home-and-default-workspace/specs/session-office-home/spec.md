## ADDED Requirements

### Requirement: Office new-task home
The system SHALL show a centered home on the primary session surface when the session has loaded with no messages and is idle with nothing sending, streaming, preparing, queued, or in error. The home SHALL show the bundled animated Juggle robot above the title "{appName}，来帮你" horizontally centered at about 38% of the content height, and SHALL place one row of office scenario chips, the composer, and a footer with a workspace selector and the permission selector at the bottom of the window. The title SHALL never overlap the chips or composer.

#### Scenario: Empty session shows the home
- **WHEN** the user opens a new task in a workspace
- **THEN** the robot and title are shown centered, with the scenario chips and composer at the bottom
- **AND** the workspace selector and permission selector are shown below the composer
- **AND** the permission selector is not also shown inside the composer

#### Scenario: Short window
- **WHEN** the surface is too short to center the title without reaching the scenario chips
- **THEN** the title is laid out above the chips instead of being centered

#### Scenario: Scenario chip fills a prompt
- **WHEN** the user selects 创作文档, 制作PPT, 分析数据, 深度研究 or 策划方案
- **THEN** the composer draft is replaced with that scenario's prompt template
- **AND** nothing is sent until the user submits

#### Scenario: Scheduled-task chip
- **WHEN** local automations are enabled and the user selects 定时任务
- **THEN** the application opens the scheduled-tasks page
- **AND** the chip is hidden when local automations are disabled

#### Scenario: Switch workspace from the home
- **WHEN** the user picks a different workspace in the workspace selector
- **THEN** a new task opens in that workspace

#### Scenario: Leave the home
- **WHEN** the session has a message or is sending, streaming, preparing, queued or in error
- **THEN** the normal chat layout is shown with the composer docked at the bottom

#### Scenario: No session selected
- **WHEN** a workspace is open with no session selected
- **THEN** the same robot, title, scenario chips, bottom composer and workspace selector are shown instead of the starter cards
- **AND** pressing Enter or the send button creates a task whose draft is the typed text, without sending it
- **AND** selecting a scenario chip creates a task whose draft is that scenario's template, without sending it
- **AND** a "connect a model provider" card is shown below when no model is connected

#### Scenario: Split view
- **WHEN** a session is open in the split-view secondary pane
- **THEN** that pane never shows the home
