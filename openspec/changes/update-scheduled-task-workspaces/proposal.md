# Scheduled task setup and execution workspaces

Allow scheduled tasks without a selected local workspace. Simplify setup to a prompt and schedule with collapsed advanced settings. New tasks default to reusing their conversation; preserve the fresh-conversation behavior of legacy records.

Approved behavior:

| Selected workspace | New chat per run | Behavior |
| --- | --- | --- |
| No | No | Allocate on first execution; reuse directory and conversation across dates/restarts. |
| No | Yes | Allocate a fresh dated directory and conversation on every run. |
| Yes | No | Reuse a conversation in the selected workspace. |
| Yes | Yes | Create a conversation in the selected workspace without creating subdirectories. |

The advanced section contains optional local workspace selection, new-chat switch, model and supported reasoning variants, and existing additional options. No computer-execution or notification selector is added. Event-triggered tasks retain their required workspace and entity-specific execution semantics.
