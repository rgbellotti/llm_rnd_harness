# Provider registry — design

The harness serves chat models from several services. Everything a
provider needs is declared once, in that provider's own module, and
nothing else in the harness names providers. This document records the
contract and the checklist for adding and removing providers.

## The contract

- `src/providers/mod.rs` holds one registry: `REGISTRY: &[ProviderSpec]`
  in selector order. All per-service facts live on the spec; per-service
  code lives in a module named after the provider
  (`providers::xai`, `providers::reflection`, `providers::opencode`,
  `providers::ollama`).
- Models are named from the module, never inline:
  `providers::xai::MODELS[0]`, `providers::reflection::MODELS[0]`, and so
  on. `src/models.rs` reads the default the same way. A guard test asserts
  that equality, so changing the default is a deliberate one-line edit,
  never a side effect.
- Dispatch resolves the provider once with `providers::for_model(name)`
  and reads spec fields. There are no
  `Grok || Reflection || Ollama` conditionals anywhere in `src/`; a
  provider can be added or removed without touching the run loop, the
  approvals, or the selector.
- Raw upstream ids live in `MODELS` and the live catalog. A provider whose
  ids overlap another service sets `selector_prefix`; the selector and
  history show `opencode/<id>`, while requests strip the prefix back to
  `<id>`. `conversation_id_prefix` similarly shapes stable session headers
  (`ses_<run-id>` for OpenCode).
- Each provider's unique requirements live in its module: its key
  variable (`KEY_ENV`), its hardcoded model list (`MODELS`), its spec
  (`SPEC`), and — only when its wire protocol differs — its transport
  adapter. The OpenAI-style providers share one adapter
  (`providers::chat_completions`); Ollama has its own.

## Model lists: live first, hardcoded fallback

The menu shows each provider's current list whenever the provider
publishes one. At startup the harness fetches `models_endpoint`; a
successful fetch replaces the offered list with exactly what the
provider returned — renames included (if Reflection renames Beam 1.0,
the menu follows the new name). Only when no list is available — no
endpoint, no key, timeout, odd response, empty list — does the
hardcoded `MODELS` list answer, so the selector still offers the models
the harness knows in advance. Because the hardcoded list is the
fallback, it must contain the models the spec's behaviors were verified
against — on the default provider, the default model — so the fallback
menu always offers a working model. A live catalog may also carry
`ModelMetadata` (context window and image input); OpenCode uses that to
resolve per-model budget and `view_img` behavior.

## Adding a provider

1. Create `src/providers/<name>.rs`:
   - `pub(crate) const KEY_ENV: &str` when the provider needs an API key
     (omit otherwise).
   - `pub(crate) const MODELS: &[&str]` — the raw upstream-id baseline.
   - `pub(crate) const SPEC: ProviderSpec` — id, display, group_name,
     host, chat_url, models, selector_prefix, conversation_id_prefix,
     catalog_format, key_env, cloud, supports_reasoning_effort,
     replays_reasoning, context_window, models_endpoint, transport,
     cache_conversation_header, request_headers. The field docs in
     `ProviderSpec` describe each one. A provider that caches by
     conversation names the header; the run id is the value, with any
     provider-specific prefix. Do not send another provider's header.
2. Register it: add `pub(crate) mod <name>;` to
   `src/providers/mod.rs` and one entry to `REGISTRY`.
3. If it has a key, add the variable to `providers::KEY_ENV_VARS` (one
   line). Every environment-scrub site — the `harden.rs` re-exec scan,
   the tool-child scrub, the sudo deny-list — derives from that list, so
   no scrub can miss the new key.
4. If it publishes a live model list, set `models_endpoint`:
   - an OpenAI-compatible absolute `/v1/models` URL for Chat Completions
     specs (the request carries the provider key), or
   - a daemon-relative path for an Ollama-style spec.
   The existing parsers cover both shapes; a differently-shaped list
   gets its own parser and `CatalogFormat` in `providers/mod.rs`.
5. If its wire protocol differs from both existing transports, add a
   `Transport` variant and its adapter. This is the only step that
   touches the run loop.
6. Update the registry tests in `providers/mod.rs`: the registry-count
   test and the cross-provider selector-name overlap test (two providers
   must never offer the same selected name).

After these steps the model selector, approvals, history, and dispatch
work for the new provider with no other edits.

## Removing a provider

1. Delete its module and its `REGISTRY` entry.
2. If it had a key, remove it from `KEY_ENV_VARS`.
3. If it was the default provider, point `DEFAULT_MODEL` at another
   spec's `MODELS[0]` (the guard test will show the edit).

## Changing the default model

`src/config.rs`, one line: `DEFAULT_MODEL` reads the new provider's
`MODELS[0]`. The guard test `the_default_model_is_beam_read_from_the_reflection_module`
fails until the edit is made deliberately, and the new default must be
on its spec's hardcoded `MODELS` list, so the fallback menu always
offers it. When the provider's live list is available and renames the
model, the menu follows the live name; `DEFAULT_MODEL` itself changes
only when the line is edited.
