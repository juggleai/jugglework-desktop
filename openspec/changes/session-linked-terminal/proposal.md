# Session-linked local terminal

## Why

The existing terminal accepts a renderer cwd, falls back to home on invalid paths, and kills its shell when hidden. Session-local interactive work needs a host-validated directory and a lifecycle independent of the view.

## Changes

- Resolve local workspace/session directories through the managed runtime, reject remote or unproven bindings, and validate the main-frame IPC caller.
- Retain one bounded terminal per owner/workspace/session and replay buffered output on reopen.
- Add a theme-aware terminal dock and a Lucide toolbar entry. Per the final UI request, the 28px header contains only `Terminal` and a hide icon, not directory metadata or terminate/restart buttons.
- Include manager, resolver, native PTY, frontend state and theme tests.

## Scope and remaining limitations

Only session directories whose realpath equals the trusted workspace root are supported. External terminals, remote PTYs, agent input affordances and worktree ownership are out of scope. Full process-tree cleanup and packaged cross-platform verification remain outstanding.

The bridge supports restart/terminate but the final minimal dock does not expose them. An exited entry is currently reused on reopen, and hidden live terminals count toward the 16-entry limit. Follow-up lifecycle UX is needed without restoring the removed header buttons. The view retains its initial binding when focus changes; the simplified title does not display that binding. These are known limitations, not completed acceptance criteria.
