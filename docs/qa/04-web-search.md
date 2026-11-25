# Web search

Model `grok-4.7`, reasoning effort `low`, fresh tab. Needs the web tool (`uv sync --project web_tool` and Playwright Chromium already installed).

1. Accept the search. The review dialog opens on the captured results.
2. Delete one result entry from the text. Leave the other results.
3. Approve & submit content.

Pass: the model's report contains only the results you left in the box. The raw capture stays in the transcript. The condensed history header names the query `example domain documentation`.

```text
This is a harness check of web_search only. Make one call and stop. Do not fetch a page and do not run a shell command.

Call web_search with query "example domain documentation" and max_results 3. The task description, if you have a place for one, is "search review".

When the result is back, reply with the text you were given. Do not propose another call.
```
