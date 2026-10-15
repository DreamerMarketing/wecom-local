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

User-facing model exports use a single compact action sheet: group, owner,
action, deadline and editable status. Detailed evidence, priority, completion
criteria and collection statistics remain in the private review/manifest files;
omitting display columns does not relax validation. Compact filenames preserve
the previously delivered detailed files. Rendering a compact preview after an
older format was sent must preserve the old delivery record and must not
implicitly authorize another send.

Explicitly authorized corrected deliveries use a named revision with separate
output filenames and an independent delivery ledger. Prior artifacts and sent
records are retained. Scheduled runs do not automatically create revisions.
Policy v2 also requires a cited pending-work trigger and a platform basis;
unreadable media and absent completion alone are not pending-work triggers.
Specific user platform corrections take precedence for that item only. These
additional gates still do not replace model semantic review.

Policy v3 defines the displayed owner as the coordinating platform operator,
not necessarily the speaker or the merchant executing a dependency. Model
review prioritizes assignments and accepted commitments, then established
same-group/store/platform operating relationships. Each decision cites local
owner context; unknown roles remain unknown. No real personnel mapping is
embedded in public code or tests. Identity and evidence checks do not by
themselves prove the operator's business responsibility.

Daily exported filenames use platform, action-report label and reporting date,
without a compact-layout label. This filename contract is format `compact-v2`;
previously delivered historical files cannot be silently overwritten during a
format change. Explicit named revisions continue to preserve prior artifacts.

The versioned `docs/daily-action-inclusion-policy.md` distinguishes new pending
operations work from reports, routine merchant lead handling and shared links.
Reviews must declare that policy version and provide eligible intent/scope,
inclusion and platform reasoning, and a per-group/platform task key. Duplicate
keys fail closed so the reviewer merges evidence first. These are model review
gates, not keyword-based semantic classification; valid labels alone cannot
prove that a task deserves inclusion. Zero-task days are valid.

Model availability and Codex scheduling remain dependencies. Schema validation
cannot establish semantic correctness or prove that the model read each message;
the task prompt and evidence-based review remain necessary. Synthetic tests
cover review coverage, evidence grounding, task-specific completion standards
and three-workbook export. No real chat data belongs in the public repository.
