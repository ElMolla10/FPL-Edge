// Static CSS-usage analysis shared by scripts/audit-unused-css.mjs and tests/perf-css-split.test.mts.
//
// The stylesheet is split per route / per lazy panel (see docs/PERF-CSS.md). To decide which sheet a class
// belongs in (and to guard that a component's classes are still defined in a sheet that loads with it) we need to
// know, for every "unit" (a route entry or a lazy chunk entry), which CSS classes it can render.
//
// Method (conservative, i.e. it may over-attribute a class to a unit but must never miss one):
//   * Parse every app/**/*.ts(x) file with the TypeScript compiler API.
//   * Per function: every string / template literal word inside it is a candidate class; template prefixes
//     (`fdr-${n}`, "status-" + x) and suffixes (`${x}-bar`) match whole families; label slugs
//     (label.toLowerCase().replaceAll(" ", "-")) match too.
//   * A unit reaches the functions it (transitively) calls or renders by name, following static imports at
//     function granularity. `lazy(() => import(..))` / dynamic import() are NOT followed: those are other units.
//   * Module-level code (constants, arrays of class names) of every reached module counts for the unit.
//   * Plain .ts library files reached by import contribute all their literal words (class names returned by helpers).
//   * Relations used to keep the cascade intact: which classes can sit on ONE element ("same") and which can be
//     an ancestor of which ("nested"), across component boundaries.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postcss = require("postcss");

export const UNIT_ENTRIES = (appDir) => {
  const A = (...p) => path.join(appDir, ...p);
  return {
    landing: [A("page.tsx")],
    auth: [A("signin/page.tsx"), A("signup/page.tsx"), A("components/RouteLoading.tsx")],
    pay: [A("pay/page.tsx"), A("components/RouteLoading.tsx")],
    misc: [A("not-found.tsx"), A("error.tsx"), A("components/RouteLoading.tsx")],
    shell: [A("components/CoachApp.tsx")],
    team: [A("components/coach/TeamPanel.tsx")],
    transfers: [A("components/coach/TransfersPanel.tsx")],
    players: [A("components/coach/PlayersPanel.tsx")],
    coach: [A("components/coach/CoachPanel.tsx")],
    final: [A("components/coach/FinalCheckPanel.tsx")],
    plan: [A("components/coach/PlanPanels.tsx")],
    research: [A("components/coach/ResearchPanels.tsx")],
    draft: [A("components/LiveDraftBuilder.tsx")],
    league: [A("components/MiniLeagueWarRoom.tsx")],
  };
};
export const MARKETING_UNITS = new Set(["landing", "auth", "pay", "misc"]);
export const PANEL_UNITS = ["team", "transfers", "players", "coach", "final", "plan", "research", "draft", "league"];

const EXTS = [".tsx", ".ts", ".mts"];
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};
const wordsOf = (text, set) => {
  for (const w of text.split(/[^A-Za-z0-9_-]+/)) if (w) { set.lit.add(w); set.lit.add(w.toLowerCase()); }
  const slug = text.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  if (slug) set.lit.add(slug);
  for (const part of text.split(/[^A-Za-z0-9 _-]+/)) { const ps = part.trim().toLowerCase().replace(/\s+/g, "-"); if (ps) set.lit.add(ps); }
};
const newBag = () => ({ lit: new Set(), pre: new Set(), suf: new Set() });
const mergeBag = (a, b) => { b.lit.forEach((x) => a.lit.add(x)); b.pre.forEach((x) => a.pre.add(x)); b.suf.forEach((x) => a.suf.add(x)); };
/** Collect every literal word / template family inside `node` into `bag`. */
function collect(node, bag, skip) {
  (function v(x) {
    if (skip && skip(x)) return;
    if (ts.isStringLiteralLike(x)) wordsOf(x.text, bag);
    else if (ts.isTemplateExpression(x)) {
      wordsOf(x.head.text, bag);
      const m = /[A-Za-z0-9_-]*-$/.exec(x.head.text); if (m) bag.pre.add(m[0]);
      for (const sp of x.templateSpans) {
        wordsOf(sp.literal.text, bag);
        const mm = /^(-[A-Za-z0-9_-]+)/.exec(sp.literal.text); if (mm) bag.suf.add(mm[1]);
        const m2 = /[A-Za-z0-9_-]*-$/.exec(sp.literal.text); if (m2) bag.pre.add(m2[0]);
      }
    } else if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteralLike(x.left) && /-$/.test(x.left.text)) bag.pre.add(x.left.text.split(/[^A-Za-z0-9_-]+/).pop());
    ts.forEachChild(x, v);
  })(node);
}
const matches = (bag, c) => bag.lit.has(c) || bag.lit.has(c.toLowerCase()) || [...bag.pre].some((p) => p.length >= 3 && c.startsWith(p)) || [...bag.suf].some((s) => s.length >= 3 && c.endsWith(s));

export const classesIn = (selector) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);

/** Parse CSS text into the class universe. */
export function cssClassUniverse(texts) {
  const set = new Set();
  for (const text of texts) postcss.parse(text).walkRules((r) => {
    if (r.parent?.type === "atrule" && /keyframes$/.test(r.parent.name)) return;
    for (const c of classesIn(r.selector)) set.add(c);
  });
  return [...set];
}

export function analyze(appDir, cssTexts) {
  const files = walk(appDir).concat(fs.existsSync(path.join(appDir, "..", "worker")) ? walk(path.join(appDir, "..", "worker")) : []);
  const classes = cssClassUniverse(cssTexts);
  const idx = new Map(classes.map((c, i) => [c, i]));
  const N = classes.length;
  const resolveImp = (from, spec) => {
    if (!spec.startsWith(".") || spec.endsWith(".css")) return null; // stylesheet side-effect imports are not code
    const base = path.resolve(path.dirname(from), spec);
    for (const c of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, "index" + e))]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  };
  const mods = new Map(); const fns = [];
  for (const f of files) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const mod = { file: f, sf, funcs: new Map(), imports: new Map(), lazy: new Map(), loaders: new Map(), allWords: newBag(), moduleWords: newBag(), importFiles: [] };
    mods.set(f, mod);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const t = resolveImp(f, st.moduleSpecifier.text); if (!t) continue;
      const ic = st.importClause; if (ic?.isTypeOnly) continue;
      mod.importFiles.push(t);
      if (!ic) continue;
      if (ic.name) mod.imports.set(ic.name.text, { file: t, name: "default" });
      if (ic.namedBindings && ts.isNamedImports(ic.namedBindings)) for (const el of ic.namedBindings.elements) if (!el.isTypeOnly) mod.imports.set(el.name.text, { file: t, name: (el.propertyName || el.name).text });
    }
    for (const st of sf.statements) if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) { const t = resolveImp(f, st.moduleSpecifier.text); if (t) mod.importFiles.push(t); }
    collect(sf, mod.allWords);
    const add = (name, node) => { const rec = { file: f, name, node, bag: newBag(), callees: new Set(), refs: new Set(), elems: [], pairs: [], calleeDesc: [], compUses: [] }; if (!mod.funcs.has(name)) mod.funcs.set(name, []); mod.funcs.get(name).push(rec); fns.push(rec); collect(node, rec.bag); return rec; };
    const fnNodes = new Set();
    (function v(n) {
      if (ts.isFunctionDeclaration(n) && n.name) { add(n.name.text, n); fnNodes.add(n); }
      else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        let init = n.initializer; while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) { add(n.name.text, init); fnNodes.add(init); }
        else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "lazy") mod.lazy.set(n.name.text, init);
        if (/^load/.test(n.name.text)) { const m = /import\(\s*["']([^"']+)["']\s*\)/.exec(n.initializer.getText()); if (m) { const t = resolveImp(f, m[1]); if (t) mod.loaders.set(n.name.text, t); } }
      }
      ts.forEachChild(n, v);
    })(sf);
    // Module-level words: literals outside every registered function (constants, class-name tables, JSX in object literals).
    collect(sf, mod.moduleWords, (x) => fnNodes.has(x) || ts.isImportDeclaration(x) || ts.isExportDeclaration(x));
    mod.fnNodes = fnNodes;
  }
  const lazyTarget = (mod, name) => {
    const txt = mod.lazy.get(name)?.getText() ?? "";
    const m = /\b(load[A-Za-z]*)\b/.exec(txt); const t = m && mod.loaders.get(m[1]); if (t) return t;
    const m2 = /import\(\s*["']([^"']+)["']\s*\)/.exec(txt); return m2 ? resolveImp(mod.file, m2[1]) : null;
  };
  const defaultFns = (tmod) => {
    const out = [];
    for (const st of tmod.sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) out.push(...(tmod.funcs.get(st.name.text) || []));
      if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) out.push(...(tmod.funcs.get(st.expression.text) || []));
    }
    return out;
  };
  /** Resolve an identifier used in `file` to {fns:[...], lazy?:file, value?:file}. */
  const resolveName = (file, name) => {
    const mod = mods.get(file);
    if (mod.funcs.has(name)) return { fns: mod.funcs.get(name) };
    if (mod.lazy.has(name)) { const t = lazyTarget(mod, name); return t ? { lazy: t } : null; }
    const imp = mod.imports.get(name); if (!imp) return null;
    const tmod = mods.get(imp.file); if (!tmod) return null;
    if (imp.name === "default") { const d = defaultFns(tmod); return d.length ? { fns: d } : { value: imp.file }; }
    if (tmod.funcs.has(imp.name)) return { fns: tmod.funcs.get(imp.name) };
    return { value: imp.file };
  };
  const bagClasses = (bag) => { const out = new Set(); for (const [c, i] of idx) if (matches(bag, c)) out.add(i); return out; };
  const samePairs = [];
  for (const rec of fns) {
    const mod = mods.get(rec.file);
    const attrSet = (init) => {
      const bag = newBag(); let dynamic = false;
      const val = (x) => {
        if (!x) return;
        if (ts.isStringLiteralLike(x)) wordsOf(x.text, bag);
        else if (ts.isTemplateExpression(x)) { collect(x, bag); for (const sp of x.templateSpans) val(sp.expression); }
        else if (ts.isJsxExpression(x) || ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) val(x.expression);
        else if (ts.isConditionalExpression(x)) { val(x.whenTrue); val(x.whenFalse); }
        else if (ts.isBinaryExpression(x)) { if (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) val(x.right); else { val(x.left); val(x.right); } }
        else if (ts.isArrayLiteralExpression(x)) x.elements.forEach(val);
        else if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ["join", "filter", "trim", "toLowerCase", "toUpperCase", "replace", "replaceAll"].includes(x.expression.name.text)) val(x.expression.expression);
        else if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(x.kind) || ts.isNumericLiteral(x) || (ts.isIdentifier(x) && x.text === "undefined")) {}
        else dynamic = true;
      };
      val(init);
      if (dynamic) mergeBag(bag, mod.allWords); // value built elsewhere: assume any class of this file may land on the element
      return bagClasses(bag);
    };
    const visitEl = (n, anc) => {
      const opening = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
      const cls = new Set(); const attrExprs = []; const tag = opening ? opening.tagName.getText() : "";
      if (opening) for (const a of opening.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText() === "className" && a.initializer) attrSet(a.initializer).forEach((i) => cls.add(i));
        else if (ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression) attrExprs.push(a.initializer.expression);
      }
      if (cls.size) { rec.elems.push(cls); samePairs.push(cls); }
      const here = cls.size ? [...anc, cls] : anc;
      if (cls.size) for (const a of anc) { if (a.callee) rec.calleeDesc.push({ res: a.callee, cls }); else rec.pairs.push([a, cls]); }
      let comp = null;
      if (/^[A-Z]/.test(tag) || tag.includes(".")) { comp = resolveName(rec.file, tag.split(".")[0]); if (comp) { rec.callees.add(comp); rec.compUses.push({ ancestors: [...here], res: comp }); } }
      const childAnc = comp ? [...here, { callee: comp }] : here;
      const kids = ts.isJsxElement(n) || ts.isJsxFragment(n) ? n.children : [];
      for (const k of kids) walkJsx(k, ts.isJsxFragment(n) ? anc : childAnc);
      for (const x of attrExprs) walkJsx(x, childAnc);
    };
    const walkJsx = (x, anc) => { (function w(y) { if (ts.isJsxElement(y) || ts.isJsxSelfClosingElement(y) || ts.isJsxFragment(y)) visitEl(y, anc); else ts.forEachChild(y, w); })(x); };
    (function w(y) {
      if (ts.isJsxElement(y) || ts.isJsxSelfClosingElement(y) || ts.isJsxFragment(y)) { visitEl(y, []); return; }
      if (ts.isIdentifier(y)) { const r = resolveName(rec.file, y.text); if (r && !(r.fns && r.fns.includes(rec))) rec.refs.add(r); }
      ts.forEachChild(y, w);
    })(rec.node.body || rec.node);
    rec.ownClasses = bagClasses(rec.bag);
  }
  const moduleFns = (file) => [...(mods.get(file)?.funcs.values() || [])].flat();
  const resFns = (r, followLazy) => r.fns ? r.fns : r.lazy ? (followLazy ? moduleFns(r.lazy) : []) : [];
  // Function-level class closure including lazy children (used for the DOM-relation analysis only).
  const clo = new Map(fns.map((r) => [r, new Set(r.ownClasses)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const r of fns) { const cur = clo.get(r); const before = cur.size; for (const c of [...r.callees, ...r.refs]) for (const t of resFns(c, true)) for (const i of clo.get(t)) cur.add(i); if (cur.size !== before) changed = true; }
  }
  const resClasses = (r) => { const out = new Set(); for (const t of resFns(r, true)) for (const i of clo.get(t)) out.add(i); return out; };
  const nest = new Uint8Array(N * N); const same = new Uint8Array(N * N);
  for (const rec of fns) {
    for (const [a, b] of rec.pairs) for (const i of a) for (const j of b) nest[i * N + j] = 1;
    for (const d of rec.calleeDesc) for (const i of resClasses(d.res)) for (const j of d.cls) nest[i * N + j] = 1;
    for (const u of rec.compUses) { const cc = resClasses(u.res); for (const a of u.ancestors) { if (a.callee) { for (const i of resClasses(a.callee)) for (const j of cc) nest[i * N + j] = 1; } else for (const i of a) for (const j of cc) nest[i * N + j] = 1; } }
  }
  for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) if (nest[i * N + k]) for (let j = 0; j < N; j++) if (nest[k * N + j]) nest[i * N + j] = 1;
  for (const s of samePairs) { const a = [...s]; for (const i of a) for (const j of a) same[i * N + j] = 1; }
  const sameEl = (u, v) => { const i = idx.get(u), j = idx.get(v); return i === undefined || j === undefined || i === j || same[i * N + j] === 1; };
  const nested = (u, v) => { const i = idx.get(u), j = idx.get(v); return i === undefined || j === undefined || nest[i * N + j] === 1; };
  const related = (u, v) => sameEl(u, v) || nested(u, v) || nested(v, u);

  /** Classes a unit can render: function-granular reachability (lazy children excluded) + module-level words + reached lib words. */
  function unitClasses(entryFiles) {
    const seenFns = new Set(); const seenMods = new Set(); const libMods = new Set(); const q = [];
    for (const f of entryFiles) for (const r of moduleFns(f)) q.push(r);
    const touchMod = (f) => { if (seenMods.has(f)) return; seenMods.add(f); };
    for (const f of entryFiles) touchMod(f);
    while (q.length) {
      const r = q.pop(); if (seenFns.has(r)) continue; seenFns.add(r); touchMod(r.file);
      for (const c of [...r.callees, ...r.refs]) {
        if (c.value) { touchMod(c.value); }
        for (const t of resFns(c, false)) q.push(t);
      }
    }
    const bag = newBag();
    for (const r of seenFns) mergeBag(bag, r.bag);
    for (const f of seenMods) mergeBag(bag, mods.get(f).moduleWords);
    // plain library modules reached from any touched module
    const lq = [...seenMods];
    while (lq.length) { const f = lq.pop(); for (const t of mods.get(f)?.importFiles ?? []) { if (!/\.tsx$/.test(t) && !libMods.has(t)) { libMods.add(t); lq.push(t); } } }
    for (const f of libMods) mergeBag(bag, mods.get(f).allWords);
    const used = new Set(classes.filter((c) => matches(bag, c)));
    return { used, fnCount: seenFns.size, modules: [...seenMods], libs: [...libMods] };
  }
  return { classes, idx, sameEl, nested, related, unitClasses, mods, fns };
}
