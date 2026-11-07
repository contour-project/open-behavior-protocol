# Open Behavior Protocol 0.1

## Purpose and boundary

OBP represents domain behavior: actors, values, actions, choices, formulas, states, rules, examples and properties. A model describes intended or code-observed behavior independently of any particular environment. A business-relevant pricing formula belongs in behavior; an HTTP route, database layout or library call belongs in an implementation. Offline behavior may be a product requirement, while its retry mechanism remains an environment concern.

One model may be linked to multiple implementations. `basis.kind=requirement` denotes a requirement, `code` an inference from code, `mixed` both, and `unknown` an unresolved origin. Code-derived behavior is not automatically an approved business requirement. A link or source hash is not evidence of conformance.

In version 0.1 each process uses model schema `version: 1`. A file may contain one project and multiple processes or standalone processes without a project. The external process declaration ID, local element IDs and linked implementation IDs serve different purposes; preserve them when converting formats.

## Text and grammar

Source is UTF-8 `.obp` text. Object keys may be identifiers or JSON strings; values use JSON syntax. Line comments `//`, block comments `/* … */`, `,` or `;` separators and trailing separators are accepted. JSON string and number rules apply. Duplicate object keys and process IDs are errors. The validator rejects unknown model fields.

```ebnf
document = "obp" "0.1" ";" declaration { declaration } ;
declaration = project | process ;
project  = "project" ( identifier | string ) object [ ";" ] ;
process  = "process" ( identifier | string ) object [ ";" ] ;
object   = "{" [ member { separator member } [ separator ] ] "}" ;
member   = ( identifier | string ) ":" value ;
array    = "[" [ value { separator value } [ separator ] ] "]" ;
value    = object | array | string | number | "true" | "false" | "null" ;
separator = "," | ";" ;
identifier = ( letter | "_" ) { letter | digit | "_" | "-" } ;
```

`parse` records UTF-16 offsets from zero and lines and columns from one. `locations` is keyed by JSON Pointer within each model. `format` preserves data but not comments or original whitespace. CBOR is an optional transport for API results, not the OBP source syntax.

## Projects and environments

An optional `project` contains `title`, arrays `modules`, `entities`, `environments`, `implementations`, and optional `description`.

- A module has `id`, `title`, `processes`, `dependsOn`, and optional `description`. A process in this document belongs to at most one module; use `dependsOn` for another module instead of copying its process.
- An entity has `id`, `title`, `moduleId` (`null` for a global entity), and optional `description` and `dataSchema`. The schema uses the same data types as a `data` fact. The host connects a project entity to a process's grouped facts; matching names do not create a link.
- An environment has `id`, `title`, string `kind`, arrays `technologies` and `architecture`, and optional `description`. The open-ended kind accommodates applications, servers, libraries and other environments without a closed platform list.
- An implementation has a compatible 36-character `id`, `title`, `environmentId`, an array of relative `codeRefs`, and optional `description`. The host reads files and checks their revisions. Process blocks refer to implementations through `bindings`.

IDs are unique within each kind. Module references to processes declared in the document and to dependencies, entity references to modules and implementation references to environments are checked. A binding to an implementation absent from the document produces a warning: the host may resolve it externally. A binding does not prove that an implementation performs the process. See [publish-article.obp](../examples/publish-article.obp) for one model linked to three environments.

## Process structure

Required fields are `version`, `intent`, `basis`, `assumptions`, `facts`, `steps`, `definitions`, `properties`, `examples` and `bindings`. `entities` and `instances` are optional.

- `facts` are named values with `id`, `title`, `type`, `initial` and optional `scope=shared|instance`. Initial kinds are `value`, `any` and `unknown`. `any` means every admissible value; `unknown` means information is missing and must not be treated as arbitrary.
- Types are `boolean`, `choice`, `text`, `integer`, `decimal`, `date`, `instant`, `collection` and `data`. A choice specifies `options`, a collection specifies `fields`, and recursive data specifies `dataSchema` with named definitions and `root`. Integers and decimals are strings; booleans are JSON booleans. Dates are `YYYY-MM-DD`; instants are UTC `YYYY-MM-DDTHH:mm:ssZ`.
- `entities` group existing facts and optionally refer to a host object with `nodeId`. A fact belongs to at most one such entity.
- `steps` and `definitions` are ordered blocks with stable IDs. `use` reuses a local definition; `call` identifies a definition in another process, its revision and parameter mapping. A host must resolve external references before checking that fragment.
- `properties` declare `always`, `after`, `eventually` or `within`. An expression may be unknown. `within` identifies start and end actions, a clock fact and a duration in seconds.
- `examples` specify initial values, action IDs, optional intermediate states, expected values and whether the process completed.
- `bindings` are pairs of `blockId` and `implementationId`. One block may be linked to multiple environments; implementation meaning, version and authenticity are host responsibilities.

Fact, entity, block, branch, definition, property and example IDs are unique within a model. They have 1–64 characters, start with a lowercase Latin letter and otherwise contain `a-z`, digits, `_` or `-`. Scalar facts and collection field IDs additionally use only `a-z`, digits and `_` and are limited to 32 characters. In the compatibility profile linked-object and external-process IDs contain 36 hexadecimal characters and hyphens. This does not verify the referenced object's existence.

## Blocks and expressions

An `action` contains `actor`, `guard`, `specified` and `changes` with `factId` and an expression. All changes in an action are evaluated against the preceding state and applied simultaneously. `guard: null` or `specified: false` indicates an incomplete model.

`group` is a sequence; `choice` has conditional branches and at most one `otherwise`; `parallel` contains branches whose actions may interleave; `repeat` repeats while its condition holds. When `exclusive=true`, simultaneous matching branches are reported. `use` expands a local definition. Recursive reusable blocks are unsupported. An unresolved external `call` remains unknown rather than being silently omitted.

Expressions use structured `op` nodes: literals, `var`, `if`, arithmetic, comparisons, boolean operations, text and date operations, collections and nested data. `hole` is unknown. `and`, `or` and `if` short-circuit. Decimal literals are exact rationals. Division by zero, invalid paths and overflow are evaluation errors, not successful verification. Integer division and rounding require a mode. `all_items` is true for an empty list; express non-emptiness separately. The complete implemented expression and data-type shapes are `Expression` in `src/business-algorithm.ts` and `DataType` in `src/business-data.ts`.

## Verification and limits

Type checking is not a proof of properties. State exploration considers described actions and their permitted interleavings within the investigated domain. `always` is checked in reachable states, `after` after an action, `eventually` over considered paths and `within` against time explicitly changed by the model. `may_wait` permits indefinite waiting; `advance` assumes some available step occurs but not fairness of individual branches. Time does not advance on its own.

Reports include `complete`, scope, state and transition counts, possible violations and `verified`, `violated`, `unknown` or `not_applicable` property statuses. An example covers its stated path only. If exhaustive exploration is unavailable, individual invariants can sometimes be proved by ranges, induction or optional SMT; the method and assumptions appear in the result. This does not establish termination, freedom from execution errors or conformance of actual code. Lack of a counterexample in an incomplete exploration is not proof.

The reference implementation limits model JSON to 500,000 characters; it accepts up to 64 facts, 250 blocks, 64 properties, 32 examples and 200 bindings, with block nesting up to 12. Up to 10,000 instances may be declared, but the checker expands at most 64; its defaults explore up to 5,000 states and 2,048 initial combinations. These are implementation limits, not product requirements. Recursive data values are finite and their validation is resource-bounded. An exceeded limit or unknown fragment yields an incomplete result. Fraction proofs use rational arithmetic, not the IEEE-754 semantics of actual code. The [model instructions](agent-guide.en.md) enumerate the available operations and additional limits.

## Implementation conformance

`verifyRefinement` compares two formal models under explicit fact and action mappings, over finite initial domains and reachable paths. An internal implementation action must preserve observable values. A `verified` result applies to that model comparison, not the running application.

The Node `checkImplementationExamples` adapter takes `command`, `args`, `cwd` and optionally an explicit `env`. For each example it sends one JSON object `{caseId, initial, actions}` to stdin; expected answers are not included. The adapter executes observed actions and writes one JSON object `{caseId, initial, states, final, completed}` to stdout, where `states` contains the state after each action. The adapter itself is responsible for calling the real implementation. Failure to run or an incomplete result yields `unknown`. A passing example does not prove other paths or the authenticity of the adapter.

## Compatibility and extension

`fromModel` and `toModel` preserve all valid version 1 model fields, including IDs, links, sources and unknown values. A host stores projects and revisions, links files, enforces access and resolves external definitions. OBP does not make network requests or request secrets automatically; callers are responsible for protecting data they provide. Changes to requirements, code or links do not automatically update a model; the host should mark stale results. Unknown mandatory extensions and future versions must not be treated as supported.
