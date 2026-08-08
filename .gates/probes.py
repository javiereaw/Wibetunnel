#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probes.py — sondas, extracción de claves y almacén del baseline.

Compañero de gates.py. Separado para que ninguno de los dos pase de 500 LOC:
la herramienta que hace cumplir ese límite no puede incumplirlo.

Todo aquí es stdlib y sintaxis <=3.9.
"""

import fnmatch
import glob
import hashlib
import json
import os
import re
import subprocess


# ── Ejecución ───────────────────────────────────────────────────────────────


def run_cmd(cmd, cwd, timeout):
    """Devuelve (exit_code, stdout, stderr, motivo_indeterminado_o_None).

    exit 127 y timeout se marcan como indeterminados: no son "cero violaciones".
    """
    try:
        p = subprocess.run(
            cmd, shell=True, cwd=cwd, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except subprocess.TimeoutExpired:
        return (None, "", "", "timeout tras %ss" % timeout)
    except Exception as e:
        return (None, "", "", "no se pudo ejecutar: %s" % e)
    so = p.stdout.decode("utf-8", "replace")
    se = p.stderr.decode("utf-8", "replace")
    if p.returncode == 127:
        return (127, so, se, "exit 127: comando o interprete no encontrado")
    return (p.returncode, so, se, None)


# ── Recorrido de ficheros ───────────────────────────────────────────────────


def iter_files(root, includes, excludes):
    seen = []
    for pat in includes:
        for path in glob.glob(os.path.join(root, pat), recursive=True):
            if not os.path.isfile(path):
                continue
            rel = os.path.relpath(path, root)
            if any(fnmatch.fnmatch(rel, ex) for ex in excludes):
                continue
            seen.append(rel)
    return sorted(set(seen))


def count_lines(path):
    n = 0
    try:
        with open(path, "rb") as fh:
            for _ in fh:
                n += 1
    except Exception:
        return None
    return n


# ── Sondas integradas ───────────────────────────────────────────────────────
# No requieren tooling instalado en el repo: funcionan en un repo pelado.
# Devuelven (claves_ordenadas, denominador).


def probe_loc(cfg, root):
    """Ficheros que superan max_lines. Clave = ruta relativa."""
    files = iter_files(root, cfg.get("include", []), cfg.get("exclude", []))
    limit = int(cfg.get("max_lines", 500))
    keys = []
    for rel in files:
        n = count_lines(os.path.join(root, rel))
        if n is not None and n > limit:
            keys.append(rel)
    return sorted(keys), len(files)


def probe_missing_tests(cfg, root):
    """Modulos sin fichero de test hermano. Clave = ruta relativa."""
    suffixes = cfg.get("test_suffixes", [".test.ts", ".spec.ts"])
    files = iter_files(root, cfg.get("include", []), cfg.get("exclude", []))
    modules = [f for f in files if not any(s in os.path.basename(f) for s in suffixes)]
    keys = []
    for rel in modules:
        base, _ext = os.path.splitext(rel)
        if any(os.path.exists(os.path.join(root, base + s)) for s in suffixes):
            continue
        keys.append(rel)
    return sorted(keys), len(modules)


SECRET_PATTERNS = [
    ("aws-access-key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("github-token", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")),
    ("slack-token", re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("jwt", re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+")),
    ("asignacion", re.compile(
        r"(?i)\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*"
        r"[\"'][^\"'\s]{8,}[\"']")),
]


def probe_secrets(cfg, root):
    """Posibles credenciales en ficheros versionados.

    Un detector por regex es demasiado ruidoso para ser puerta dura — pero con
    trinquete encaja perfecto: los positivos de hoy se congelan y solo bloquea
    los NUEVOS.

    La clave lleva un hash del hallazgo, nunca el hallazgo: el baseline se
    versiona, y escribir ahi el secreto seria justo lo que se intenta evitar.
    """
    files = iter_files(root, cfg.get("include", []), cfg.get("exclude", []))
    max_bytes = int(cfg.get("max_bytes", 400000))
    keys = []
    for rel in files:
        p = os.path.join(root, rel)
        try:
            if os.path.getsize(p) > max_bytes:
                continue
            with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except Exception:
            continue
        if "\0" in text[:1024]:
            continue
        for pname, rx in SECRET_PATTERNS:
            for m in rx.findall(text):
                frag = m if isinstance(m, str) else "".join(m)
                digest = hashlib.sha256(frag.encode("utf-8")).hexdigest()[:10]
                keys.append("%s :: %s :: %s" % (rel, pname, digest))
    return sorted(set(keys)), len(files)


BUILTINS = {"loc": probe_loc, "missing_tests": probe_missing_tests,
            "secrets": probe_secrets}

# Sondas del grafo de importaciones (tests de arquitectura). Viven en otro
# fichero para no pasar de 500 LOC; si falta, el resto sigue funcionando.
try:
    import probes_graph
    BUILTINS.update(probes_graph.GRAPH_BUILTINS)
except ImportError:
    pass


# ── Claves desde la salida de una herramienta ───────────────────────────────
# Preferir SIEMPRE formatos máquina (json) sobre parsear prosa: la prosa cambia
# el día que alguien reescribe un mensaje y nadie se entera.


def _stable_msg(msg):
    """Normaliza un mensaje de linter para usarlo como identidad.

    Quita los numeros (complejidad 12 -> N, linea 34 -> N) y deja el resto: en
    la practica eso conserva el NOMBRE de la funcion, que es lo que identifica
    la violacion, y sobrevive a que el fichero se mueva de sitio.
    """
    return re.sub(r"\d+", "N", (msg or "").strip())


def _rel(path, root):
    try:
        return os.path.relpath(path, root)
    except Exception:
        return path


def keys_from_output(gate, stdout, root):
    """La clave debe identificar UNA violacion, no un fichero.

    Si la clave fuese `fichero:regla`, dos funciones complejas en el mismo
    fichero colapsarian en una sola clave y podrias añadir la segunda sin que
    el trinquete se enterase: fungible otra vez.
    """
    fmt = gate.get("keys_format", "lines")
    if fmt == "lines":
        keys = set(l.strip() for l in stdout.splitlines() if l.strip())
        return sorted(keys), None
    if fmt == "eslint-json":
        data = json.loads(stdout)
        keys = []
        for f in data:
            rel = _rel(f.get("filePath", "?"), root)
            for m in f.get("messages", []):
                keys.append("%s :: %s :: %s" % (
                    rel, m.get("ruleId") or "?", _stable_msg(m.get("message"))))
        return sorted(set(keys)), len(data)
    if fmt == "ruff-json":
        data = json.loads(stdout)
        keys = ["%s :: %s :: %s" % (_rel(m.get("filename", "?"), root),
                                    m.get("code", "?"),
                                    _stable_msg(m.get("message")))
                for m in data]
        return sorted(set(keys)), None
    raise ValueError("keys_format desconocido: %s" % fmt)


# ── Fingerprint del tooling ─────────────────────────────────────────────────
# Un `pnpm update` puede cambiar el numero de warnings sin tocar una linea de
# codigo. Sin esto tendrias bloqueos falsos (que llevan a --warn-only) y bajadas
# falsas (que congelan un logro inexistente).


def fingerprint(gate, root):
    files = gate.get("fingerprint_files", [])
    if not files:
        return None
    h = hashlib.sha256()
    for rel in sorted(files):
        p = os.path.join(root, rel)
        h.update(rel.encode("utf-8"))
        if os.path.exists(p):
            try:
                with open(p, "rb") as fh:
                    h.update(fh.read())
            except Exception:
                h.update(b"<unreadable>")
        else:
            h.update(b"<missing>")
    return h.hexdigest()[:16]


# ── Almacén ─────────────────────────────────────────────────────────────────


def gates_dir(root):
    return os.path.join(root, ".gates")


def baseline_path(root, name):
    return os.path.join(gates_dir(root), "baseline", "%s.txt" % name)


def read_baseline(root, name):
    p = baseline_path(root, name)
    if not os.path.exists(p):
        return None
    with open(p, "r", encoding="utf-8") as fh:
        return sorted(set(l.strip() for l in fh
                          if l.strip() and not l.startswith("#")))


def write_baseline(root, name, keys):
    """Texto plano, una clave por linea, ordenado.

    NO es JSON a proposito: el baseline se toca en ramas paralelas y necesita
    `merge=union` en .gitattributes. Union sobre JSON produce ficheros rotos;
    sobre lineas ordenadas es correcto y conservador.
    """
    p = baseline_path(root, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("# trinquete: una clave por linea, ordenado. Solo puede encoger.\n")
        for k in sorted(set(keys)):
            fh.write(k + "\n")


def meta_path(root):
    return os.path.join(gates_dir(root), "meta.json")


def read_meta(root):
    p = meta_path(root)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def write_meta(root, meta):
    os.makedirs(gates_dir(root), exist_ok=True)
    with open(meta_path(root), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")
