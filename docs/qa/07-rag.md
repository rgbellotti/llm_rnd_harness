# Corpus search

Model `grok-4.7`, reasoning effort `low`, fresh tab. A corpus tool is registered only when a `*.rag.db` sits in the workspace root and its embedding model is installed. On this checkout the file is `godot_docs.rag.db`, and the tool name is `godot_docs_search` when that file is recognized. If that tool is not in the model's tool list, the model stops. That stop is a pass for this file.

1. **search.** Accept, then Approve & submit content with the text unchanged.
2. **kind.** Accept, then Approve & submit content unchanged.

Pass: both results are chunk text from the corpus, the second call was restricted to `kind` `text`, and `k` is 3. The condensed history header names the query.

```text
This is a harness check of the corpus search tool only. If no tool whose name ends in _search is registered, say so and stop. Do not run a shell command and do not search the web.

Use godot_docs_search when it is registered. Otherwise use the one registered tool whose name ends in _search. Make two calls, in order, then stop.

1. [search]
query "3D editor camera", k 3. Do not set kind.

2. [kind]
query "3D editor camera", k 3, kind "text".

When the last result is back, reply with each label and the text you were given. Do not propose another call.
```
