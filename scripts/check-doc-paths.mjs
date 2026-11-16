#!/usr/bin/env node
// Checks that the compliance and clinical-safety documents only name things that exist:
//   - repository paths in backticks or links (src/..., mcp/..., scripts/..., prisma/..., tests/..., site/..., docs/...)
//   - HTTP endpoints ("GET /api/..." or `/api/...`), matched against the routes declared in src/lib/site/portalApi.ts
//     and src/server.ts (and the method, when the document gives one).
// Exit 1 with a list of what is missing. Run in CI:  node scripts/check-doc-paths.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DOC_DIRS = ["docs/compliance", "docs/clinical"];
const PATH_RE = /^(src|mcp|scripts|prisma|tests|site|docs|\.github)\/[\w.@/-]+$/;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Routes declared in the server source: [{ methods: string[] | null, test(path) }]. */
export function collectRoutes(root = ROOT) {
  const routes = [];
  const add = (methods, test, source) => routes.push({ methods: methods.length ? methods : null, test, source });
  for (const file of ["src/lib/site/portalApi.ts", "src/server.ts"]) {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
    let inPatientRoute = false;
    lines.forEach((line, i) => {
      if (/async function patientRoute\(/.test(line)) inPatientRoute = true;
      else if (inPatientRoute && /^ {2}(async )?function /.test(line)) inPatientRoute = false;
      const methods = [...line.matchAll(/method === '([A-Z]+)'/g)].map((m) => m[1]);
      const where = `${file}:${i + 1}`;
      for (const m of line.matchAll(/pathname === '(\/api\/[^']*)'/g)) add(methods, (p) => p === m[1], where);
      for (const m of line.matchAll(/pathname\.match\(\/(\^.*?\$)\/\)/g)) {
        if (/\(\.\*\)/.test(m[1])) continue; // catch-all prefixes (sub-routes are collected separately)
        const re = new RegExp(m[1]);
        add(methods, (p) => re.test(p), where);
      }
      if (inPatientRoute) {
        for (const m of line.matchAll(/sub === '([^']*)'/g)) {
          const full = `/api/patients/x${m[1] ? `/${m[1]}` : ""}`;
          add(methods, (p) => p === full, where);
        }
        for (const m of line.matchAll(/sub\.match\(\/\^(.*?)\$\/\)/g)) {
          const re = new RegExp(`^\\/api\\/patients\\/[^/]+\\/${m[1]}$`);
          add(methods, (p) => re.test(p), where);
        }
      }
    });
  }
  return routes;
}

/** "/api/patients/:id/records/{recordId}/flag?x=1" -> "/api/patients/x/records/x/flag" */
export const normaliseEndpoint = (p) => p.split("?")[0].replace(/\/$/, "").split("/")
  .map((seg) => (/^(:\w+|\{\w+\}|<[\w-]+>|\.\.\.)$/.test(seg) ? "x" : seg)).join("/");

export function checkFile(file, routes, root = ROOT) {
  const text = fs.readFileSync(file, "utf8");
  const problems = [];
  const rel = path.relative(root, file).replace(/\\/g, "/");
  // Repository paths in backticks.
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const candidate = m[1].replace(/[#:].*$/, "").replace(/[),.;]+$/, "");
    if (PATH_RE.test(candidate) && !fs.existsSync(path.join(root, candidate))) problems.push(`${rel}: path not found: ${candidate}`);
  }
  // Relative links to repository files.
  for (const m of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) problems.push(`${rel}: link target not found: ${m[1]}`);
  }
  // Endpoints, with or without a method.
  const seen = new Set();
  for (const m of text.matchAll(/(?:\b(GET|POST|PUT|PATCH|DELETE)\s+)?`?(\/api\/[A-Za-z0-9_\-/:{}<>.?=&]+)/g)) {
    const method = m[1] || null;
    const endpoint = normaliseEndpoint(m[2].replace(/[`.,)]+$/, ""));
    const key = `${method} ${endpoint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hits = routes.filter((r) => r.test(endpoint));
    if (!hits.length) problems.push(`${rel}: endpoint not found: ${method ? `${method} ` : ""}${m[2]}`);
    else if (method && METHODS.includes(method) && !hits.some((r) => !r.methods || r.methods.includes(method))) {
      problems.push(`${rel}: endpoint exists but not for ${method}: ${m[2]}`);
    }
  }
  return problems;
}

export function checkDocs({ root = ROOT, dirs = DOC_DIRS } = {}) {
  const routes = collectRoutes(root);
  const files = dirs.flatMap((d) => {
    const dir = path.join(root, d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f)) : [];
  });
  return { files: files.map((f) => path.relative(root, f).replace(/\\/g, "/")), problems: files.flatMap((f) => checkFile(f, routes, root)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, problems } = checkDocs();
  if (!files.length) { console.error("No documents found in " + DOC_DIRS.join(", ")); process.exit(1); }
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} reference(s) in ${files.length} document(s) do not exist.`);
    process.exit(1);
  }
  console.log(`OK: every path and endpoint named in ${files.length} document(s) exists.`);
}
