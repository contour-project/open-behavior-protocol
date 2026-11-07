# Open Behavior Protocol

[Русский](README.ru.md) · [Specification](docs/spec.en.md) · [Model instructions](docs/agent-guide.en.md) · [API and CLI](docs/api.md)

Open Behavior Protocol (OBP) is a structured format for describing and checking the behavior of products and internal systems. It represents processes, data, business rules, examples, properties and links to implementations as a shared model that people, visual editors and software agents can use.

## Why OBP

Requirements are often scattered across conversations, documents, designs, tests and code. Different teams and environments then implement the same behavior independently, and the connections between decisions and code are difficult to verify.

Agentic development makes this gap more visible: agents can change many files quickly, but generated code and tests alone do not establish what the product was supposed to do. OBP provides an explicit, machine-readable place for the behavior, its origin, examples and properties. Agents can inspect and update the same structure as people, then connect its blocks to implementations in multiple environments.

OBP separates **what matters in the domain** from **how an environment implements it**. A pricing formula or a customer-visible failure belongs in the behavior when it matters to the product. HTTP routes, storage details and framework choices belong to an environment. One behavior can be linked to a mobile app, a website and a backend without duplicating the process. Behavior inferred from code records what the code appears to do; it is not automatically an approved requirement.

## What is included

- A text format with project modules, entities, environments and implementation links.
- Process blocks for actions, choices, parallel branches, repetition and reusable definitions.
- Typed facts, expressions, exact fractional arithmetic and recursive structured data.
- Examples, state-space checks, limited property proofs and formal model comparison.
- A TypeScript reference implementation, CLI and an opt-in Node adapter for checking observed implementation examples.
- [Article publishing](examples/publish-article.obp), [consulting fee](examples/consulting-fee.obp) and [recursive expression tree](examples/expression-tree.obp) examples.

Version 0.1 is an early reference implementation, not a universal proof system. See the [specification](docs/spec.en.md) and [model instructions](docs/agent-guide.en.md) for the actual semantics and limits.

## Get started

Requirements: Node.js 23.6 or newer and npm. The core can be used without the optional Z3 solver.

```sh
npm install
npm run build
node bin/obp.ts check examples/publish-article.obp --strict
node bin/obp.ts inspect examples/publish-article.obp
node bin/obp.ts verify examples/publish-article.obp
npm test
npm run typecheck
```

`check` validates syntax, types and links, not the truth of a requirement. `inspect` exposes the structure for an editor or agent. `verify` checks declared properties under the assumptions and scope in its report. A `verify` exit code of 0 means completed checking with no reported violation, 1 means a violation or error, and 2 means the result is incomplete or not applicable. An empty set of properties does not prove unstated requirements.

A visual editor and a text document may present the same structure; storage, rendering, access control and resolving external references are the host application's responsibility. `format` retains the model but discards comments and source formatting.

## Use the library

```ts
import { check, inspect, verify, format, toModel, fromModel } from 'open-behavior-protocol';

const checked = check(source, { filename: 'publish-article.obp' });
if (!checked.ok || !checked.document) throw new Error('Invalid OBP document');

const diagram = inspect(checked.document);
const report = verify(checked.document, 'publish_article');
const model = toModel(checked.document, 'publish_article');
const text = format(fromModel('publish_article', model));
```

For the Node adapter and optional fractional proofs, use `open-behavior-protocol/node`. See the [API and CLI reference](docs/api.md).

## Trust and limits

A structurally valid model can still express the wrong requirement. A proof applies only to the stated properties, scope and assumptions; `unknown`, resource exhaustion and unresolved references are not proofs. Comparing formal models does not prove that deployed code conforms. The adapter runs a caller-selected executable and checks only the observations supplied for selected examples.

## License

[MIT](LICENSE).
