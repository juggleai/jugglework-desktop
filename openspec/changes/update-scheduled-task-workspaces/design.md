# Design

- Definitions accept an omitted workspace and an explicit `newChatPerRun` boolean. New drafts default to false. Missing flags in stored legacy definitions retain true semantics, including lifecycle updates and editing.
- Store device-local execution bindings in SQLite migration v6. Task bindings support reuse; run bindings retain each allocated workspace independently of task edits. Changing the selected workspace or conversation policy invalidates the task binding atomically with the definition update.
- Allocate folders only at execution. Electron supplies the OS Documents path through `JUGGLEWORK_AUTOMATION_ROOT`, respecting Windows Known Folder redirection. Root: Documents/JuggleWork/Automations. Headless fallback: home/Documents/JuggleWork/Automations.
- Partition by YYYY-MM-DD in the schedule timezone at execution. Normalize model-generated English summaries to safe lowercase snake_case. Atomic mkdir retries append _2, _3, etc. Reused workspaces stay at their original location across dates.
- Register managed workspaces in the embedded server registry and persist their authorized roots using the existing workspace persistence mechanism. Run records store actual workspace IDs for navigation. Re-registration from a persisted execution binding supports restarts.
- A bounded tool-denied model request generates a user-language title and English directory summary when saving. Delete the transient naming conversation; model errors fall back to the prompt-derived title and a safe directory name. No task execution occurs during setup.
- Temporary session lookup failures do not silently replace conversations. Missing conversations can be recreated in the existing directory. Busy reused conversations reject overlapping dispatch. Files/directories are not removed on task editing.

Validation: backend automation tests, four execution combinations over repeated and cross-day runs, atomic concurrent allocation, naming success/failure cleanup, migration/repository persistence, frontend contracts and TypeScript checks.
