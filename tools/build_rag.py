#!/usr/bin/env python3
"""Reference builder for harness RAG corpora (`*.rag.db`).

The harness stays formless about corpora: it only validates the SQLite
schema at startup and registers one search tool per file. This script is
the reference implementation of the builder half — the driver model can
write a bespoke one for your project against the same documented schema.

Document mode (default) — Markdown or plain text:

    python3 tools/build_rag.py docs/ -o mydocs.rag.db -m qwen3-embedding:4b

Each file becomes a `rag_document`; headings split it into chunks; each
chunk is embedded through the local Ollama daemon and stored as a
`rag_node` with its f32-little-endian vector.

Records mode — JSON arrays / JSONL, e.g. a Hugging Face dataset slice:

    python3 tools/build_rag.py records.jsonl -o set.rag.db -m qwen3-embedding:4b \
        --text-keys instruction,output --title-key title --id-key id

Each record becomes a `rag_document`; each `--text-keys` field becomes
one chunk under the record's title, with `--context-keys` (short fields
like severity or category) joined into a context line on every chunk.
Field values that embed Python reprs of dicts/lists (common in scraped
datasets) are re-serialized as readable indented JSON.

Drop the output in the workspace root and the next harness start
registers `<name>_search`.

Schema contract (what `src/tools/rag.rs` validates at startup):

    rag_meta(key, value)      required: embedding_model, dims
                              optional: name, query_hint, kind,
                                        description
    rag_document(id, title, source_path, metadata_json, created_at)
    rag_node(id, document_id, ref_id, parent_id, position,
             role, heading, heading_path, content, content_kind,
             language, anchor, metadata_json,
             embedding_model, dims, embedding)

  - `role` is 'chunk' for every row this builder writes; the embedding
    blob must be exactly dims * 4 bytes of float32 little-endian.
  - `content_kind` is 'text' or 'code' (chunks that contain a fenced
    code block); the search tool's `kind` filter matches it.
  - Caps the scanner enforces: dims <= 16384, chunks <= 2,000,000,
    embedding matrix <= 512 MiB.

`--offline` skips the daemon and writes zero vectors of `--dims`
dimensions: the output still validates (and proves the schema) but does
not answer meaningful queries. It exists for tests and dry runs.

Standard library only; no dependencies to install.
"""

import argparse
import json
import re
import sqlite3
import struct
import sys
import time
import urllib.request
from pathlib import Path

OLLAMA_DEFAULT = "http://127.0.0.1:11434"
MAX_RAG_DIMS = 16_384
MAX_RAG_CHUNKS = 2_000_000
MAX_CHARS_PER_CHUNK_DEFAULT = 4_000


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Build a .rag.db corpus the harness validates and registers as a search tool."
    )
    parser.add_argument("sources", nargs="+", help="Markdown/text files or directories")
    parser.add_argument("-o", "--output", required=True, help="output path, e.g. mydocs.rag.db")
    parser.add_argument(
        "-m",
        "--model",
        default="qwen3-embedding:4b",
        help="Ollama embedding model name, stored in rag_meta (default: qwen3-embedding:4b)",
    )
    parser.add_argument("--name", help="corpus name (default: output file stem)")
    parser.add_argument("--description", help="one-line description stored in rag_meta")
    parser.add_argument(
        "--query-hint",
        help="hint stored in rag_meta, shown with the tool's description",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=MAX_CHARS_PER_CHUNK_DEFAULT,
        help="approximate chunk length cap (default: 4000)",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="no daemon calls: zero vectors of --dims (schema-conformance output)",
    )
    parser.add_argument(
        "--dims",
        type=int,
        default=None,
        help="vector size; required with --offline, verified against the model otherwise",
    )
    parser.add_argument(
        "--host",
        default=OLLAMA_DEFAULT,
        help=f"Ollama base URL (default: {OLLAMA_DEFAULT})",
    )
    # Records mode: .json (an array of objects) or .jsonl (one object per
    # line) sources. Each record becomes one document; each text key
    # becomes one chunk under the record's title. This is the path for
    # instruction/QA datasets such as Hugging Face exports.
    parser.add_argument(
        "--text-keys",
        help="comma-separated record fields to index as chunks (records mode)",
    )
    parser.add_argument(
        "--title-key",
        help="record field carrying the human title for the document/heading",
    )
    parser.add_argument(
        "--id-key",
        help="record field carrying a stable id, used in source_path",
    )
    parser.add_argument(
        "--context-keys",
        help="comma-separated short fields joined into a context line on every chunk",
    )
    return parser.parse_args(argv)


def gather_files(sources, records=False):
    """Collect input files. Records mode (.json/.jsonl with --text-keys)
    or document mode (.md/.markdown/.txt) — never mixed."""
    wanted = {".json", ".jsonl"} if records else {".md", ".markdown", ".txt"}
    files = []
    for source in sources:
        path = Path(source)
        if path.is_dir():
            found = sorted(p for p in path.rglob("*") if p.is_file() and p.suffix.lower() in wanted)
            if not found:
                raise SystemExit(f"no {sorted(wanted)} files under {source}")
            files.extend(found)
        elif path.is_file():
            if path.suffix.lower() not in wanted:
                if records and path.suffix.lower() in {".md", ".markdown", ".txt"}:
                    raise SystemExit(
                        f"{path}: --text-keys selects records mode (.json/.jsonl); "
                        "leave it off to index Markdown/text files"
                    )
                if not records and path.suffix.lower() in {".json", ".jsonl"}:
                    raise SystemExit(
                        f"{path} is a JSON/JSONL records file; pass --text-keys "
                        "(and --title-key) to index its fields"
                    )
                raise SystemExit(f"unsupported input type: {path}")
            files.append(path)
        else:
            raise SystemExit(f"not a file or directory: {source}")
    if not files:
        raise SystemExit("no input files")
    return files


HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")


def split_sections(lines):
    """Yield (heading_chain, heading, text_lines) per heading-delimited section."""
    chain = []
    heading = ""
    buffer = []
    for line in lines:
        match = HEADING_RE.match(line)
        if match:
            if buffer or heading:
                yield chain, heading, buffer
            depth = len(match.group(1))
            chain = chain[: depth - 1]
            chain.append(match.group(2))
            heading = match.group(2)
            buffer = []
        else:
            buffer.append(line)
    if buffer or heading:
        yield chain, heading, buffer


def split_by_size(lines, max_chars):
    """Split one section's lines into paragraph-bounded pieces under max_chars."""
    pieces = [[]]
    size = 0
    for line in lines:
        addition = len(line) + 1
        if size + addition > max_chars and pieces[-1]:
            pieces.append([])
            size = 0
        pieces[-1].append(line)
        size += addition
    return [piece for piece in pieces if any(line.strip() for line in piece)]


def chunk_kind(text):
    return "code" if re.search(r"^\s*```", text, re.MULTILINE) else "text"


def tidy_value(value):
    """Render a record field as readable text.

    Some datasets embed Python reprs of dicts and lists as strings
    (single quotes, no indentation). Re-parse those with literal_eval
    and re-serialize as indented JSON so a chunk reads like content, not
    like a serialized object. Anything else passes through unchanged.
    """
    if not isinstance(value, str):
        value = str(value)
    stripped = value.strip()
    if stripped[:1] in "{[":
        try:
            import ast

            return json.dumps(ast.literal_eval(stripped), indent=2)
        except (ValueError, SyntaxError):
            return value
    return value


def parse_comma_list(raw):
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def read_records(path):
    """A .json file is one array of records; a .jsonl file is one per line."""
    if path.suffix.lower() == ".jsonl":
        records = []
        with path.open(encoding="utf-8") as handle:
            for number, line in enumerate(handle, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as error:
                    raise SystemExit(f"{path}:{number} is not a JSON object: {error}")
        return records
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise SystemExit(f"{path} is not a JSON array of records (records mode needs --text-keys)")
    return data


def record_chunks(record, text_keys, title_key, context_keys):
    """One chunk per text key: the title heads it, short context fields
    prefix the content, so every chunk carries what a query matches."""
    title = str(record.get(title_key, "") or "") if title_key else ""
    context = ""
    if context_keys:
        pairs = [
            f"{key}: {record.get(key, '')}".strip()
            for key in context_keys
            if str(record.get(key, "") or "").strip()
        ]
        context = " · ".join(pairs)
    chunks = []
    for key in text_keys:
        if key not in record:
            continue
        text = tidy_value(record[key]).strip()
        if not text:
            continue
        heading = f"{title} — {key}" if title else key
        content = text if not context else f"{context}\n\n{text}"
        chunks.append((title, heading, content))
    return title, chunks


def embed_one(host, model, text, timeout=120):
    body = json.dumps({"model": model, "prompt": text}).encode()
    request = urllib.request.Request(
        f"{host.rstrip('/')}/api/embeddings",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    vector = payload.get("embedding")
    if not isinstance(vector, list) or not vector:
        raise SystemExit(f"Ollama returned no embedding for model {model}")
    return [float(value) for value in vector]


SCHEMA = """
CREATE TABLE rag_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE rag_document(
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, source_path TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE rag_node(
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES rag_document(id) ON DELETE CASCADE,
    ref_id TEXT NOT NULL, parent_id INTEGER, position INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('section','chunk')),
    heading TEXT NOT NULL DEFAULT '', heading_path TEXT NOT NULL DEFAULT '[]',
    content TEXT NOT NULL DEFAULT '', content_kind TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    embedding_model TEXT, dims INTEGER, embedding BLOB);
"""


def main(argv):
    args = parse_args(argv)
    if args.offline:
        dims = args.dims or 4
    elif args.dims:
        raise SystemExit("--dims is for --offline; the live model reports its own size")

    text_keys = parse_comma_list(args.text_keys)
    context_keys = parse_comma_list(args.context_keys)
    files = gather_files(args.sources, records=bool(text_keys))
    print(f"reading {len(files)} file(s)")

    # Read and chunk everything first, so a bad input fails before any
    # embedding work is spent on it. A document is
    # (title, source_path, [(heading_path, heading, content), ...]).
    documents = []
    if text_keys:
        for path in files:
            records = read_records(path)
            for position, record in enumerate(records, start=1):
                if not isinstance(record, dict):
                    raise SystemExit(f"{path}: every record must be a JSON object")
                title, chunks = record_chunks(record, text_keys, args.title_key, context_keys)
                if not chunks:
                    continue
                record_id = str(record.get(args.id_key, "") or "") if args.id_key else ""
                source = f"{path}" + (f"#{record_id}" if record_id else f"#{position}")
                documents.append((title or path.stem, source, chunks))
    else:
        for path in files:
            text = path.read_text(encoding="utf-8")
            chunks = []
            for chain, heading, lines in split_sections(text.splitlines()):
                for piece in split_by_size(lines, args.max_chars):
                    chunks.append((chain, heading, "\n".join(piece).strip()))
            if chunks:
                documents.append((path.stem, str(path), chunks))
    total_chunks = sum(len(chunks) for _, _, chunks in documents)
    if total_chunks == 0:
        raise SystemExit("nothing to index: no chunkable content found")
    if total_chunks > MAX_RAG_CHUNKS:
        raise SystemExit(f"{total_chunks} chunks exceeds the harness cap ({MAX_RAG_CHUNKS})")
    print(f"{total_chunks} chunk(s) across {len(documents)} document(s)")

    if not args.offline:
        print(f"embedding with {args.model} at {args.host} …")
        vectors = []
        for _, _, chunks in documents:
            for _, _, content in chunks:
                vectors.append(embed_one(args.host, args.model, content))
        dims = len(vectors[0])
        if any(len(vector) != dims for vector in vectors):
            raise SystemExit("the embedding model returned inconsistent vector sizes")
        if dims > MAX_RAG_DIMS:
            raise SystemExit(f"dims {dims} exceeds the harness cap ({MAX_RAG_DIMS})")
    else:
        vectors = [[0.0] * dims] * total_chunks
        print(f"offline: zero vectors of {dims} dimension(s)")

    output = Path(args.output)
    if output.exists():
        raise SystemExit(f"{output} already exists; remove it first")
    output.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(output)
    conn.executescript(SCHEMA)

    name = args.name or output.stem.removesuffix(".rag")
    meta = {
        "embedding_model": args.model,
        "dims": str(dims),
        "name": name,
    }
    if args.description:
        meta["description"] = args.description
    if args.query_hint:
        meta["query_hint"] = args.query_hint
    conn.executemany(
        "INSERT INTO rag_meta(key, value) VALUES (?, ?)", sorted(meta.items())
    )

    now = int(time.time() * 1000)
    node_id = 0
    for document_id, (title, source, chunks) in enumerate(documents, start=1):
        conn.execute(
            "INSERT INTO rag_document(id, title, source_path, created_at) VALUES (?, ?, ?, ?)",
            (document_id, title, source, now),
        )
        for position, (chain, heading, content) in enumerate(chunks, start=1):
            node_id += 1
            vector = vectors[node_id - 1]
            blob = b"".join(struct.pack("<f", value) for value in vector)
            conn.execute(
                """INSERT INTO rag_node(
                       id, document_id, ref_id, parent_id, position, role,
                       heading, heading_path, content, content_kind,
                       language, anchor, metadata_json,
                       embedding_model, dims, embedding)
                   VALUES (?, ?, ?, NULL, ?, 'chunk', ?, ?, ?, ?, '', '', '{}', ?, ?, ?)""",
                (
                    node_id,
                    document_id,
                    f"{title}-{position}",
                    position,
                    heading,
                    json.dumps(chain),
                    content,
                    chunk_kind(content),
                    args.model,
                    dims,
                    blob,
                ),
            )
    conn.commit()
    conn.close()

    print(f"wrote {output} ({total_chunks} chunks, dims {dims}, name '{name}')")
    print("drop it in the harness workspace root; the next start registers it as a search tool")


if __name__ == "__main__":
    main(sys.argv[1:])
