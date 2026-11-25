# Shell edges

Model `grok-4.7`, reasoning effort `low`, fresh tab.

1. **nonzero.** Accept. The tool text includes `fail this check`. History on this round keeps a non-zero exit code.
2. **sleep.** The dialog shows a 30 second limit. Leave it. Accept. The command finishes in about five seconds.
3. **condense.** Accept. The round is 70 lines, so the live view condenses (the threshold is 60). Expand once and confirm `line 1` and `line 70` are both there.
4. **size cap.** This call prints about 4.5 MB. Prefer Alternate Tool Call with `skipped the size check` unless you want the truncation path. If you accept, the capture ends with the marker `…[tool output truncated:` and the model is billed for that large tool result.

Pass: the short calls are intact, the sleep dialog showed 30s, and the 70-line round condenses.

```text
This is a harness check of run_cmd only. Make the calls one at a time, in this order, and stop when the list is done. Copy each command exactly. Do not use yes, sudo, or bash -lc. Put the bracketed label in the task field. Do not read harness.db, harness-keys, or secret values. When the last result is back, reply with each label and the text you were given. Do not propose another command.

1. [nonzero]
printf 'fail this check\n'; false

2. [sleep]
Set timeout to 30s.
sleep 5

3. [condense]
python3 -c 'print("\n".join("line %s" % i for i in range(1, 71)))'

4. [size cap]
python3 -c 'print("x" * 4500000)'
```
