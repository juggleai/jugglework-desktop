## ADDED Requirements

### Requirement: Retries release the preceding transport
The managed provider plugin SHALL abort the current attempt's fetch and await reader cancellation before retrying a pre-output timeout. Caller cancellation SHALL prevent retries and consumer cancellation SHALL reach the upstream reader and fetch signal.

#### Scenario: First byte never arrives
- **WHEN** a streaming request exceeds the first-byte deadline
- **THEN** the plugin aborts and releases that attempt before starting another request

### Requirement: Probing preserves streaming output
The plugin SHALL use a single reader, preserve every inspected byte, and return as soon as meaningful text, reasoning, tool-call or uncertain output is detected. It SHALL NOT wait for EOF or replay a request after such output.

#### Scenario: Reasoning precedes text
- **WHEN** metadata is followed by reasoning within the initial output deadline
- **THEN** the original stream is handed off without waiting for EOF or creating another attempt

### Requirement: Initial waits remain bounded and diagnosable
Default response-header and first-byte waits SHALL be 60 seconds and the initial meaningful-output wait after the first byte SHALL be 120 seconds. Existing timeout environment overrides SHALL remain supported. Heartbeats alone SHALL NOT extend that output deadline indefinitely. Exhausted timeouts SHALL identify their phase.

#### Scenario: Heartbeats never produce output
- **WHEN** an upstream emits only metadata or heartbeats beyond the output deadline
- **THEN** the plugin releases the attempt and applies bounded retry policy
