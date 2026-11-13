# Testing

How are browserctl's tests organized, and which commands run them?

Each test class is one directory of `test/`, and
[`scripts/test.ts`](../scripts/test.ts) runs a class or a gate:

| Class | Boundary | Command |
| --- | --- | --- |
| unit | Pure functions over in-memory values: no filesystem, sockets, processes, or clock | `node scripts/test.ts unit` |
| component | browserctl code in-process against run-owned temporary directories and loopback listeners | `node scripts/test.ts component` |
| conformance | Read-only invariants of the checkout: the input schema and `.env`, the signal catalog, and test classes | `node scripts/test.ts conformance` |
| integration | The server with real Chrome and the image's browser and session users, inside the image's `test` stage | `node scripts/test.ts integration` |
| qualification | The built image under rootless Podman with the container's capability set: Chrome sandboxed as a browser user, a session driven over MCP, and a focused screencast near 60 frames per second | `node scripts/test.ts qualification` |

| Gate | Steps | Command |
| --- | --- | --- |
| Fast hermetic gate | typecheck, unit, component, conformance | `node scripts/test.ts fast` |
| Release gate | the fast gate's steps, then qualification | `node scripts/test.ts release` |

Each step runs in a child process that receives only `PATH`, `LANG`, and a
run-owned `HOME` and `TMPDIR`, so no developer or host input reaches the
unit, component, and conformance classes. Qualification also receives
`BROWSERCTL_QUALIFICATION_LAYOUT`, `BROWSERCTL_QUALIFICATION_REVISION`,
`XDG_RUNTIME_DIR`, and `XDG_DATA_HOME`, plus the operator's `HOME` and
`XDG_DATA_HOME` as `BROWSERCTL_QUALIFICATION_HOME` and
`BROWSERCTL_QUALIFICATION_DATA_HOME` for Podman's image store. A failing
step prints `FAILED class=<class>; reproduce: node scripts/test.ts <class>`,
and the test runner names each failing test by file and title. Unit,
component, and conformance tests use in-memory telemetry providers and
synthetic tokens; integration and qualification run the server with every
`OTEL_*_EXPORTER` set to `none`.

The integration class needs rootless Podman. It builds the
[`Containerfile`](../Containerfile)'s `test` stage under a run-owned tag, runs
the class in it as container root without network and with only the
capabilities in [`scripts/container.ts`](../scripts/container.ts), and removes
the tag afterwards. Podman receives only `PATH`, `HOME`, and
`XDG_RUNTIME_DIR`.

The qualification class runs the exact image an OCI layout holds, so it needs
one built first and named by `BROWSERCTL_QUALIFICATION_LAYOUT` and
`BROWSERCTL_QUALIFICATION_REVISION`. It starts the image with host
networking, exactly the capabilities in `scripts/container.ts`, and
no-new-privileges, then checks the server's effective capabilities, Chrome's
sandboxed renderer as a browser user, an MCP session driving an animating
page, and the focused screencast's rate. Podman uses the operator's image
store, not the run-owned home, so the image is not unpacked into `/tmp`.

## Image

`scripts/image.sh build <layout-dir> <revision> <created>` builds the image
with Podman as an OCI layout, stamped with the revision and `0.0.0`;
`scripts/image.sh push` writes its config and layers, annotated with the
revision, source, run URL, creation time, and version, to another OCI layout
or to a registry reference, reading the registry token on standard input.

The `Image` workflow runs the fast gate, the integration class, the image
build, and qualification on GitHub-hosted runners for every pull request,
branch push, and manual dispatch. Only its publish job holds `id-token:
write`; after qualification it exchanges the job's OIDC token for the
artifact registry's, pushes to the branch's area, and requires the pushed
manifest digest to equal the qualified one. Pull request runs get no token
and publish nothing, and only branch runs publish. The publish step runs
when the repository variable `ARTIFACT_REGISTRY` is set; until the operator
declares the repository in the host registry and sets it, push and dispatch
runs qualify the image without publishing it.
