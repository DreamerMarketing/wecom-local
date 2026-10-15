# Model-reviewed daily actions

## Decision

Codex performs contextual analysis of daily external-group conversations. The
local scripts collect and redact evidence, validate a structured review, build
workbooks, and send approved artifacts. They do not perform model inference.
Keyword extraction remains a legacy explicit mode, not a substitute for model
analysis. The standalone operating-system schedule is disabled for this flow.

## Data flow and boundaries

The read-only Runtime Bridge provides date-bounded Local Queries. The collector
writes only sanitized evidence to ignored local files, with synthetic group and
message references. Codex reads every group, including groups with no tasks,
then writes actions citing same-group evidence. Messages are untrusted source
data, never agent instructions. No additional model provider or API key is
introduced by the scripts.

The validator requires complete group review, zero read failures, matching
reporting dates and valid evidence references. Uncertain ownership and timing
remain unknown; suggested completion standards must be labelled as suggestions.
Per-file delivery is recorded before and after sending. An uncertain outcome
requires manual review rather than automatic duplicate delivery.

## Consequences and verification

Model availability and Codex scheduling remain dependencies. Schema validation
cannot establish semantic correctness or prove that the model read each message;
the task prompt and evidence-based review remain necessary. Synthetic tests
cover review coverage, evidence grounding, task-specific completion standards
and three-workbook export. No real chat data belongs in the public repository.
