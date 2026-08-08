#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probes_graph.py — sondas sobre el grafo de importaciones.

Separado de probes.py para que ningun fichero pase de 500 LOC.

Cubre la categoria que las metricas de tamano y complejidad NO ven: la FORMA
del codigo. Son "tests de arquitectura" — deterministas, con exit code, y sin
opinion de por medio:

  import_cycles  ciclos de importacion (A -> B -> A)
  layer_rules    dependencias que van en la direccion prohibida
  dead_exports   exports que nadie usa fuera de su propio fichero

Todo stdlib, sintaxis <=3.9.
"""

import os
import re

TS_IMPORT = re.compile(
    r"""(?:from|require\s*\(|import)\s*['"]([^'"]+)['"]""")
PY_IMPORT = re.compile(
    r"""^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))""", re.M)

TS_EXPORT = re.compile(
    r"""^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+"""
    r"""([A-Za-z_]\w*)""", re.M)

# Exports que el framework consume por convencion: nadie los importa a mano y
# no son codigo muerto. Ampliable con cfg["ignore_exports"].
FRAMEWORK_EXPORTS = set("""
default metadata generateMetadata generateStaticParams generateViewport
revalidate dynamic dynamicParams runtime fetchCache preferredRegion maxDuration
GET POST PUT DELETE PATCH HEAD OPTIONS viewport alt size contentType config
middleware loader
""".split())


def _walk(root, cfg):
    """Devuelve {ruta_relativa: contenido} respetando include/exclude."""
    from probes import iter_files
    out = {}
    for rel in iter_files(root, cfg.get("include", []), cfg.get("exclude", [])):
        try:
            with open(os.path.join(root, rel), "r", encoding="utf-8",
                      errors="ignore") as fh:
                out[rel] = fh.read()
        except Exception:
            continue
    return out


# ── Resolucion de imports ───────────────────────────────────────────────────


def _resolve_ts(spec, frm, files, aliases):
    base = None
    for prefix, target in aliases.items():
        if spec.startswith(prefix):
            base = os.path.normpath(target + spec[len(prefix):])
            break
    if base is None:
        if spec.startswith("."):
            base = os.path.normpath(os.path.join(os.path.dirname(frm), spec))
        else:
            return None  # paquete externo
    for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs"):
        if base + ext in files:
            return base + ext
    for idx in ("index.ts", "index.tsx", "index.js"):
        cand = os.path.join(base, idx)
        if cand in files:
            return cand
    return base if base in files else None


def _resolve_py(mod, files, source_roots):
    parts = mod.split(".")
    for sr in source_roots:
        cand = os.path.join(sr, *parts) + ".py"
        if cand in files:
            return cand
        cand = os.path.join(sr, *parts) + os.sep + "__init__.py"
        if cand in files:
            return cand
    return None


def _build_graph(files, cfg):
    aliases = cfg.get("aliases", {"@/": "src/"})
    source_roots = cfg.get("source_roots", ["src", "."])
    graph = {}
    for rel, text in files.items():
        deps = set()
        if rel.endswith(".py"):
            for a, b in PY_IMPORT.findall(text):
                target = _resolve_py(a or b, files, source_roots)
                if target and target != rel:
                    deps.add(target)
        else:
            for spec in TS_IMPORT.findall(text):
                target = _resolve_ts(spec, rel, files, aliases)
                if target and target != rel:
                    deps.add(target)
        graph[rel] = deps
    return graph


# ── Sondas ──────────────────────────────────────────────────────────────────


def probe_import_cycles(cfg, root):
    """Ciclos de importacion.

    La clave es el CONJUNTO de nodos del ciclo, ordenado: asi el mismo ciclo
    produce la misma clave independientemente de por donde se entre, y no
    cambia si alguien reordena los imports.
    """
    files = _walk(root, cfg)
    graph = _build_graph(files, cfg)

    found = set()
    state = {}

    def dfs(node, stack):
        state[node] = 1
        stack.append(node)
        for nxt in sorted(graph.get(node, ())):
            if state.get(nxt) == 1:
                ring = stack[stack.index(nxt):]
                found.add(" | ".join(sorted(set(ring))))
            elif state.get(nxt) is None:
                dfs(nxt, stack)
        stack.pop()
        state[node] = 2

    for node in sorted(graph):
        if state.get(node) is None:
            dfs(node, [])

    keys = ["ciclo :: " + f for f in sorted(found)]
    return sorted(keys), len(files)


def probe_layer_rules(cfg, root):
    """Dependencias en direccion prohibida.

    cfg["rules"]: lista de {"from": prefijo, "forbid": [prefijos]}.
    Ej: lo de dentro (lib) no puede depender de lo de fuera (app, components).
    """
    files = _walk(root, cfg)
    graph = _build_graph(files, cfg)
    rules = cfg.get("rules", [])
    keys = []
    for src, deps in graph.items():
        for rule in rules:
            if not src.startswith(rule.get("from", "\0")):
                continue
            for dep in deps:
                for bad in rule.get("forbid", []):
                    if dep.startswith(bad):
                        keys.append("capa :: %s -> %s" % (src, dep))
    return sorted(set(keys)), len(files)


def probe_dead_exports(cfg, root):
    """Exports que nadie referencia fuera de su propio fichero.

    Es una COTA SUPERIOR: un regex no distingue una API publica deliberada de
    codigo muerto. Da igual — con trinquete no hace falta que sea exacta: lo
    que importa es que el numero no suba.
    """
    files = _walk(root, cfg)
    ignore = FRAMEWORK_EXPORTS | set(cfg.get("ignore_exports", []))

    declared = []
    for rel, text in files.items():
        if rel.endswith(".py"):
            for m in re.finditer(r"^(?:def|class)\s+([A-Za-z_]\w*)", text, re.M):
                if not m.group(1).startswith("_"):
                    declared.append((m.group(1), rel))
        else:
            for name in TS_EXPORT.findall(text):
                declared.append((name, rel))

    # Indice invertido identificador -> ficheros que lo mencionan.
    # Un regex por nombre contra cada fichero es O(n*m) y tardaba 50s en un
    # repo de 460 ficheros; tokenizar una vez lo deja en decimas.
    IDENT = re.compile(r"[A-Za-z_]\w*")
    where = {}
    for rel, text in files.items():
        for tok in set(IDENT.findall(text)):
            where.setdefault(tok, set()).add(rel)

    keys = []
    for name, home in declared:
        if name in ignore:
            continue
        hits = where.get(name, set())
        if not (hits - {home}):
            keys.append("%s :: %s" % (home, name))
    return sorted(set(keys)), len(declared)


GRAPH_BUILTINS = {
    "import_cycles": probe_import_cycles,
    "layer_rules": probe_layer_rules,
    "dead_exports": probe_dead_exports,
}
