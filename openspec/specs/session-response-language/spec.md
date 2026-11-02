# Session response language

## Purpose
Keep replies aligned with genuine user prose across mixed-language requests and internal continuations.

## Requirements

### Requirement: Mixed-language user prose
Explicit response-language requests SHALL take precedence. Borrowed English task words and repository identifiers SHALL NOT alone override surrounding Chinese prose. Quoted text, code, URLs, paths, and generated capability content SHALL NOT determine the response language. English sentences containing short Chinese labels SHALL remain distinguishable from Chinese requests containing English task verbs.

#### Scenario: Chinese review request
- **WHEN** the user submits `review下imserver-console的这些本地改动，上线是否会有兼容问题`
- **THEN** the selected response language is Simplified Chinese
- **AND** adding an explicit request to answer in English selects English

### Requirement: Internal text cannot change language
Submission language selection SHALL exclude text marked `synthetic: true`, `ignored: true`, or `metadata.compaction_continue: true`. A user role alone SHALL NOT establish genuine authorship. For mixed submissions, only genuine prose may determine a new language; for internal-only submissions, existing language SHALL be retained without creating a default preference. Ordinary attachment-only submissions SHALL retain their existing locale-fallback behavior.

#### Scenario: English internal continuation
- **WHEN** a Chinese session receives marked internal English continuation text with an English detected-language signal
- **THEN** neither ordinary start nor busy steer changes the stored Chinese preference
- **AND** an ordinary start injects the retained language when available

#### Scenario: Genuine language change
- **WHEN** the user subsequently submits genuine English prose
- **THEN** the session may select English
- **AND** failed admission rolls back the attempted language mutation

### Requirement: Compaction does not authorize a language change
The runtime system transform SHALL reassert the stored language when available. Language claims inside summaries and internal user-role continuation prompts SHALL NOT be treated as new user instructions. Remote pending requests SHALL reject unsupported provenance metadata before flattening text rather than silently discard it.

## Verification boundaries
Route tests use a mock engine and plugin tests exercise the system-transform boundary. They do not establish that a real engine ran compaction or that every model will comply. Unmarked internal text cannot reliably be distinguished from genuine prose by content alone; producers must preserve provenance. No fixed continuation-text blacklist is used. Language lookup remains best effort, and no historical session state is migrated automatically.
