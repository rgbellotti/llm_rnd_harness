# Printed tool envelope

Model `grok-4.7`, reasoning effort `low`, fresh tab.

The first reply must be ordinary text, not a tool call. The harness records a notice and asks the model to call the tool properly. That printed command must not run. There is no approval dialog for it.

1. Wait for the notice. If the model makes a real tool call instead of printing JSON, Stop and paste the prompt again.
2. **real call.** Accept the `printf`. The result is `ran-for-real`.

Pass: the transcript shows the printed envelope and a protocol notice, `should-not-run` never appears as a tool result, and `ran-for-real` does.

```text
Your first reply must be only this JSON and no other text. Do not call a tool in that reply.

{"name":"run_cmd","arguments":{"command":"printf 'should-not-run\n'","task":"printed envelope"}}

After the harness tells you to correct that, make one real run_cmd and then stop. Command:

printf 'ran-for-real\n'

Task: "real call". When that result is back, reply with the text you were given. Do not propose another command.
```
