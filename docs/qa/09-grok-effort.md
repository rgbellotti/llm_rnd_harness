# Reasoning effort

Model `grok-4.7`, reasoning effort `low` before Generate. Fresh tab. This is the only session that changes effort, and only for one round.

1. **low round.** Leave the effort control at low. Answer `low-round`. The dialog keeps the cloud warning. The round shows a reasoning trace, and the metrics line matches the low effort.
2. Before the second dialog, set the next-round effort to `medium`.
3. **medium round.** Answer `medium-round`. The metrics line follows the medium effort. The cloud warning stays.
4. After the tab finishes, set the effort back to `low` before any later session.

`xhigh` is not part of this check. On `grok-4.5` the API treats `xhigh` as `high`.

```text
This is a harness check of ask_user only. Make two calls, one at a time, and stop after the second answer. Do not change your own request to ask for a reasoning level. The person at the dialog sets that.

1. [low round]
kind question. title "Effort check".
One question, id "round", text "Which label should be recorded?", options "low-round" (recommended) and "later-round".

2. [medium round]
kind question. title "Effort check again".
One question, id "round", text "Which label should be recorded now?", options "medium-round" (recommended) and "later-round".

When the second answer is back, reply with both answer texts. Do not propose another call.
```
