# Tasks

A task is a saved [e2e](https://www.npmjs.com/package/e2e) test file that
browserctl runs against a session's browser. Agents save tasks with
`task_save` and run them with `task_run`; the MCP endpoint serves this guide
as `browserctl://guides/tasks`, and the e2e guides to writing tests and agent
steps as `browserctl://guides/e2e-writing-tests` and
`browserctl://guides/e2e-agent`.

## The task file

Each `task_save` stores the file as a new immutable revision of the named
task, attributed to the saving client. `task_get` and `task_run` take the
latest revision unless they name one.

A task file holds one e2e test. It reads its JSON input from the file that
`BROWSERCTL_TASK_INPUT_FILE` names and writes its JSON output to the file
that `BROWSERCTL_TASK_OUTPUT_FILE` names:

```ts
import { expect, test } from 'e2e';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

test('order status', async ({ app, agent, screen }) => {
  const input = JSON.parse(readFileSync(process.env.BROWSERCTL_TASK_INPUT_FILE!, 'utf8'));
  await app.open(`https://shop.example/orders/${input.order}`);
  await agent.act('open the shipping details');
  await expect(screen.getByRole('heading', { name: 'Shipping' })).toBeVisible();
  const status = await agent.extract('the shipping status', { schema: z.string() });
  writeFileSync(process.env.BROWSERCTL_TASK_OUTPUT_FILE!, JSON.stringify({ status }));
});
```

A task can import `e2e`, `zod`, and Node's built-in modules. Open pages by
absolute URL. A run starts on whatever page the session shows
and leaves the browser open on the page it ends on, with the session's
cookies and storage.

## Runs

`task_run` runs the revision with `input` (default `{}`, at most 1 MiB of
JSON) against the bound session's browser and returns:

| Field | Holds |
| --- | --- |
| `status` | `passed`, `failed`, `timed_out`, or `error` |
| `output` | The JSON the task wrote to its output file, or `null` |
| `failure` | Why the run did not pass, or `null` |
| `error_class` | For a run that did not pass: `task_failed`, `timeout`, `model_unavailable`, or `internal` |
| `run`, `revision`, `duration_ms` | The run's identity, the revision it ran, and its duration |

A test that passes but writes output that is not JSON, or more than 1 MiB,
fails. A run whose agent steps got no answer from the model ends in `error`
with `model_unavailable`. Browser tools on the session are refused while a
run drives it, and one session runs one task at a time. The server kills a
run that exceeds `BROWSERCTL_TASK_TIMEOUT_SECONDS` and reports it as
`timed_out`.

A run executes as the session's own user in a directory under the session's
home, with e2e's analytics off. It reaches the browser through a capability
of its own, which ends with the run. It cannot read the server's state, the
model key, provider tokens, the session's profile copy, or other sessions'
files. A session counts as active while a run drives it, so it never idles
out under a run.

## Models

Agent steps reach the model only through the server's forwarder at
`POST /v1/responses`. Each run gets a token that works only while the run
lasts; the forwarder adds the model key and sends the request to
`BROWSERCTL_MODEL_BASE_URL` with `BROWSERCTL_MODEL_NAME` as its model,
whatever model the request names. Without a configured model, a task
without agent steps still runs, and one with agent steps ends in `error`
with `model_unavailable`.

## The replay cache

Each task keeps one e2e replay cache in the server's state. A run starts
with a copy of it. When a run ends with a result while its session is still
open, the server replaces the task's cache with the run's; a run that timed
out, was killed, or lost its session leaves the cache as it was. A later
run replays an `agent.act` step's recorded actions without a model call
when the step starts on the same page as when it was recorded and a later
check confirmed it; see the e2e guide to agent steps for what makes a step
replay.

## Service checks

A profile's service names a check task: a task that passes while the
profile is signed in to the service and fails otherwise. Every
`BROWSERCTL_SERVICE_CHECK_INTERVAL_SECONDS`, and when the dashboard asks,
the server runs a service's check task in a fresh session from the
profile's current revision, then closes it. A passing run marks the
service `signed_in` and a failing or timed-out one `signed_out`, with the
time and the run; a run that ends in `error` leaves the last result in
place.
