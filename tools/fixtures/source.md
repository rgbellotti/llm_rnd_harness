# Sample corpus document

This tiny document is the input for the committed schema-conformance
fixture. The reference builder turns it into
`tools/fixtures/demo.rag.db` in offline mode, and a harness test proves
that builder output passes startup validation. It is not a useful
semantic corpus — offline vectors are all zero — it documents the
builder flow end to end.

## How a corpus is built

Any Markdown or plain-text tree becomes a corpus: headings split each
file into sections, sections split into size-capped chunks, and every
chunk is embedded through the local Ollama model the corpus declares.
The result is a single SQLite file the harness validates and registers
as a search tool.

## What the harness checks

The startup scan requires `rag_meta` keys `embedding_model` and `dims`,
checks that each chunk's embedding blob is exactly `dims * 4` bytes of
little-endian float32, and keeps the corpus under its size caps. A
corpus that fails any check is reported and skipped, never half-loaded.

```text
python3 tools/build_rag.py tools/fixtures/source.md \
    -o tools/fixtures/demo.rag.db -m qwen3-embedding:4b --offline
```
