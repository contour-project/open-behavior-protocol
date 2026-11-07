# API and CLI

The browser-compatible core is exported from `open-behavior-protocol`. It does not make network requests. Node-only execution and optional SMT proof support are exported from `open-behavior-protocol/node`.

| Function | Purpose |
| --- | --- |
| `parse(source, {filename?})` | Parse a document with source locations; syntax errors throw `OBPError`. |
| `validate(document)` | Return structural/type diagnostics and unresolved-reference warnings. |
| `check(source, {filename?, strict?})` | Return `{ok, document, diagnostics}`; strict mode treats warnings as failure. |
| `inspect(document)` | Return a renderer-neutral deep copy of the project and processes. |
| `validateProject(project, processIds)` | Validate project metadata, ownership and references. |
| `verify(document, processId)` | Check declared properties/examples under the reported scope and assumptions. |
| `verifyTrace(document, processId, example)` | Check one claimed model trace. |
| `verifyRefinement(business, businessId, implementation, implementationId, mapping, options?)` | Compare two formal models under explicit mappings. |
| `fromModel(id, model)` / `toModel(document, id)` | Convert valid version 1 process models without dropping fields; return deep copies. |
| `format(document)` | Emit canonical OBP text, without original comments or formatting. |
| `encodeCbor(value)` | Encode a structured API result in CBOR. |

The older names `fromContour` and `toContour` remain aliases of `fromModel` and `toModel` for existing integrations. They are deprecated, not removed.

The core also exports `validateBusinessProcess`, `checkBusinessProcess`, `checkBusinessTrace`, `checkBusinessRefinement`, `generateBusinessExamples`, `runAlgorithm`, `checkAlgorithm`, `evaluateExpression`, `expressionContext`, `validateBusinessData`, `validateDataDefinitions` and their public types.

## Node API

`checkImplementationExamples(model, options)` runs a caller-selected adapter without a shell, sends input and action IDs, and compares returned observations. Unless `options.env` is supplied, only `PATH` and `LANG` are passed to the child. A malformed response, execution error or timeout yields `unknown`. The adapter is arbitrary executable code: run it only when authorized. See [implementation conformance](spec.en.md#implementation-conformance) for the wire format and limits of the conclusion.

`await proveFractionalProperties(model, propertyIds?)` uses optional `z3-solver` to establish some invariants. It returns only results it can justify; an empty list is not a proof. If the package is unavailable it reports a loading error. It does not prove action reachability, termination, error freedom or conformance of running code.

## CLI

```sh
node bin/obp.ts check examples/publish-article.obp --strict
node bin/obp.ts inspect examples/publish-article.obp
node bin/obp.ts verify examples/publish-article.obp --process publish_article
node bin/obp.ts format examples/publish-article.obp
node bin/obp.ts inspect examples/publish-article.obp --cbor > inspection.cbor
node bin/obp.ts verify examples/publish-article.obp --cbor > report.cbor
```

After a build, the installed package exposes the same CLI as `obp`. `verify` requires `--process` if the file contains multiple processes. With `--cbor`, stdout contains binary data; diagnostics go to stderr.

`check` exits 1 on errors and, with `--strict`, on warnings. `verify` exits 1 on a violation or error, 2 on an incomplete or inapplicable result, and 0 on completed exploration without a reported violation. A syntax or file-read error exits 1; invalid arguments exit 2. No specified properties means no properties are proved.
