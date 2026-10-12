import assert from "node:assert/strict";
import { test } from "node:test";
import { extractorFor } from "../src/sources.js";
import { extract, summarize } from "./helpers.js";

test("routes only the files verdrift understands", () => {
  for (const path of [
    ".nvmrc",
    "web/.node-version",
    ".python-version",
    ".go-version",
    "runtime.txt",
    ".tool-versions",
    "mise.toml",
    ".mise.toml",
    ".config/mise/config.toml",
    "package.json",
    "pyproject.toml",
    "setup.cfg",
    "go.mod",
    "Dockerfile",
    "Dockerfile.dev",
    "api.Dockerfile",
    "Containerfile",
    "compose.yaml",
    "docker-compose.prod.yml",
    ".gitlab-ci.yml",
    ".github/workflows/ci.yml",
  ]) {
    assert.ok(extractorFor(path), `${path} should be read`);
  }
  for (const path of ["README.md", "package-lock.json", "workflows/ci.yml", "src/Dockerfile.ts", "go.sum"]) {
    assert.equal(extractorFor(path), null, `${path} should be ignored`);
  }
});

test(".nvmrc: comments, v prefix, LTS codenames, floating aliases", () => {
  assert.deepEqual(summarize(extract(".nvmrc", "# team node\nv22.11.0\n").declarations), ["node pin v22.11.0 @2"]);
  const iron = extract(".nvmrc", "lts/iron\n").declarations[0];
  assert.ok(iron.set && !iron.skip, "lts/iron resolves to Node 20");
  const star = extract(".nvmrc", "lts/*\n").declarations[0];
  assert.match(star.skip ?? "", /floats/);
  assert.equal(extract(".nvmrc", "\n\n").declarations.length, 0);
});

test(".python-version uses the first version; runtime.txt strips the python- prefix", () => {
  assert.deepEqual(summarize(extract(".python-version", "3.12.4\n3.11.9\n").declarations), ["python pin 3.12.4 @1"]);
  assert.deepEqual(summarize(extract("runtime.txt", "python-3.11.6\n").declarations), ["python pin python-3.11.6 @1"]);
  assert.match(extract(".python-version", "pypy3.10-7.3.12\n").declarations[0].skip ?? "", /not a version/);
});

test(".tool-versions reads node/nodejs, python, golang lines", () => {
  const c = extract(
    ".tool-versions",
    "nodejs 20.11.1\n# comment\npython 3.12.1 3.11.6\nterraform 1.7.0\ngolang 1.22.2\n",
  );
  assert.deepEqual(summarize(c.declarations), ["node pin 20.11.1 @1", "python pin 3.12.1 @3", "go pin 1.22.2 @5"]);
});

test("mise.toml supports strings, arrays, and tables", () => {
  const text = '[tools]\nnode = "22"\npython = ["3.12", "3.11"]\ngo = { version = "1.23" }\nterraform = "1.7"\n';
  assert.deepEqual(summarize(extract("mise.toml", text).declarations), [
    "node pin 22 @2",
    "python pin 3.12 @3",
    "go pin 1.23 @4",
  ]);
});

test("package.json: engines (range), volta (pin), devEngines.runtime (range)", () => {
  const text = JSON.stringify(
    {
      name: "x",
      engines: { npm: ">=10", node: ">=20 <23" },
      volta: { node: "22.11.0" },
      devEngines: { runtime: { name: "node", version: "^22" } },
    },
    null,
    2,
  );
  assert.deepEqual(summarize(extract("package.json", text).declarations), [
    "node range >=20 <23 @5",
    "node pin 22.11.0 @8",
    "node range ^22 @10",
  ]);
});

test("package.json with an unparseable engines range is listed as skipped", () => {
  const d = extract("package.json", '{"engines":{"node":"lts"}}').declarations[0];
  assert.equal(d.set, null);
  assert.match(d.skip ?? "", /could not parse/);
});

test("pyproject.toml: requires-python and Poetry python constraints", () => {
  const text =
    '[project]\nname = "x"\nrequires-python = ">=3.10,<3.13"\n\n[tool.poetry.dependencies]\npython = "^3.10"\n';
  assert.deepEqual(summarize(extract("pyproject.toml", text).declarations), [
    "python range >=3.10,<3.13 @3",
    "python range ^3.10 @6",
  ]);
});

test("setup.cfg: python_requires in [options]", () => {
  const text = "[metadata]\npython_requires = >=3.9\n\n[options]\npython_requires = >=3.10\n";
  assert.deepEqual(summarize(extract("setup.cfg", text).declarations), ["python range >=3.10 @5"]);
});

test("setup.cfg: missing or unparseable python_requires", () => {
  assert.deepEqual(extract("setup.cfg", "[metadata]\npython_requires = >=3.9\n").declarations, []);
  const declaration = extract("setup.cfg", "[options]\npython_requires = any\n").declarations[0];
  assert.equal(declaration.set, null);
  assert.match(declaration.skip ?? "", /could not parse/);
});

test("go.mod: go directive is a minimum, toolchain is a pin", () => {
  const c = extract("go.mod", "module example.com/x\n\ngo 1.22.1 // minimum\n\ntoolchain go1.23.4\n");
  assert.deepEqual(summarize(c.declarations), ["go range 1.22.1 @3", "go pin go1.23.4 @5"]);
});

test("Dockerfile: FROM with flags, stages, digests, and ARG defaults", () => {
  const text = [
    "ARG NODE_VERSION=20.11",
    "FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build",
    "FROM docker.io/library/python:3.12-slim@sha256:abc123",
    "FROM golang:1.22",
    "FROM build AS final",
    "FROM node:lts-alpine",
    "FROM node",
    "FROM ubuntu:24.04",
  ].join("\n");
  assert.deepEqual(summarize(extract("Dockerfile", text).declarations), [
    "node pin 20.11-alpine @2",
    "python pin 3.12-slim @3",
    "go pin 1.22 @4",
    "node pin lts-alpine @6 skip",
    "node pin node @7 skip",
  ]);
});

test("Dockerfile: ARG without a default is skipped, ${VAR:-default} is resolved", () => {
  const text = "ARG PY\nFROM python:${PY}\nFROM python:${PY2:-3.11}-slim\n";
  assert.deepEqual(summarize(extract("Dockerfile", text).declarations), [
    "python pin python:${PY} @2 skip",
    "python pin 3.11-slim @3",
  ]);
});

test("compose: service images", () => {
  const text = "services:\n  api:\n    image: node:22-bookworm\n  db:\n    image: postgres:16\n";
  assert.deepEqual(summarize(extract("compose.yaml", text).declarations), ["node pin 22-bookworm @3"]);
});

test("GitLab CI: global, default, and job images", () => {
  const text = "image: python:3.12\ndefault:\n  image: python:3.11\ntest:\n  image:\n    name: node:20\n";
  assert.deepEqual(summarize(extract(".gitlab-ci.yml", text).declarations), [
    "python ci 3.12 @1",
    "python ci 3.11 @3",
    "node ci 20 @6",
  ]);
});

const WORKFLOW = `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    container: node:22-bookworm
    strategy:
      matrix:
        node: [20, "22"]
        include:
          - node: 24
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - uses: actions/setup-go@v5
        with:
          go-version: \${{ env.GO }}
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: |
            3.11
            3.12
`;

test("GitHub workflow: container, matrix (with include), literal inputs, expressions, multi-line", () => {
  const c = extract(".github/workflows/ci.yml", WORKFLOW);
  assert.deepEqual(summarize(c.declarations), [
    "node ci 22-bookworm @6",
    "node ci 20 @9",
    "node ci 22 @9",
    "node ci 24 @11",
    "python ci 3.12 @18",
    "go ci ${{ env.GO }} @21 skip",
    "python ci 3.11 @27",
    "python ci 3.12 @27",
  ]);
  assert.equal(c.problems.length, 0);
});

test("GitHub workflow: unquoted 3.10 is reported once and not interpreted as 3.1", () => {
  const text = `jobs:
  t:
    strategy:
      matrix:
        py: [3.9, 3.10]
    steps:
      - uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.py }}
      - uses: actions/setup-python@v5
        with:
          python-version: 3.10
`;
  const c = extract(".github/workflows/ci.yml", text);
  assert.deepEqual(
    c.problems.map((p) => `${p.rule}@${p.line}`),
    ["yaml-number@5", "yaml-number@12"],
  );
  assert.match(c.problems[0].message, /receives "3.1"/);
  assert.deepEqual(summarize(c.declarations), [
    "python ci 3.9 @5",
    "python ci 3.10 @5 skip",
    "python ci 3.10 @12 skip",
  ]);
});

test("GitHub workflow: matrix reference without a literal list is skipped, not dropped", () => {
  const text = `jobs:
  t:
    strategy:
      matrix: \${{ fromJSON(needs.setup.outputs.matrix) }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
`;
  const d = extract(".github/workflows/ci.yml", text).declarations;
  assert.deepEqual(summarize(d), ["node ci ${{ matrix.node }} @8 skip"]);
});
