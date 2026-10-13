# verdrift

[![ci](https://github.com/thanatchon36/verdrift/actions/workflows/ci.yml/badge.svg)](https://github.com/thanatchon36/verdrift/actions/workflows/ci.yml)

Your `.nvmrc` says 22, your Dockerfile builds on 20, and CI still tests 18. verdrift finds every
place a repository declares a Node, Python, or Go version and tells you, with file and line,
where they disagree.

```sh
npx github:thanatchon36/verdrift
```

Run it in the root of any repository. It needs Node.js 22 or newer and git. There is nothing to
configure, verdrift itself makes no network requests, and it exits non-zero when it finds a
problem, so the same command works as a CI check.

## Example

[`examples/drifted`](examples/drifted) is a small web app with a Python API. To reproduce this
output from a clone of this repository:

```sh
git clone https://github.com/thanatchon36/verdrift && cd verdrift && npm ci
node bin/verdrift.js examples/drifted
```

```text
node
  package.json:5              engines.node            range  >=20
  .nvmrc:1                                            pin    22
✗ Dockerfile:1                FROM node:20-alpine     pin    20-alpine
✗ .github/workflows/ci.yml:8  setup-node matrix.node  ci     18
  .github/workflows/ci.yml:8  setup-node matrix.node  ci     20
  .github/workflows/ci.yml:8  setup-node matrix.node  ci     22

python
  api/pyproject.toml:4         requires-python              range  >=3.11
✗ api/Dockerfile:1             FROM python:3.10-slim        pin    3.10-slim
✗ .github/workflows/ci.yml:24  setup-python python-version  ci     3.10  (skipped: unquoted YAML number, see problem)

4 problems
✗ .github/workflows/ci.yml:24  python 3.10 (setup-python python-version) is a YAML number, so the action receives "3.1". Quote it: '3.10'  yaml-number
✗ .github/workflows/ci.yml:8   node 18 (setup-node matrix.node) is outside ">=20" (package.json:5 engines.node)  outside-range
✗ Dockerfile:1                 FROM node:20-alpine disagrees with 22 (.nvmrc:1)  pin-mismatch
✗ api/Dockerfile:1             FROM python:3.10-slim is outside ">=3.11" (api/pyproject.toml:4 requires-python)  outside-range
```

## Why

The runtime version of a typical repository is written down in several places: a version file
for developers, `engines` or `requires-python` for users, a base image for production, and one
or more CI workflows. Nothing keeps them in sync. When one is bumped and another is forgotten,
the result is a production image that runs a different major version than the one you develop
and test on, a CI matrix that spends minutes on versions you no longer support, or a Docker
build that stops with:

```text
go: go.mod requires go >= 1.23 (running go 1.22.12; GOTOOLCHAIN=local)
```

because `go.mod` was bumped and the `golang:1.22` base image was not.

Teams usually notice this late and fix it with a one-off script that compares two of those
files. verdrift checks all of them at once.

## Use cases

- **Before a version bump:** see every file that has to change, then rerun to confirm nothing
  was missed.
- **As a CI gate:** fail a pull request that updates `.nvmrc` but not the Dockerfile, or that
  raises `requires-python` while CI still tests an older Python.
- **When joining a project:** `verdrift --local` lists what the repository expects and whether
  the runtimes on your machine match.
- **Auditing many repositories:** `--format json` gives the declarations and problems in a stable
  shape for scripts.

## What it reads

| Runtime | Files and fields |
| --- | --- |
| Node.js | `.nvmrc`, `.node-version`, `package.json` (`engines.node`, `volta.node`, `devEngines.runtime`), `node:` images |
| Python | `.python-version`, `runtime.txt`, `pyproject.toml` (`requires-python`, `tool.poetry.dependencies.python`), `setup.cfg` (`options.python_requires`), `python:` images |
| Go | `.go-version`, `go.mod` (`go`, `toolchain`), `golang:` images |
| All | `.tool-versions` (asdf), `mise.toml`, Dockerfiles (`FROM`, including `ARG` defaults), Compose files, GitHub Actions workflows (`actions/setup-node`, `setup-python`, `setup-go`, matrices, job containers), `.gitlab-ci.yml` |

Inside a git repository verdrift only reads files that git tracks or would track, so anything in
`.gitignore` is skipped. `node_modules`, `vendor`, virtualenvs, and build output are always
skipped.

## How it decides

Each declaration plays one of three roles:

- **range:** what the project supports (`engines.node`, `requires-python`, the `go` line in
  `go.mod`).
- **pin:** the version something actually uses (version files, `volta`, `toolchain`, base images).
- **ci:** a version a CI job runs.

verdrift reports four kinds of problems:

| Rule | Meaning |
| --- | --- |
| `pin-mismatch` | Two pins name different versions. Each pin is compared with the dedicated version file (`.nvmrc`, `.python-version`, …) when there is one. |
| `outside-range` | A pin or CI version is excluded by a range declared in the same directory or above it. |
| `range-conflict` | Two ranges have no version in common. |
| `yaml-number` | A CI version is an unquoted YAML number that changes when parsed, such as `3.10` becoming `3.1`. |

A conflict is reported only when no version could satisfy both sides. `20` and `20.11.1`
agree, `>=18` and `22` agree, and `20.11` and `20.12` do not. Ranges use the rules of the
ecosystem they come from: npm semver for `engines`, PEP 440 for `requires-python` (where
`<=3.12` excludes 3.12.5, as it does for pip), and "at least" for the `go` directive.

CI versions are checked against ranges but not against pins, because jobs often run a specific
version on purpose. A range in a subdirectory, such as `packages/web/package.json` in a monorepo,
only applies to files under that directory.

Values that move over time, such as `lts/*`, `latest`, or `${{ env.NODE }}`, are listed as
skipped with the reason, never silently dropped. Named LTS aliases like `lts/iron` are resolved.

## Use in GitHub Actions

```yaml
- uses: actions/setup-node@v7
  with:
    node-version: 24
- run: npx --yes github:thanatchon36/verdrift#v0.1.0 --format github
```

`--format github` turns each problem into a workflow annotation that points at the offending file
and line. Pin the tag (`#v0.1.0`) so a new release can't change your CI unexpectedly.

## Use from a coding agent

The `runtime-drift` skill in [thanatchon36/skills](https://github.com/thanatchon36/skills) runs
verdrift v0.1.0 for you, then proposes the smallest set of edits that makes the pins agree. If
Node 22 or network access isn't available, it falls back to a manual checklist. Install it in
Claude Code with:

```text
/plugin marketplace add thanatchon36/skills
/plugin install thanatchon-skills@thanatchon
```

## Options

```text
Usage: verdrift [dir] [options]

Find every place a repo declares a Node, Python, or Go version and report where they disagree.

Options:
  --format <text|json|github>  output format (default: text; github emits Actions annotations)
  --local                      also check the runtimes installed on this machine
  --ignore <glob>              skip matching paths, e.g. --ignore 'examples/**' (repeatable)
  -h, --help                   show this help
  -v, --version                show the version

Exit codes: 0 no problems, 1 problems found, 2 usage error.
```

`--ignore` is the escape hatch for intentional differences, for example a workflow that tests
your package on old Node versions on purpose: `--ignore .github/workflows/legacy.yml`.

`--local` compares the installed `node`, `python3` (or `python`), and `go` with the ranges and
the developer-facing pins (version files and tool configs). Base images and CI versions are not
expected to match your machine. Commands run in the scanned directory so that asdf, mise, and
Volta shims resolve as they would for you there. `go` runs with `GOTOOLCHAIN=local`, so it never
downloads a toolchain.

To install it permanently instead of using `npx`:

```sh
npm install --global github:thanatchon36/verdrift
```

## Limitations

- Only Node.js, Python, and Go. Pre-release tags (`3.14.0rc1`) are compared by their release
  numbers.
- Values computed at build time (a build `ARG` without a default, a matrix produced by
  `fromJSON`) can't be checked and are listed as skipped.
- `.python-version` and `.tool-versions` can list several versions; only the first is used.
- In a monorepo, pins are compared across the whole repository. A package that deliberately uses
  another version needs `--ignore`.
- There is no configuration file yet; `--ignore` on the command line is the only way to exclude
  files.

## Roadmap

- More runtimes: Ruby (`.ruby-version`, `Gemfile`), Java, Rust (`rust-toolchain.toml`), .NET
  (`global.json`).
- More sources: `.devcontainer/devcontainer.json`, CircleCI, `netlify.toml`, Vercel, Kubernetes
  manifests.
- A report of supported versions that CI never tests (for example, `engines` allows 20 but CI
  only runs 22).
- An optional config file for per-directory ignores and policies.

## Contributing

Bug reports with a minimal reproduction are the most useful contribution: the files involved and
what verdrift printed. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and how to add a new
file type.

## License

[MIT](LICENSE)
