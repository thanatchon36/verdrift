// Extract runtime version declarations from the files that commonly carry them.
// Each extractor gets the file's repo-relative path and text and reports through a Collector.

import { parse as parseToml } from "smol-toml";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { interpretImage, interpretVersion } from "./interpret.js";
import { parseNpmRange, parsePep440 } from "./versions.js";

/** @typedef {import("./interpret.js").Runtime} Runtime */
/** @typedef {import("./versions.js").VersionSet} VersionSet */
/**
 * pin:    "this exact release line is used here" (version files, images, a single CI version)
 * range:  "any version in this range is supported" (engines, requires-python, go.mod `go`)
 * ci:     "CI runs this version" (only checked against ranges: CI jobs often pick versions on purpose)
 * @typedef {"pin" | "range" | "ci"} Role
 */
/**
 * @typedef {object} Declaration
 * @property {Runtime} runtime
 * @property {string} file   repo-relative path with forward slashes
 * @property {number} line   1-based
 * @property {string} where  what in the file declares it, e.g. "engines.node", "FROM node:20"
 * @property {string} raw    the value as written
 * @property {Role} role
 * @property {VersionSet | null} set  null when skipped
 * @property {string} [skip] why the value could not be interpreted
 */
/**
 * @typedef {object} Problem
 * @property {string} rule
 * @property {string} file
 * @property {number} line   0 when not tied to a file (--local)
 * @property {Runtime} runtime
 * @property {string} [value] the offending value as written, when the problem is about one declaration
 * @property {string} message
 */

export class Collector {
  constructor() {
    /** @type {Declaration[]} */
    this.declarations = [];
    /** @type {Problem[]} */
    this.problems = [];
    /** @type {{ file: string, message: string }[]} files verdrift could not read */
    this.warnings = [];
  }

  /**
   * @param {Omit<Declaration, "set" | "skip">} decl
   * @param {import("./interpret.js").Interpretation | { set: VersionSet | null } } interpretation
   */
  add(decl, interpretation) {
    if ("skip" in interpretation) {
      this.declarations.push({ ...decl, set: null, skip: interpretation.skip });
    } else if (interpretation.set === null) {
      this.declarations.push({ ...decl, set: null, skip: `could not parse "${decl.raw}"` });
    } else {
      this.declarations.push({ ...decl, set: interpretation.set });
    }
  }

  /** @param {Problem} problem */
  problem(problem) {
    this.problems.push(problem);
  }
}

/** @param {string} text @param {number} index */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Line of the first line matching `re`, or 1. @param {string} text @param {RegExp} re */
function findLine(text, re) {
  const m = re.exec(text);
  return m ? lineAt(text, m.index) : 1;
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------- version files

/** @type {Record<string, Runtime>} */
const VERSION_FILES = {
  ".nvmrc": "node",
  ".node-version": "node",
  ".python-version": "python",
  ".go-version": "go",
};

/** First meaningful line: version files may hold comments (nvm) or several versions (pyenv). */
/** @param {string} text @returns {{ value: string, line: number } | null} */
function firstValue(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const value = lines[i].replace(/#.*/, "").trim();
    if (value) return { value, line: i + 1 };
  }
  return null;
}

/** @param {Collector} c @param {string} file @param {string} text @param {Runtime} runtime */
function versionFile(c, file, text, runtime) {
  const first = firstValue(text);
  if (!first) return;
  c.add(
    { runtime, file, line: first.line, where: "", raw: first.value, role: "pin" },
    interpretVersion(runtime, first.value),
  );
}

/** Heroku-style runtime.txt: "python-3.12.4". @param {Collector} c @param {string} file @param {string} text */
function runtimeTxt(c, file, text) {
  const first = firstValue(text);
  if (!first || !/^python-/i.test(first.value)) return;
  c.add(
    { runtime: "python", file, line: first.line, where: "", raw: first.value, role: "pin" },
    interpretVersion("python", first.value),
  );
}

/** @type {Record<string, Runtime>} */
const TOOL_NAMES = { node: "node", nodejs: "node", python: "python", go: "go", golang: "go" };

/** asdf/mise .tool-versions: "nodejs 20.11.1", "python 3.12.1 3.11.6" (first is primary). */
/** @param {Collector} c @param {string} file @param {string} text */
function toolVersions(c, file, text) {
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const [tool, version] = rawLine.replace(/#.*/, "").trim().split(/\s+/);
    const runtime = TOOL_NAMES[tool];
    if (!runtime || !version) return;
    c.add({ runtime, file, line: i + 1, where: tool, raw: version, role: "pin" }, interpretVersion(runtime, version));
  });
}

/** mise.toml: [tools] node = "22", python = ["3.12", "3.11"], go = { version = "1.23" } */
/** @param {Collector} c @param {string} file @param {string} text */
function miseToml(c, file, text) {
  const tools = /** @type {Record<string, unknown>} */ (parseToml(text).tools ?? {});
  for (const [tool, spec] of Object.entries(tools)) {
    const runtime = TOOL_NAMES[tool];
    if (!runtime) continue;
    let value = Array.isArray(spec) ? spec[0] : spec;
    if (value && typeof value === "object") value = /** @type {{ version?: unknown }} */ (value).version;
    if (typeof value !== "string") continue;
    const line = findLine(text, new RegExp(`^\\s*"?${escapeRe(tool)}"?\\s*=`, "m"));
    c.add({ runtime, file, line, where: `tools.${tool}`, raw: value, role: "pin" }, interpretVersion(runtime, value));
  }
}

// ---------------------------------------------------------------- manifests

/** @param {Collector} c @param {string} file @param {string} text */
function packageJson(c, file, text) {
  /** @type {any} */
  const pkg = JSON.parse(text);
  /** @param {string} key */
  const keyLine = (key) => findLine(text, new RegExp(`"${escapeRe(key)}"\\s*:`));

  if (typeof pkg.engines?.node === "string") {
    const raw = pkg.engines.node;
    c.add(
      { runtime: "node", file, line: lineOfNested(text, "engines", "node"), where: "engines.node", raw, role: "range" },
      { set: parseNpmRange(raw) },
    );
  }
  if (typeof pkg.volta?.node === "string") {
    const raw = pkg.volta.node;
    c.add(
      { runtime: "node", file, line: lineOfNested(text, "volta", "node"), where: "volta.node", raw, role: "pin" },
      interpretVersion("node", raw),
    );
  }
  const runtimes = pkg.devEngines?.runtime;
  for (const rt of Array.isArray(runtimes) ? runtimes : runtimes ? [runtimes] : []) {
    if (rt?.name !== "node" || typeof rt.version !== "string") continue;
    c.add(
      {
        runtime: "node",
        file,
        line: keyLine("devEngines"),
        where: "devEngines.runtime",
        raw: rt.version,
        role: "range",
      },
      { set: parseNpmRange(rt.version) },
    );
  }
}

/** Line of `"inner":` that follows `"outer":` in a JSON text. @param {string} text @param {string} outer @param {string} inner */
function lineOfNested(text, outer, inner) {
  const m = new RegExp(`"${outer}"\\s*:\\s*\\{[^}]*?"${inner}"\\s*:`).exec(text);
  if (!m) return 1;
  return lineAt(text, m.index + m[0].lastIndexOf(`"${inner}"`));
}

/** @param {Collector} c @param {string} file @param {string} text */
function pyprojectToml(c, file, text) {
  /** @type {any} */
  const doc = parseToml(text);
  const requires = doc.project?.["requires-python"];
  if (typeof requires === "string") {
    c.add(
      {
        runtime: "python",
        file,
        line: findLine(text, /^\s*requires-python\s*=/m),
        where: "requires-python",
        raw: requires,
        role: "range",
      },
      { set: parsePep440(requires) },
    );
  }
  const poetry = doc.tool?.poetry?.dependencies?.python;
  if (typeof poetry === "string") {
    c.add(
      {
        runtime: "python",
        file,
        line: findLine(text, /^\s*python\s*=/m),
        where: "tool.poetry.dependencies.python",
        raw: poetry,
        role: "range",
      },
      // Poetry accepts both npm-style (^3.10) and PEP 440 (>=3.10,<4) constraints.
      { set: /[!~]=|==/.test(poetry) ? parsePep440(poetry) : parseNpmRange(poetry) },
    );
  }
}

/** setup.cfg: the Python range in the standard [options] section. @param {Collector} c @param {string} file @param {string} text */
function setupCfg(c, file, text) {
  let section = "";
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(rawLine);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section !== "options") continue;
    const valueMatch = /^\s*python_requires\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!valueMatch?.[1]) continue;
    const raw = valueMatch[1];
    c.add(
      { runtime: "python", file, line: i + 1, where: "options.python_requires", raw, role: "range" },
      { set: parsePep440(raw) },
    );
  }
}

/** go.mod: `go 1.22` is the minimum Go version (Go >= 1.21 enforces it); `toolchain go1.22.3` is a pin. */
/** @param {Collector} c @param {string} file @param {string} text */
function goMod(c, file, text) {
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const m = /^(go|toolchain)\s+(\S+)/.exec(rawLine.replace(/\/\/.*/, "").trim());
    if (!m) return;
    const [, directive, raw] = m;
    if (directive === "go") {
      c.add(
        { runtime: "go", file, line: i + 1, where: "go directive (minimum)", raw, role: "range" },
        { set: parseNpmRange(`>=${raw}`) },
      );
    } else if (raw !== "default") {
      c.add({ runtime: "go", file, line: i + 1, where: "toolchain", raw, role: "pin" }, interpretVersion("go", raw));
    }
  });
}

// ---------------------------------------------------------------- containers

/**
 * Dockerfile FROM lines, resolving ${ARG} defaults declared earlier in the file.
 * @param {Collector} c @param {string} file @param {string} text
 */
function dockerfile(c, file, text) {
  /** @type {Record<string, string>} */
  const args = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const startLine = i + 1;
    while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i]}`;
    const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=("?)([^"\s]*)\2/i.exec(line);
    if (arg) args[arg[1]] = arg[3];
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(line);
    if (!from) continue;
    const written = from[1];
    const image = written.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}?/g, (_, name, fallback) => {
      return args[name] ?? fallback ?? `\${${name}}`;
    });
    if (image.includes("${")) {
      const found = interpretImage(image.replace(/\$\{[^}]*\}/g, "x"));
      if (found)
        c.add(
          { runtime: found.runtime, file, line: startLine, where: `FROM ${written}`, raw: written, role: "pin" },
          { skip: "image tag comes from a build arg without a default" },
        );
      continue;
    }
    addImage(c, file, startLine, `FROM ${image}`, image, "pin");
  }
}

/**
 * @param {Collector} c @param {string} file @param {number} line @param {string} where @param {string} image
 * @param {Role} role
 */
function addImage(c, file, line, where, image, role) {
  const found = interpretImage(image);
  if (!found) return;
  const tag = image.split("@")[0].split("/").pop()?.split(":")[1] ?? "";
  c.add({ runtime: found.runtime, file, line, where, raw: tag || image, role }, found);
}

// ---------------------------------------------------------------- YAML-based files

/** @param {string} text */
function loadYaml(text) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  /** @param {any} node */
  const lineOf = (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : 1);
  return { doc, lineOf };
}

/** @param {any} map @param {string} key */
function get(map, key) {
  return isMap(map) ? map.get(key, true) : undefined;
}

/** @param {Collector} c @param {string} file @param {string} text */
function composeFile(c, file, text) {
  const { doc, lineOf } = loadYaml(text);
  const services = get(doc.contents, "services");
  if (!isMap(services)) return;
  for (const pair of services.items) {
    const image = get(pair.value, "image");
    if (isScalar(image) && typeof image.value === "string") {
      addImage(c, file, lineOf(image), `services.${String(pair.key)}.image`, image.value, "pin");
    }
  }
}

/** @param {Collector} c @param {string} file @param {string} text */
function gitlabCi(c, file, text) {
  const { doc, lineOf } = loadYaml(text);
  if (!isMap(doc.contents)) return;
  /** @param {any} node @param {string} where */
  const visitImage = (node, where) => {
    const image = isMap(node) ? get(node, "name") : node;
    if (isScalar(image) && typeof image.value === "string") addImage(c, file, lineOf(image), where, image.value, "ci");
  };
  for (const pair of doc.contents.items) {
    const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
    if (key === "image") visitImage(pair.value, "image");
    else if (isMap(pair.value)) visitImage(get(pair.value, "image"), `${key}.image`);
  }
}

/** @type {Record<string, { runtime: Runtime, input: string }>} */
const SETUP_ACTIONS = {
  "actions/setup-node": { runtime: "node", input: "node-version" },
  "actions/setup-python": { runtime: "python", input: "python-version" },
  "actions/setup-go": { runtime: "go", input: "go-version" },
};

/**
 * GitHub Actions workflows: setup-node/python/go inputs (resolving ${{ matrix.x }}) and job container images.
 * @param {Collector} c @param {string} file @param {string} text
 */
function githubWorkflow(c, file, text) {
  const { doc, lineOf } = loadYaml(text);
  const jobs = get(doc.contents, "jobs");
  if (!isMap(jobs)) return;
  for (const jobPair of jobs.items) {
    const job = jobPair.value;
    const jobName = String(isScalar(jobPair.key) ? jobPair.key.value : jobPair.key);

    const container = get(job, "container");
    const containerImage = isMap(container) ? get(container, "image") : container;
    if (isScalar(containerImage) && typeof containerImage.value === "string") {
      addImage(c, file, lineOf(containerImage), `jobs.${jobName}.container`, containerImage.value, "ci");
    }

    const steps = get(job, "steps");
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      const uses = get(step, "uses");
      if (!isScalar(uses) || typeof uses.value !== "string") continue;
      const actionName = uses.value.split("@")[0];
      const action = SETUP_ACTIONS[actionName];
      if (!action) continue;
      const input = get(get(step, "with"), action.input);
      if (!isScalar(input) || input.value === null) continue;
      const short = actionName.replace("actions/", "");

      const matrixRef = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(String(input.value).trim());
      if (!matrixRef) {
        addScalar(c, file, lineOf, input, action.runtime, `${short} ${action.input}`);
        continue;
      }
      const key = matrixRef[1];
      const where = `${short} matrix.${key}`;
      const nodes = matrixValues(get(get(job, "strategy"), "matrix"), key);
      for (const node of nodes) addScalar(c, file, lineOf, node, action.runtime, where);
      if (nodes.length === 0) {
        c.add(
          { runtime: action.runtime, file, line: lineOf(input), where, raw: String(input.value), role: "ci" },
          { skip: `jobs.${jobName} has no literal list for matrix.${key}` },
        );
      }
    }
  }
}

/** Scalars listed for `key` in a strategy.matrix, including `include:` entries. @param {any} matrix @param {string} key */
function matrixValues(matrix, key) {
  /** @type {any[]} */
  const nodes = [];
  if (!isMap(matrix)) return nodes;
  const list = get(matrix, key);
  if (isSeq(list)) nodes.push(...list.items);
  else if (isScalar(list)) nodes.push(list);
  const include = get(matrix, "include");
  if (isSeq(include)) {
    for (const entry of include.items) if (isScalar(get(entry, key))) nodes.push(get(entry, key));
  }
  return nodes.filter((n) => isScalar(n) && n.value !== null);
}

/**
 * One version input or matrix entry. A YAML number that changes meaning when parsed
 * (`3.10` becomes 3.1) is reported as its own problem instead of being interpreted.
 * @param {Collector} c @param {string} file @param {(n: any) => number} lineOf @param {any} node
 * @param {Runtime} runtime @param {string} where
 */
function addScalar(c, file, lineOf, node, runtime, where) {
  const line = lineOf(node);
  const value = String(node.value);
  const written = node.source ?? value;
  if (typeof node.value === "number" && value !== written) {
    c.problem({
      rule: "yaml-number",
      file,
      line,
      runtime,
      value: written,
      message: `${runtime} ${written} (${where}) is a YAML number, so the action receives "${value}". Quote it: '${written}'`,
    });
    c.add({ runtime, file, line, where, raw: written, role: "ci" }, { skip: "unquoted YAML number, see problem" });
    return;
  }
  if (value.includes("${{")) {
    c.add({ runtime, file, line, where, raw: value, role: "ci" }, { skip: "value comes from a workflow expression" });
    return;
  }
  // setup-python and setup-node accept several versions, one per line.
  const values = value.split(/\r?\n/).filter((v) => v.trim());
  for (const v of values) {
    c.add({ runtime, file, line, where, raw: v.trim(), role: "ci" }, interpretVersion(runtime, v));
  }
}

// ---------------------------------------------------------------- routing

/**
 * Pick the extractor for a repo-relative path, or null if verdrift doesn't read that file.
 * @param {string} path
 * @returns {((c: Collector, file: string, text: string) => void) | null}
 */
export function extractorFor(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const runtime = VERSION_FILES[base];
  if (runtime) return (c, file, text) => versionFile(c, file, text, runtime);
  if (base === "runtime.txt") return runtimeTxt;
  if (base === ".tool-versions") return toolVersions;
  if (/^\.?mise(\.local)?\.toml$/.test(base) || path.endsWith(".config/mise/config.toml")) return miseToml;
  if (base === "package.json") return packageJson;
  if (base === "pyproject.toml") return pyprojectToml;
  if (base === "setup.cfg") return setupCfg;
  if (base === "go.mod") return goMod;
  if (/^(Dockerfile|Containerfile)(\..+)?$/.test(base) || /\.(Dockerfile|dockerfile)$/.test(base)) {
    // Dockerfile.dev and Dockerfile.prod are Dockerfiles; Dockerfile.ts or Dockerfile.md are not.
    return /\.(md|txt|[cm]?[jt]sx?|py|go|rs|json|ya?ml|toml|sh|bak|orig|swp)$/i.test(base) ? null : dockerfile;
  }
  if (/^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/.test(base)) return composeFile;
  if (base === ".gitlab-ci.yml") return gitlabCi;
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return githubWorkflow;
  return null;
}
