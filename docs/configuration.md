# Configuration

How does browserctl get its configuration, and what makes it refuse to start?

[`config/inputs.json`](../config/inputs.json) is the schema of every process
input of the server (`browserctl serve`) and the admin command
(`browserctl admin`): its name, shape, class, the processes that read it, and
its default in each profile. The tracked [`.env`](../.env) lists every input
with its development default for reading. It is generated with
`node scripts/env.ts > .env`, and no process or tool loads it.

## Profiles

`BROWSERCTL_PROFILE` selects `development` (the default) or `production`. An
input without a default in the selected profile is required; production has
no default for the port, the public base URL, the model inputs, the OTLP
endpoint, or the deployment environment name.

## Layers

Layers apply lowest first:

1. the schema defaults of the selected profile;
2. the target overlay files that `BROWSERCTL_OVERLAY_FILES` names, separated
   by colons, each applied in order;
3. the protected file that `BROWSERCTL_PROTECTED_FILE` names;
4. process inputs.

Overlays and the protected file hold literal `NAME=value` lines without
quotes or expansion; blank lines and lines starting with `#` are skipped.
Every layer is optional, and an absent file is skipped. A present file that
is unreadable or malformed, sets a name twice, or sets an unknown input stops
the process. Only process inputs select the profile and the layer files.
Overlays may set only configuration inputs; the protected file may set only
protected inputs and must be readable by its owner alone.

A default may refer to another input as `${NAME}`. Directory defaults follow
the XDG base directories: the state directory is
`$XDG_STATE_HOME/browserctl`, the session work directory
`$XDG_CACHE_HOME/browserctl`, and the recordings directory `recordings/`
under the state directory. An empty XDG variable counts as unset. `HOME` is
needed only when a default refers to it.

The process validates only the merged effective inputs it reads, reports
every problem at once by input and file name without showing any value, and
refuses to start on any of them. A process input whose name starts with
`BROWSERCTL_` or `OTEL_` must be one the schema declares, so no library reads
an undeclared one.

## Protected inputs

A protected input names a file that holds a secret, such as the model API key
or the OTLP export headers. The value never travels in an input itself. Each
such file must exist, be readable by its owner alone, and hold a value; the
server refuses to start otherwise. External providers' token files, named inside
`BROWSERCTL_PROVIDERS`, follow the same rule.
