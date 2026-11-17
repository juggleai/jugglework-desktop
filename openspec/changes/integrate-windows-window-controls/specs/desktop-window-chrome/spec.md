## ADDED Requirements

### Requirement: Windows system controls share the application toolbar
The Windows desktop main window SHALL render the native minimize, maximize/restore, and close controls within the same vertical chrome as the application top toolbar rather than in a separate title bar.

#### Scenario: Main session window on Windows
- **WHEN** the main desktop window is created on Windows
- **THEN** Electron uses a native title-bar overlay with the same 44-pixel height as the application toolbar
- **AND** the system controls appear at the top-right after the toolbar actions
- **AND** the toolbar reserves the caption-button area so application actions remain visible and clickable

#### Scenario: Native window behavior
- **WHEN** a user invokes minimize, maximize/restore, close, or Windows Snap Layout from the integrated controls
- **THEN** the operating system and Electron handle those controls natively
- **AND** the existing close-to-tray and protected-document close flows remain in effect

#### Scenario: Application theme changes
- **WHEN** the application switches between light and dark themes
- **THEN** the Windows title-bar overlay background and symbol colors update to match the corresponding application chrome

#### Scenario: Other desktop platforms
- **WHEN** the desktop main window runs on macOS or Linux
- **THEN** its existing title-bar and window-decoration behavior remains unchanged

### Requirement: Windows interactive controls stay clickable under the hidden title bar
Because the hidden Windows title bar makes `app-region` effective, the desktop app SHALL mark drag and no-drag regions identically on Windows and macOS.

#### Scenario: Navigation rail on Windows
- **WHEN** a user clicks a navigation rail destination such as Tasks, Plugins, Messages, Calendar, or Meetings on Windows
- **THEN** the click reaches the button instead of starting a window drag

### Requirement: No native hover tooltips on navigation and session rows
Navigation rail buttons and session list rows SHALL NOT expose native `title` tooltips, so Windows does not show a system tooltip on hover. Accessible names SHALL remain available through `aria-label`.

#### Scenario: Hovering on Windows
- **WHEN** a user hovers a navigation rail button or a session row on Windows
- **THEN** only the application's own tooltip, if any, is shown
- **AND** the cloud-docs native view keeps its native title because DOM overlays render beneath it
