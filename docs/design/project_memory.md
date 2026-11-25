# Project memory (implemented)

Status: implemented. Supersedes the earlier per-project schema and per-model table plan.

## Decision

One encrypted `memory.db` beside `harness.db`, opened at startup with the same passphrase. Memory content is one `entries` table keyed by project name. A `projects` catalog holds the name and the goal. `meta` stores the selection. There is no per-project DDL and no completion flag.

Per-project schemas were rejected. The first session cannot know the right columns, SQLite migrations are painful, and the memory tab needs a stable reader. Project-shaped detail lives in note titles, tags, and warm keys instead.

A plaintext `memory.json` was also rejected. It would sit outside the SQLCipher boundary the history file uses. The memory tab renders warm rows as JSON.

## Tiers

- Hot: one short awareness row. Inserted once at session start, beside the system prompt, only when `project_mem` is enabled. Not rewritten during the run, so the prefix cache holds. The next session inserts the updated block.
- Warm: longer thoughts. The hot block lists keys only. Values are recalled with the tool.
- Cold: verbose notes in the same table. The history transcript remains the other cold bank. HID recall stays a person action. The model may cite a HID in a note; it cannot fetch one.

Edits during a run are visible because the tool call and its short acknowledgement stay in that run's messages. Continue, Compact, and the provider copy omit `project_mem` actions. History keeps them.

## Tool and UI

`project_mem` is off until a project is selected. Turning it on starts at Allow all. The project is chosen in the UI, not by a tool argument. Actions: `recall`, `set_hot`, `warm_put`, `note_put`. Empty body deletes.

The memory tab creates projects and shows hot text, warm JSON, and cold notes. Config and tools show a project dropdown immediately before the `project_mem` checkbox.

## Bounds

Hot 3,000 characters. Warm value 8,000, 200 keys. Cold note 16,000, 2,000 notes. Injected block 4,000. Writes that look like a private key, `HARNESS_DB_KEY=`, or a comment-tag marker are refused. Retrieved memory is labeled reference data, not instructions.
