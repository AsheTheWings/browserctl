# Testing

How are browserctl's tests organized, and which commands run them?

Each test class is one directory of `test/`, and
[`scripts/test.ts`](../scripts/test.ts) runs a class or a gate:

| Class | Boundary | Command |
| --- | --- | --- |
| unit | Pure functions over in-memory values: no filesystem, sockets, processes, or clock | `node scripts/test.ts unit` |
| component | browserctl code in-process against run-owned temporary directories and loopback listeners | `node scripts/test.ts component` |
| conformance | Read-only invariants of the checkout: the input schema and `.env`, the signal catalog, and test classes | `node scripts/test.ts conformance` |

| Gate | Steps | Command |
| --- | --- | --- |
| Fast hermetic gate | typecheck, unit, component, conformance | `node scripts/test.ts fast` |
| Release gate | the fast gate's steps, then integration | `node scripts/test.ts release` |

Each step runs in a child process that receives only `PATH`, `LANG`, and a
run-owned `HOME` and `TMPDIR`, so no developer or host input reaches a test.
A failing step prints `FAILED class=<class>; reproduce: node scripts/test.ts
<class>`, and the test runner names each failing test by file and title.
Tests use in-memory telemetry providers and synthetic tokens only.
