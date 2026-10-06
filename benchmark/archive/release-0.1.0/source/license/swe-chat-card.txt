---
license: odc-by
task_categories:
  - text-generation
language:
  - en
  - ja
  - zh
  - ko
  - ru
  - pt
tags:
  - code
  - agent
  - traces
  - human-ai-collaboration
  - agent-traces
  - coding-agent
  - coding-sessions
pretty_name: SWE-chat
size_categories:
  - 10M<n<100M
configs:
  - config_name: conversations
    data_files:
      - split: train
        path: conversations.parquet
  - config_name: sessions
    data_files:
      - split: train
        path: sessions.parquet
  - config_name: session_logs
    data_files:
      - split: train
        path: session_logs.parquet
  - config_name: checkpoints
    data_files:
      - split: train
        path: checkpoints.parquet
  - config_name: commits
    data_files:
      - split: train
        path: commits.parquet
  - config_name: repositories
    data_files:
      - split: train
        path: repositories.parquet
  - config_name: subagent_tasks
    data_files:
      - split: train
        path: subagent_tasks.parquet
  - config_name: conversations_subagents
    data_files:
      - split: train
        path: conversations_subagents.parquet
  - config_name: skill_definitions
    data_files:
      - split: train
        path: skill_definitions.parquet
  - config_name: skill_invocations
    data_files:
      - split: train
        path: skill_invocations.parquet
  - config_name: context_events
    data_files:
      - split: train
        path: context_events.parquet
---

# SWE-chat: Coding Agent Interactions From Real Users in the Wild

- 📄 **COLM 2026 Paper:** [arxiv.org/abs/2604.20779](https://arxiv.org/abs/2604.20779v2)
- 🌐 **Website:** [swe-chat.com](https://www.swe-chat.com/)

## Dataset Summary

SWE-chat captures **real-world AI coding sessions** from developers using AI coding assistants (Claude Code, Codex, Gemini CLI, and others via the [Entire.io](https://entire.io) CLI). Each session includes the full conversation transcript, tool calls, thinking traces, code changes, and attribution of human vs. agent-authored code.

### Dataset Size

| Table | Rows |
|---|---|
| `repositories` | 707 |
| `checkpoints` | 54,918 |
| `sessions` | 17,968 |
| `session_logs` | 17,968 |
| `commits` | 62,333 |
| `conversations` | 11,607,572 (229,909 user prompts) |
| `subagent_tasks` | 546 |
| `conversations_subagents` | 8,673 |
| `skill_definitions` | 3,523 |
| `skill_invocations` | 12,243 |
| `context_events` | 80,958 |
| `transcripts/*` (raw log files) | 17,819 |
| `transcripts_compact/*` (compacted log files) | 3,760 |
| `transcripts_subagent/*` (raw subagent log files) | 83 |


### Tables

| Table | Description | Key |
|---|---|---|
| **conversations** | All transcript entries: user prompts, assistant responses, thinking, tool calls, tool results, metadata events | `turn_id` |
| **sessions** | One row per coding session with metadata, token usage, and attribution | `session_id` |
| **session_logs** | Per-session transcript pointer (`transcript_path`) plus auxiliary text fields | `session_id` |
| **checkpoints** | Checkpoint snapshots linking sessions to commits | `checkpoint_pk` |
| **commits** | Checkpoint-to-commit associations with diffs and attribution | (`checkpoint_pk`, `commit_sha`) |
| **repositories** | Repository metadata, settings, and GitHub API enrichment | `repo_id` |
| **subagent_tasks** | Captured subagent task records | `task_pk` |
| **conversations_subagents** | Turns from subagent transcripts, kept separate from `conversations` | `turn_pk` |
| **skill_definitions** | Distinct observed skill bodies and unresolved definition stubs | `definition_id` |
| **skill_invocations** | Explicit and inferred skill-use signals with execution scope and invoker | `invocation_id` |
| **context_events** | Instruction files, slash commands, plugins, reviews, and harness context | `context_event_id` |

## Loading the Data

```python
from datasets import load_dataset

# Load individual tables (each table is exposed as a named config)
conversations = load_dataset("SALT-NLP/SWE-chat", "conversations", split="train")
sessions = load_dataset("SALT-NLP/SWE-chat", "sessions", split="train")
commits = load_dataset("SALT-NLP/SWE-chat", "commits", split="train")

# Or load with pandas directly
import pandas as pd
df_conv = pd.read_parquet("conversations.parquet")
df_sessions = pd.read_parquet("sessions.parquet")

# Raw transcripts live under transcripts/{session_id}.jsonl
# session_logs.parquet holds the relative path + auxiliary text fields
# Compacted transcripts: transcripts_compact/{session_id}.jsonl
# Subagent transcripts: transcripts_subagent/{agent_id}__{tool_use_id}.jsonl
df_session_logs = pd.read_parquet("session_logs.parquet")
with open(df_session_logs["transcript_path"].iloc[0]) as f:
    raw_transcript = f.read()
```

### Quick Examples

```python
import pandas as pd

conversations = pd.read_parquet("conversations.parquet")
sessions = pd.read_parquet("sessions.parquet")

# Compact user-assistant conversation (no tool calls/thinking)
conv = conversations[conversations.is_conversational]
print(conv[["conversation_turn_number", "role", "content"]].head(10))

# All user prompts
prompts = conversations[conversations.turn_type == 'user_prompt']
print(prompts[["content", "agent", "language", "prompt_intent", "prompt_pushback"]])


# All tool calls with extracted file paths
tools = conversations[conversations.turn_type == "tool_use"]
print(tools[["tool_name", "file_path", "command"]].head())

# Recorded parent-side subagent calls (inspect JSON arguments for task text).
delegations = conversations.loc[(conversations.turn_type == "tool_use") & (conversations.orchestration_kind == "subagent_spawn")]
print(delegations[["session_id", "turn_id", "tool_name", "tool_input_json"]].head().to_string(index=False))

# Agent thinking traces
thinking = conversations[conversations.turn_type == "assistant_thinking"]
print(thinking[thinking['content']!=''][["content", "agent", "model"]])

# Sessions with high agent-authored code percentage
high_agent = sessions[sessions.agent_percentage > 90]

# Join conversations to sessions for richer context
merged = conversations.merge(
    sessions[["session_id", "repo_id", "agent_percentage"]],
    on="session_id"
)
```

## Dataset Schema

### Relationship Map

```
repositories (1) ───-> (N) checkpoints    [repo_id]
checkpoints (N) ←──-> (M) sessions        [JSON arrays on both sides]
checkpoints (1) ───-> (N) commits          [checkpoint_pk]
sessions (1) ───-> (1) session_logs        [session_id]
sessions (1) ───-> (N) conversations       [session_id]
checkpoints (1) ───-> (N) subagent_tasks   [checkpoint_pk]
subagent_tasks (1) ───-> (N) conversations_subagents  [task_pk]
skill_definitions (1) ───-> (N) skill_invocations     [definition_id]
sessions (1) ───-> (N) skill_invocations/context_events  [session_id, when available]
```

`subagent_tasks.session_id` and `conversations_subagents.session_id` hold the
**parent** session's id, since a subagent runs inside its parent's session. That is why subagent turns live in their own table: keyed on `session_id` they would collide with the parent's rows in `conversations`.

### ID Strategy

| Entity | Primary Key | Format | Globally Unique? |
|---|---|---|---|
| Repository | `repo_id` | `owner/repo` | Yes |
| Checkpoint | `checkpoint_pk` | `{repo_id}#{checkpoint_id}` | Yes |
| Session | `session_id` | UUID from agent | Yes |
| Commit association | (`checkpoint_pk`, `commit_sha`) | checkpoint key + 40-hex SHA | Yes; a SHA may appear under multiple checkpoints |
| Conversation turn | `turn_id` | `{session_id}#{turn_number}` | Yes |
| Subagent task | `task_pk` | `{checkpoint_pk}#{tool_use_id}` | Yes |
| Subagent turn | `turn_pk` | `{task_pk}#{turn_number}` | Yes |
| Skill definition | `definition_id` | stable hash-derived id | Yes |
| Skill invocation | `invocation_id` | stable hash-derived id | Yes |
| Context event | `context_event_id` | stable hash-derived id | Yes |

> `turn_id` is unique within a release, but not stable across releases. `turn_number` is a positional index over all rows, which can change if sessions update across release. Join on `session_id` (stable) rather than `turn_id` when comparing across releases.

---

### 1. `conversations.parquet`

One row per conversation turn (user prompt, assistant response, assistant thinking step, tool call, or metadata event). Filter with `is_conversational=True` for a clean user-assistant dialogue view.

**Two turn columns:**
- `turn_number`: sequential across ALL rows in the session (including tool calls)
- `conversation_turn_number`: sequential ONLY for `is_conversational=True` rows. NULL for tool/thinking rows

| Column | Type | Description |
|---|---|---|
| `turn_id` | string | **PK**. `{session_id}#{turn_number}` |
| `session_id` | string | FK -> sessions |
| `checkpoint_pk` | string | FK -> checkpoints (canonical) |
| `repo_id` | string | FK -> repositories |
| `user_id` | string | Commit author (`sessions.user_id`) |
| `turn_number` | int | 0-based sequential index across ALL rows |
| `conversation_turn_number` | int | Sequential index for conversational rows only. NULL for tool/thinking rows |
| `source_entry_uuid` | string | Native transcript entry/event identifier, when the format provides one. |
| `response_id` | string | Native logical API-response/message identifier shared by content-block rows from the same response. |
| `content_block_index` | int | 0-based block index within the source entry (0 for formats without block structure). |
| `role` | string | `user`, `assistant`, `tool_use`, `tool_result`, or `metadata` |
| `turn_type` | string | `user_prompt`, `system_injected`, `assistant_response`, `assistant_thinking`, `tool_use`, `tool_result`, `summary`, `system_event`, `file_snapshot`, `progress`, `queue_operation` |
| `is_conversational` | bool | True for `user_prompt` and `assistant_response` |
| `content` | string | Prompt text, response text, thinking text, tool input JSON, or result text (truncated to 10KB for tool_result) |
| `model` | string | Model name (e.g. `claude-opus-4-6`). NULL for user/tool_result/metadata rows |
| `timestamp` | timestamp | Entry timestamp |
| `input_tokens` | int | Per-message input tokens from API usage. Carried on the `assistant_response` row; for assistant turns that are *only* tool calls (no text), carried on the first `tool_use` row of that turn so per-turn token/cache columns are complete. NULL/0 elsewhere. |
| `output_tokens` | int | Per-message output tokens (same row placement as `input_tokens`). |
| `cache_creation_input_tokens` | int | Cache-creation tokens from API usage (same row placement as `input_tokens`). |
| `cache_read_input_tokens` | int | Cache-read tokens from API usage (same row placement as `input_tokens`). |
| `is_continuation` | bool | User turn starts with "This session is being continued" |
| `is_first_turn` | bool | First conversational turn in session |
| `word_count` | int | Word count of content |
| `char_count` | int | Character count of content |
| `tool_name` | string | Tool name for tool_use/tool_result rows, e.g.: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, ... |
| `tool_call_id` | string | The tool-call ID linking tool_use to tool_result |
| `file_path` | string | Extracted from file-modifying/reading tool input. |
| `command` | string | Extracted from Bash / run_command / shell / Execute / exec_command tool input |
| `pattern` | string | Extracted from Grep/Glob tool input |
| `tool_input_json` | string (JSON) | Full tool input parameters for tool_use rows |
| `orchestration_kind` | string | For rows that orchestrate other agents (e.g. a `Task`/`Agent` launch), which kind of orchestration it was. NULL for ordinary rows. |
| `category` | string | `Research` / `Action` / `Orchestration` / `Other` for tool rows |
| `bash_category` | string | git / package manager / test-build / file ops / other for Bash/shell tools |
| `queue_op_subtype` | string | For `queue_operation` rows only. One of: `user_prompt_enqueued` (user typed while agent busy), `user_prompt_delivered` (queued message was sent to agent), `user_prompt_discarded` (queued message was removed without delivery), `task_notification` (completed subagent result), `other`. NULL for all other turn types. |
| `agent` | string | Agent name (denormalized from session) |
| `strategy` | string | Strategy (denormalized from session) |
| `language` | string | Detected natural language of the user prompt (populated for `user_prompt` rows only). |
| `prompt_intent` | string | LLM-annotated intent of a user prompt (turn_type=`user_prompt`). One of: `create new code`, `refactor`, `debug`, `understand`, `connect`, `git`, `test`, `other`. NULL for non-prompt rows or unannotated prompts. See paper for more details. |
| `prompt_pushback` | string | LLM-annotated pushback class for a user prompt (turn_type=`user_prompt`). One of: `correction`, `rejection`, `failure_report`, `non_pushback`. NULL for non-prompt rows or unannotated prompts. See paper for more details. |

#### Row types produced from transcript entries

| Source | turn_type | role | is_conversational |
|---|---|---|---|
| User text message | `user_prompt` | `user` | True |
| System-injected user message — any `role: user` event that is harness/system output rather than human-typed prose, except if it is exectud by the user, such as slash-commands or interruptions. | `system_injected` | `user` | False |
| Assistant text blocks | `assistant_response` | `assistant` | True |
| Assistant thinking blocks | `assistant_thinking` | `assistant` | False |
| Assistant tool_use blocks | `tool_use` | `tool_use` | False |
| User tool_result blocks | `tool_result` | `tool_result` | False |
| Session summary entries | `summary` | `metadata` | False |
| System/hook event entries | `system_event` | `metadata` | False |
| File history snapshot entries | `file_snapshot` | `metadata` | False |
| Progress entries (hooks, etc.) | `progress` | `metadata` | False |
| Queue operation entries | `queue_operation` | `metadata` | False |


**Note on `queue_operation` rows:** Claude Code queues messages when the agent is busy. The `queue_op_subtype` column distinguishes: (a) user prompts typed while agent was running (`user_prompt_enqueued`), which may have been delivered (`user_prompt_delivered`) or silently discarded before reaching the agent (`user_prompt_discarded`); and (b) completed subagent results (`task_notification`). The `content` column contains the plain-text prompt or the `<task-notification>` XML payload; it is empty for `dequeue` and `remove` operations.


### 2. `sessions.parquet`

| Column | Type | Description |
|---|---|---|
| `session_id` | string | **PK**. UUID from agent |
| `repo_id` | string | FK -> repositories |
| `owner_id` | string | Repository owner (from `repo_id` split) |
| `user_id` | string | Commit author resolved via GitHub API. |
| `checkpoint_ids` | string (JSON) | All checkpoint_pks referencing this session |
| `canonical_checkpoint_pk` | string | FK -> checkpoints (source for dedup) |
| `agent` | string | e.g. "Claude Code", "Gemini CLI" |
| `strategy` | string | Entire CLI strategy (e.g. "auto", "manual") |
| `branch` | string | Git branch the session was recorded on |
| `created_at` | timestamp | Session creation time |
| `cli_version` | string | Version of the Entire CLI that recorded the session |
| `files_touched` | string (JSON) | List of file paths touched during the session |
| `files_touched_count` | int | Number of files touched |
| `checkpoints_count` | int | Number of checkpoints created during the session |
| `input_tokens` | int | Main-agent input tokens reported by Entire from the agent's native usage metadata. |
| `output_tokens` | int | Main-agent output tokens reported by Entire from native usage metadata. |
| `cache_creation_tokens` | int | Main-agent prompt-cache creation tokens reported by Entire. |
| `cache_read_tokens` | int | Main-agent prompt-cache read tokens reported by Entire. |
| `api_call_count` | int | Main-agent API calls reported by Entire. |
| `agent_lines` | float | Committed lines attributed to the agent by Entire's recorded attribution. |
| `human_added` | float | Human-added lines reported by Entire's attribution. |
| `human_modified` | float | Human-modified lines reported by Entire's attribution. |
| `human_removed` | float | Human-removed lines reported by Entire's attribution. |
| `total_committed` | float | Total committed lines in Entire's attribution record. |
| `agent_percentage` | float | Agent-authored percentage reported by Entire. Interpret with `attribution_metric_version`. |
| `transcript_identifier_at_start` | string | Transcript identifier at the start of the session |
| `transcript_path` | string | Path to the transcript file |
| `tool_call_count` | int | Total tool calls in this session |
| `unique_tools_count` | int | Number of distinct tools used |
| `research_count` | int | Count of research tool calls (Read/Grep/Glob/WebFetch/WebSearch/read_file/grep/glob/list_directory) |
| `action_count` | int | Count of action tool calls (Write/Edit/NotebookEdit/Bash/write_file/edit_file/run_command/etc.) |
| `first_write_position` | int | Position of the first file-modifying tool call. |
| `duration_seconds` | float | Estimated session duration in seconds (from transcript timestamps) |
| `turn_count` | int | Number of conversational turns |
| `prompt_count` | int | Non-continuation user turns |
| `content_hash` | string | SHA256 from content_hash.txt |
| `user_persona` | string | LLM-annotated persona of the session's primary user. One of: `Expert Nitpicker`, `Vague Requester`, `Mind Changer`, `Other`. NULL for unannotated sessions. See paper for more details. |
| `session_success` | string | LLM-annotated session success score (0-100, as a string). NULL for unannotated sessions. See paper for more details. |
| `viewer_url_hf` | string | Link to this session's transcript file in this Hugging Face repo |
| `viewer_url_entireio` | string | Link to view this session in the Entire web viewer |
| `agent_turn_id` | string | The CLI's own turn-correlation id: checkpoints produced by one agent turn share it. Distinct from `conversations.turn_id`. |
| `has_subagent_tokens` | bool | True when Entire reported a separate subagent-usage block. |
| `subagent_input_tokens` | int | Subagent input tokens reported separately by Entire; add to `input_tokens` for combined usage. |
| `subagent_output_tokens` | int | Separately reported subagent output tokens. |
| `subagent_cache_creation_tokens` | int | Separately reported subagent cache-creation tokens. |
| `subagent_cache_read_tokens` | int | Separately reported subagent cache-read tokens. |
| `subagent_api_call_count` | int | Separately reported subagent API calls. |
| `model` | string | LLM the session ran on, e.g. `claude-opus-4-6`. Empty string when the agent did not report one (the field is always written upstream). |
| `kind` | string | Session purpose. Empty for a normal session; otherwise e.g. `agent_review`, `agent_investigate`, `imported`. |
| `compact_transcript_delta_only` | bool | True for a compact transcript written by an old CLI that stored only one checkpoint's delta rather than the whole session. Such a file ships but must **not** be read as a complete session. |
| `checkpoint_transcript_start` | float | Line offset in the raw transcript where this checkpoint's slice begins. Lets you segment a transcript shared by several checkpoints. |
| `context_tokens` | float | Context tokens in use at session end, when the agent reports it. |
| `context_window_size` | float | Context window size, when the agent reports it. |
| `review_skills` | string (JSON) | Review skills that were run. Set only for review-kind sessions. |
| `review_prompt` | string | Prompt used for a review-kind session. |
| `summary_intent` | string | AI-generated summary: what the user wanted to accomplish. |
| `summary_outcome` | string | AI-generated summary: what was achieved. |
| `summary_learnings` | string (JSON) | AI-generated learnings, grouped into `repo`, `code` (`[{path, line, end_line, finding}]`) and `workflow`. |
| `summary_friction` | string (JSON) | AI-generated list of problems encountered. `[]` means none were found; empty string means no summary was generated. |
| `summary_open_items` | string (JSON) | AI-generated list of unfinished work / tech debt. Same empty-vs-`[]` distinction as above. |
| `agent_removed` | float | Committed deletions attributed to the agent. |
| `total_lines_changed` | float | Total committed line changes (adds + modifies + removes). The newer denominator; `total_committed` is the legacy additions-only one. |
| `attribution_metric_version` | float | 2 when `agent_percentage` uses `total_lines_changed`; 0/NULL for the legacy additions-only definition. |
| `attribution_binary_files_changed` | float | Binary files changed, excluded from line counts. |
| `attribution_binary_files_removed` | float | Binary files removed, excluded from line counts. |
| `attribution_type` | string | Attribution variant recorded upstream, when present. |
| `attribution_branch` | string | Branch the attribution was computed against, when present. |
| `prompt_attributions` | string (JSON) | Per-prompt line attribution: `[{checkpoint_number, user_lines_added, user_lines_removed, agent_lines_added, agent_lines_removed, user_added_per_file}]`. `user_added_per_file` keys are file paths. |
| `agents` | string | Additional agent identification recorded by some CLI versions (distinct from `agent`). |
| `commit_tree_hash` | string | Git tree hash the session was recorded against, when present. |
| `steps_count` | float | Step count recorded by some CLI versions. |
| `session_started_at` | string | Session start time, when the agent reports it separately from `created_at`. |
| `session_ended_at` | string | Session end time, when the agent reports it. |

Note: Session token and attribution fields come from metadata recorded by Entire from the agent integration. They are not reconstructed by summing parsed tool calls. By contrast, conversation-row usage is parsed from native transcript usage records, and git diff/history totals are computed locally.

### 2b. `session_logs.parquet`

One row per session. The raw JSONL/JSON transcript is stored as a file under `transcripts/{session_id}.jsonl` (or `.json` for Gemini CLI) and referenced by the `transcript_path` column. Join to `sessions` on `session_id`.

Some sessions additionally have a **compact** transcript under
`transcripts_compact/{session_id}.jsonl` (`compact_transcript_path`). Prefer
`transcripts/` for analysis — it is the agent's own complete record; the compact
form is derived and lossy (no system turns or reasoning, and parallel tool
results may be missing).

| Column | Type | Description |
|---|---|---|
| `session_id` | string | **PK / FK -> sessions** |
| `transcript_path` | string | Path to the session's transcript file under `transcripts/` |
| `compact_transcript_path` | string | Path to the CLI's compact transcript under `transcripts_compact/`, when one exists. A normalised, agent-agnostic rendering of the same session: user/assistant turns with tool calls inlined, but no system turns or reasoning. Empty when the session has none. |
| `context_md` | string | Full content of `context.md` |
| `session_metadata_raw` | string (JSON) | Raw `metadata.json` content |

### 3. `checkpoints.parquet`

| Column | Type | Description |
|---|---|---|
| `checkpoint_pk` | string | **PK**. `{repo_id}#{checkpoint_id}` |
| `checkpoint_id` | string | Checkpoint id: 12-char hex, or a 26-char ULID for newer CLI versions (see `checkpoint_id_format`) |
| `repo_id` | string | FK -> repositories |
| `session_pks` | string (JSON) | FK list -> sessions |
| `session_count` | int | Number of sessions in this checkpoint |
| `commit_shas` | string (JSON) | FK list -> commits |
| `commit_count` | int | Number of commits in this checkpoint |
| `commit_link_status` | string | Commit-trailer resolution result: `linked`, `not_found`, `search_failed`, or `not_searched`. `not_found` means no linking commit was reachable in the successfully fetched code/PR history; it does not mean the checkpoint made no code changes. |
| `author_user_ids` | string (JSON) | Unique user_ids of commit authors |
| `unique_author_count` | float | Number of distinct commit authors |
| `user_id` | string | Set when checkpoint has a single author. |
| `cli_version` | string | Version of the Entire CLI |
| `strategy` | string | Entire CLI strategy |
| `branch` | string | Git branch |
| `checkpoints_count` | int | From metadata: total checkpoints in the session |
| `files_touched` | string (JSON) | List of file paths touched |
| `files_touched_count` | int | Number of files touched |
| `cp_input_tokens` | int | Main-agent input tokens aggregated from Entire's native checkpoint metadata. |
| `cp_output_tokens` | int | Main-agent output tokens aggregated from Entire's native checkpoint metadata. |
| `cp_cache_creation_tokens` | int | Main-agent cache-creation tokens aggregated from Entire metadata. |
| `cp_cache_read_tokens` | int | Main-agent cache-read tokens aggregated from Entire metadata. |
| `cp_api_call_count` | int | Main-agent API calls aggregated from Entire metadata. |
| `cp_has_subagent_tokens` | bool | True when Entire reported a separate subagent-usage block. |
| `cp_subagent_input_tokens` | int | Separately reported subagent input tokens; add to `cp_input_tokens` for combined usage. |
| `cp_subagent_output_tokens` | int | Separately reported subagent output tokens. |
| `cp_subagent_cache_creation_tokens` | int | Separately reported subagent cache-creation tokens. |
| `cp_subagent_cache_read_tokens` | int | Separately reported subagent cache-read tokens. |
| `cp_subagent_api_call_count` | int | Separately reported subagent API calls. |
| `total_additions` | int | Sum of added lines across commits in this checkpoint |
| `total_deletions` | int | Sum of deleted lines across commits in this checkpoint |
| `checkpoint_backend` | string | Storage backend the checkpoint came from: `git-branch` (one shared branch) or `git-refs` (one git ref per checkpoint). Empty if not recorded. |
| `checkpoint_id_format` | string | `hex` (12-char) or `ulid` (26-char) checkpoint id. |
| `source_repo_id` | string | Repository the checkpoint data was fetched from. Differs from `repo_id` only when the repo keeps its checkpoints in a separate repository. |
| `cp_combined_agent_lines` | float | Checkpoint-level combined agent lines recorded by Entire. |
| `cp_combined_agent_removed` | float | Checkpoint-level combined agent removals recorded by Entire. |
| `cp_combined_human_added` | float | Checkpoint-level combined human additions recorded by Entire. |
| `cp_combined_human_modified` | float | Checkpoint-level combined human modifications recorded by Entire. |
| `cp_combined_human_removed` | float | Checkpoint-level combined human removals recorded by Entire. |
| `cp_combined_total_committed` | float | Entire's legacy additions-only combined denominator. |
| `cp_combined_total_lines_changed` | float | Entire's combined changed-line denominator. |
| `cp_combined_agent_percentage` | float | Combined agent percentage recorded by Entire (0-100). |
| `cp_combined_metric_version` | float | 2 when the percentage uses `total_lines_changed`; 0/NULL for the legacy definition. |
| `imported` | bool | True when the checkpoint was imported from pre-existing agent history rather than recorded live (read-only, commit-less). |
| `has_review` | bool | True when at least one session in this checkpoint was a review session. |
| `has_investigation` | bool | True when at least one session was an investigation session. |
| `checkpoint_version` | string | Upstream storage-format marker, e.g. `branch-v1`. |
| `migration_source_commit` | string | Set when the checkpoint was moved between storage backends by the CLI's migration tool; the commit it came from. |
| `cp_commit_tree_hash` | string | Git tree hash recorded with the checkpoint, when present. |
| `imported_commit_sha` | string | For imported checkpoints only: the commit they were anchored to. **Not** a foreign key into `commits`. |
| `session_file_paths` | string (JSON) | The checkpoint's `sessions[]` pointer array as written upstream: per-session paths to `metadata`, `prompt`, `transcript`, `content_hash`, `context`, and `compact_transcript`. |
| `checkpoint_metadata_raw` | string (JSON) | Raw metadata.json |

### 4. `commits.parquet`

| Column | Type | Description |
|---|---|---|
| `commit_sha` | string | Git commit SHA. Rows are checkpoint-commit associations; the key is (`checkpoint_pk`, `commit_sha`). NULL is retained on legacy-compatible `commit_not_found` sentinel rows. |
| `viewer_url_entireio` | string | Link to view this commit in the Entire web viewer |
| `checkpoint_pk` | string | FK -> checkpoints |
| `repo_id` | string | FK -> repositories |
| `commit_index` | int | 0-based within checkpoint |
| `num_commits` | int | Total commits for this checkpoint |
| `user_id` | string | Canonical user identity: GitHub username if resolved, else email, else author name. |
| `github_username` | string | GitHub username resolved via commit API. |
| `author_name` | string | Git author name |
| `author_email` | string | Git author email |
| `author_date` | timestamp | Git author timestamp |
| `commit_date` | timestamp | Git commit timestamp |
| `commit_message` | string | Commit message |
| `branch` | string | Git branch the commit was observed on |
| `is_agent_author` | bool | Author matches agent patterns |
| `files_changed_count` | int | Number of files touched in this commit |
| `total_additions` | int | Lines added in this commit |
| `total_deletions` | int | Lines removed in this commit |
| `files_changed` | string | Raw git name-status |
| `numstat` | string | Raw git numstat |
| `patch` | string | Full unified diff |
| `agent_changes` | string (JSON) | Agent file-modification tool calls. Each change includes `session_id`, `change_position` (the 0-based file-modification index within that session, not `turn_number`), and `timestamp` when available. |
| `file_attribution` | string (JSON) | Pipeline-computed per-file attribution (`agent_only`, `human_only`, or `mixed`) from matching transcript file-edit tool calls against the linked git diff. |
| `status` | string | `ok`, `commit_not_found`, or `commit_search_failed`. Rows with either non-`ok` status are retained compatibility sentinels and have a NULL `commit_sha`; use `checkpoints.commit_link_status` for checkpoint-level resolution state. |


### 5. `repositories.parquet`

| Column | Type | Description |
|---|---|---|
| `repo_id` | string | **PK**. `owner/repo` |
| `owner_id` | string | Owner part of `repo_id` |
| `name` | string | Short repo name |
| `url` | string | GitHub URL |
| `is_fork` | bool | Whether the repo is a fork on GitHub |
| `settings` | string (JSON) | Raw `settings.json` from the Entire CLI |
| `num_checkpoints` | int | Checkpoints for this repo in the dataset |
| `num_sessions` | int | Sessions for this repo in the dataset |
| `num_commits` | int | Commits for this repo in the dataset |
| `num_contributors_in_dataset` | int | Distinct commit authors for this repo in the dataset |
| `total_additions_in_dataset` | int | Lines added across dataset commits for this repo |
| `total_deletions_in_dataset` | int | Lines removed across dataset commits for this repo |
| `total_repo_commits_ever` | int | Commits reachable in the locally fetched code refs. |
| `total_repo_additions_ever` | int | Additions from local `git log --shortstat` over those refs. NULL when the history scan timed out. |
| `total_repo_deletions_ever` | int | Deletions from the same local history scan. NULL when it timed out. |
| `total_agent_commits_ever` | int | Reachable commits whose author matches the pipeline's agent-author patterns. |
| `total_agent_additions_ever` | int | Additions in those agent-author commits. NULL when the history scan timed out. |
| `total_agent_deletions_ever` | int | Deletions in those agent-author commits. NULL when the history scan timed out. |
| `last_scraped_at` | timestamp | When repo metadata was last scraped |
| `license_type` | string | Usable-license classification from the curated license registry |
| `checkpoints_repo` | string | The separate repository this repo pushes its checkpoints to, when it uses one; empty otherwise. Only code repos get a row here, so a checkpoints-only repository never appears in this table and never contributes a `license_type`. |
| `repo_github_metadata` | string (JSON) | Full GitHub `/repos/{owner}/{repo}` response |
| `repo_type_domain` | string | LLM-annotated repo domain. One of: `application`, `devtools`, `other`. See paper for more details. |
| `repo_type_audience` | string | LLM-annotated repo target audience. One of: `enduser`, `developer`, `researchers`, `education`. See paper for more details. |

### 6. `subagent_tasks.parquet`

Captured subagent task records (non-exhaustive list of delegations). Join to `sessions` on `session_id` — which is the **parent** session's id — or to
`checkpoints` on `checkpoint_pk`.

Older CLI versions recorded only a subagent's identity and its link to the parent session; newer ones also store the subagent's own transcript. Columns that only the newer format supplies are empty for the older rows, and such a task has no rows in `conversations_subagents`.
For broader historical coverage, select `turn_type == "tool_use"` and `orchestration_kind == "subagent_spawn"` from `conversations`.

| Column | Type | Description |
|---|---|---|
| `task_pk` | string | **PK**. `{checkpoint_pk}#{tool_use_id}` |
| `checkpoint_pk` | string | FK -> checkpoints |
| `repo_id` | string | FK -> repositories |
| `source_repo_id` | string | Repository the data was fetched from (see `checkpoints.source_repo_id`) |
| `session_id` | string | FK -> sessions. The **parent** session the subagent ran inside. Empty when it could not be resolved. |
| `session_link` | string | How `session_id` was determined: `checkpoint_json` (stated outright upstream), `single` (the checkpoint held exactly one session), `transcript` (taken from the subagent transcript), or `ambiguous` (several candidates, none provable — `session_id` is then empty). |
| `tool_use_id` | string | Id of the tool call that launched the subagent |
| `agent_id` | string | Subagent identifier |
| `subagent_type` | string | Subagent type, e.g. `general-purpose`. Empty for older records. |
| `task_description` | string | Free-text task the parent gave the subagent. PII-redacted. Empty for older records. |
| `files` | string (JSON) | Files the subagent touched. Empty for older records. |
| `files_count` | int | Number of files touched |
| `started_at` | string | When the subagent launch was observed |
| `completed_at` | string | When the subagent finished. Empty if it was still running when the checkpoint was written. |
| `duration_seconds` | float | `completed_at − started_at`. NULL if either is missing. |
| `in_flight` | bool | True when the subagent had started but not finished — its transcript is a snapshot, not the final one. |
| `transcript_unavailable_reason` | string | Why no transcript was stored, when the CLI could not retrieve one. |
| `transcript_path` | string | Path to the subagent transcript under `transcripts_subagent/`. Empty when none was stored. |
| `transcript_fingerprint` | string | `"{size}:{sha256[:32]}"` of the subagent transcript; changes when the transcript changes. |
| `turn_count` | int | Turns parsed from the subagent transcript (0 when there is none) |
| `tool_call_count` | int | Tool calls parsed from the subagent transcript |

### 7. `conversations_subagents.parquet`

Turns from subagent transcripts. Same idea as `conversations` but for work done
by a subagent, and deliberately a separate table: these rows carry the **parent**
session's `session_id`, so merging them into `conversations` would collide with
the parent's own turns.

Only available subagent transcripts contribute rows here. A child transcript's `user` role can contain instructions supplied by the parent agent or harness.

| Column | Type | Description |
|---|---|---|
| `turn_pk` | string | **PK**. `{task_pk}#{turn_number}` |
| `task_pk` | string | FK -> subagent_tasks |
| `checkpoint_pk` | string | FK -> checkpoints |
| `repo_id` | string | FK -> repositories |
| `session_id` | string | FK -> sessions (the **parent** session) |
| `agent_id` | string | Subagent identifier |
| `turn_number` | int | 0-based index within this subagent's transcript |
| `role` | string | `user`, `assistant`, `tool_use`, `tool_result`, or `metadata` |
| `turn_type` | string | Same vocabulary as `conversations.turn_type` |
| `content` | string | Turn text, tool input, or tool result. PII-redacted for user/assistant turns. |
| `ts` | string | Turn timestamp, when the transcript provides one |
| `input_tokens` | int | Input tokens for this turn, when reported |
| `output_tokens` | int | Output tokens for this turn, when reported |

### 8. `skill_definitions.parquet`

| Column | Description |
|---|---|
| `definition_id` | **PK**. Stable identifier for this definition/body version. |
| `skill_name` | Observed skill name, including a plugin prefix when present. |
| `unqualified_name` | Skill name without its plugin prefix. |
| `agent` | Coding agent associated with the observation. |
| `plugin_name` | Plugin namespace inferred from the qualified name or observed injection. |
| `scope` | Observed definition scope, such as `plugin` or `unknown`. |
| `skill_body` | Captured skill instructions; empty for an unobserved stub. |
| `body_available` | Whether the body was captured. |
| `definition_kind` | `observed_version` or `unobserved_stub`. |
| `definition_source` | Evidence source from which this catalog row was created. |

### 9. `skill_invocations.parquet`

| Column | Description |
|---|---|
| `invocation_id` | **PK**. Stable invocation/event identifier. |
| `definition_id` | FK to `skill_definitions`; may reference an unobserved stub. |
| `skill_name` | Observed skill name, including a plugin prefix when present. |
| `unqualified_name` | Skill name without its plugin prefix. |
| `plugin_name` | Plugin namespace, when present. |
| `repo_id` | FK to `repositories`. |
| `session_id` | Parent/main session identifier. |
| `task_pk` | FK to `subagent_tasks` for a subagent-scoped invocation; empty otherwise. |
| `subagent_id` | Native subagent identifier when available. |
| `execution_scope` | `main` or `subagent`. |
| `agent` | Coding agent associated with the invocation. |
| `invoker` | Actor that invoked the skill: `user`, `agent`, `subagent`, `harness`, or `unknown`. |
| `event_type` | Invocation signal type; use `tool_invocation`, `prompt_invocation`, and `skill_injection` for usage counts. |
| `source` | Native or parsed source of the signal. |
| `source_confidence` | `explicit` or `inferred`. |
| `turn_id` | Source turn identifier when available; not guaranteed to join to released conversations. |
| `tool_call_id` | Source tool-call identifier when available; not guaranteed to join to released conversations. |
| `timestamp` | Invocation timestamp when reported. |
| `transcript_start` | Native transcript start anchor when reported. |
| `transcript_end` | Native transcript end anchor when reported. |
| `native_event_id` | Native skill-event identifier when reported. |
| `source_signal` | Native or inferred signal label. |
| `source_agent` | Agent named by the native source, when present. |
| `native_tool_name` | Native tool name associated with the event. |

### 10. `context_events.parquet`


| Column | Description |
|---|---|
| `context_event_id` | **PK**. Stable event identifier. |
| `repo_id` | FK to `repositories`. |
| `session_id` | Parent/main session identifier when available. |
| `task_pk` | FK to `subagent_tasks` for subagent-scoped context. |
| `subagent_id` | Native subagent identifier when available. |
| `execution_scope` | `main` or `subagent`. |
| `agent` | Coding agent associated with the event. |
| `invoker` | Actor responsible for the event. |
| `event_type` | Context category, such as `harness_injection`, `slash_command`, `instruction_file`, `skill_definition_load`, `plugin_skill_invocation`, or `review_prompt`. |
| `name` | Normalized command, instruction-file, skill, or event name. |
| `plugin_name` | Plugin namespace when applicable. |
| `turn_id` | Source turn identifier when available. |
| `timestamp` | Event timestamp when available. |
| `source` | Extraction source. |
| `source_confidence` | `explicit` or `inferred`. |
| `source_table` | Provenance table; it may be an internal table not shipped in this release. |
| `source_row_id` | Identifier of the source row in `source_table`. |


## Data Collection

### Source

Data is collected from public GitHub repositories that use the [Entire.io](https://entire.io) CLI to checkpoint their AI coding sessions. Checkpoints are stored either on a special branch ()`entire/checkpoints/v1`) or in one ref per checkpoint under `refs/entire/checkpoints/`, containing:

- Session metadata (agent, strategy, token usage, code attribution)
- Full conversation transcripts (JSONL for Claude Code, JSON for Gemini CLI, etc.)
- User prompts and context

### Supported Agents

- Claude Code
- OpenAI Codex
- Gemini CLI
- Cursor
- OpenCode
- GitHub Copilot CLI
- Factory AI Droid
- Pi

### PII Redaction

We redacted personally identifiable information in all user prompts, assistant responses, subagent prose/task descriptions, and released skills using Microsoft Presidio (named-entity detection) and TruffleHog (secret detection).

### Deduplication Strategy

Sessions may appear in multiple checkpoints (a session spans checkpoint boundaries). We deduplicate on `session_id`, keeping the record with the highest `output_tokens` (most complete). The `checkpoint_ids` column preserves the full list of checkpoints each session appeared in.

### Data Removal Requests

If you would like your data removed from SWE-chat, or if you encounter content that is illegal, you may request deletion.
To do so, please contact us via [joachimbaumann@stanford.edu](mailto:joachimbaumann@stanford.edu). Please include **`repo_id`**, **`session_id`**, or **`turn_id`** values corresponding to the entries you wish to remove, and a brief explanation of the reason for removal.

### SWE-chat dataset versions

| Version | Release date | Sessions | User prompts | Release commit |
|---|---|---|---|---|
| v1 | 2026-04-29 | 5,851 | 62,544 | [`f66cca9`](https://huggingface.co/datasets/SALT-NLP/SWE-chat/tree/f66cca95b14caaa4177f7ed5eaa424608dadcffa) |
| v2 | 2026-10-02 | 17,968 | 229,909 | [`df393df`](https://huggingface.co/datasets/SALT-NLP/SWE-chat/tree/df393df57195593d4227aefc31f691f01d4b81a5) |

### Citation

Please consider citing the following papers if you find this dataset useful:

```bibtex
@inproceedings{baumann2026swechat,
  title={SWE-chat: Real-World AI Coding Sessions in the Wild},
  author={Baumann, Joachim and Padmakumar, Vishakh and Li, Xiang and Yang, John and Yang, Diyi and Koyejo, Sanmi},
  booktitle={Third Conference on Language Modeling},
  year={2026},
  url={https://arxiv.org/pdf/2604.20779v2}
}
```
