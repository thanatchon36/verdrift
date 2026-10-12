# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Read Python version ranges from `setup.cfg`'s `[options] python_requires` field.

## [0.1.0] - 2026-10-12

### Added

- Find Node, Python, and Go version declarations in `.nvmrc`, `.node-version`,
  `.python-version`, `.go-version`, `runtime.txt`, `.tool-versions`, `mise.toml`,
  `package.json` (`engines`, `volta`, `devEngines`), `pyproject.toml` (`requires-python`,
  Poetry), `go.mod` (`go`, `toolchain`), Dockerfiles (with `ARG` defaults), Compose files,
  GitHub Actions workflows (`setup-node`/`setup-python`/`setup-go`, matrices, job
  containers), and `.gitlab-ci.yml`.
- Report pins that disagree, pins and CI versions outside a declared range, ranges with no
  common version, and unquoted YAML numbers such as `python-version: 3.10`.
- `--format json` and `--format github` (Actions annotations), `--ignore <glob>`, and
  `--local` to compare installed runtimes.

[0.1.0]: https://github.com/thanatchon36/verdrift/releases/tag/v0.1.0
