#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probes.py — sondas, almacén del baseline y frescura del runner.

Cómo se ESCRIBE una clave (tramos, magnitud, versión de formato) vive en
probes_keys.py y se reexporta desde aquí: quien la llama no tiene que saber en
qué fichero cayó el corte.

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

# Import duro, sin try/except: a diferencia de probes_graph y probes_contract —
# que degradan a "builtin desconocido" y dejan esa puerta INDETERMINADA— aqui un
# fallback silencioso volveria a emitir claves sin tramo, o sea justo el agujero
# que probes_keys cierra. Si falta, el runner tiene que romper, no medir de menos.
from probes_keys import (bands_for, crossed, keyfmt_version,  # noqa: F401
                         keys_from_output, stable_msgs)

# Version del runner. Vive aqui, no en gates.py, para que este junto a la firma
# que la acompaña: las dos se leen y se escriben en el mismo sitio.
RUNNER_VERSION = 3

# Firma del runner: sha256 de RUNNER_FILES, puesta por `gates.py --sign` en
# la fuente canonica y copiada verbatim a cada repo. Vacia = build sin firmar,
# que es INDETERMINADO, nunca OK.
RUNNER_DIGEST = "eaaea5023f8d830e"

RUNNER_FILES = ("gates.py", "probes.py", "probes_keys.py", "probes_graph.py",
                "probes_contract.py", "canaries.py")
DIGEST_MARK = "RUNNER_DIGEST = "


class Indeterminado(Exception):
    """Una sonda no pudo medir. gates.py lo traduce a INDETERMINADO tal cual.

    Existe porque una sonda solo tenia dos formas de responder —claves o una
    excepcion cualquiera— y "no he podido mirar" no es ninguna de las dos. Sin
    esto, una sonda que no puede medir devuelve [] y eso se lee como "cero
    violaciones": exactamente la confusion que el tercer estado viene a evitar.
    """


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
    """Ficheros que superan max_lines. Clave = ruta :: tramo cruzado."""
    files = iter_files(root, cfg.get("include", []), cfg.get("exclude", []))
    limit = int(cfg.get("max_lines", 500))
    bands = bands_for(cfg, limit)
    keys = []
    for rel in files:
        n = count_lines(os.path.join(root, rel))
        if n is None:
            continue
        for b in crossed(n, bands):
            keys.append("%s :: >%d" % (rel, b))
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

# Sondas que viven en otro fichero para no pasar de 500 LOC. Si falta alguno, el
# resto sigue funcionando: la puerta que lo usara sale INDETERMINADO por
# "builtin desconocido", que es la respuesta correcta, no un crash del runner.
try:
    import probes_graph
    BUILTINS.update(probes_graph.GRAPH_BUILTINS)
except ImportError:
    pass

try:
    import probes_contract
    BUILTINS.update(probes_contract.CONTRACT_BUILTINS)
except ImportError:
    pass


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


# ── Frescura del runner ─────────────────────────────────────────────────────
# El runner se vendoriza en cada repo porque GitHub Actions solo hace checkout
# del repo consumidor: una puerta que leyera un fichero de fuera se romperia en
# CI. El precio es la divergencia, y ya se cobro — la canonica se quedo dos
# cambios por detras de tres repos y nadie se entero.
#
# Esta sonda cierra lo que SI se puede demostrar desde dentro del repo:
#   integridad  el runner es byte a byte el que firmo la canonica
#   downgrade   nadie ha metido una copia mas vieja de la que ya corrio aqui
#   expectativa el manifiesto declara que version espera, y se cumple
#
# Lo que NO se puede demostrar desde dentro: que no exista una version mas
# nueva que este repo no ha visto nunca. Eso no esta en el repo por definicion.
# Por eso `min_version` es obligatorio: sin expectativa declarada la respuesta
# es INDETERMINADO, no OK.


def runner_digest(gdir):
    """sha256 de RUNNER_FILES. Levanta Indeterminado si falta uno.

    La linea de la firma se excluye del calculo: un fichero no puede contener su
    propio hash. Se filtra en los tres, no solo en probes.py, para que mover la
    constante de sitio no cambie el resultado.
    """
    h = hashlib.sha256()
    for name in RUNNER_FILES:
        p = os.path.join(gdir, name)
        if not os.path.isfile(p):
            raise Indeterminado("falta %s en %s: runner incompleto" % (name, gdir))
        h.update(name.encode("utf-8"))
        try:
            with open(p, "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith(DIGEST_MARK):
                        continue
                    h.update(line.encode("utf-8"))
        except Exception as e:
            raise Indeterminado("no se pudo leer %s: %s" % (name, e))
    return h.hexdigest()[:16]


def sign_runner(gdir):
    """Reescribe la constante RUNNER_DIGEST de probes.py con el hash real."""
    digest = runner_digest(gdir)
    p = os.path.join(gdir, "probes.py")
    with open(p, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    hit = False
    for i, line in enumerate(lines):
        if line.startswith(DIGEST_MARK):
            lines[i] = '%s"%s"\n' % (DIGEST_MARK, digest)
            hit = True
            break
    if not hit:
        raise Indeterminado("probes.py no declara %s: nada que firmar" % DIGEST_MARK.strip())
    with open(p, "w", encoding="utf-8") as fh:
        fh.writelines(lines)
    # Sin esto la siguiente pasada puede leer la firma VIEJA de un .pyc rancio y
    # salir VIOLACION sobre un runner correcto: la firma antigua y la nueva miden
    # lo mismo (16 chars) y se escriben en el mismo segundo, asi que el chequeo
    # mtime+size que usa Python para invalidar el cache pasa. Costo 10 min.
    cache = os.path.join(gdir, "__pycache__")
    if os.path.isdir(cache):
        for f in os.listdir(cache):
            try:
                os.remove(os.path.join(cache, f))
            except Exception:
                pass
    return digest


def probe_runner_freshness(cfg, root):
    """Clave = una forma concreta en que esta copia del runner no es la buena."""
    got = runner_digest(gates_dir(root))
    if not RUNNER_DIGEST:
        raise Indeterminado(
            "runner sin firmar: corre `gates.py --sign` en la fuente canonica")

    keys = []
    if got != RUNNER_DIGEST:
        keys.append("runner :: alterado :: firmado %s, calculado %s"
                    % (RUNNER_DIGEST, got))

    # meta.json solo sube de version (lo garantiza gates.py). Si lo que hay
    # escrito es MAYOR que lo que corre, alguien ha metido una copia vieja.
    seen = read_meta(root).get("_runner_version")
    if isinstance(seen, int) and seen > RUNNER_VERSION:
        keys.append("runner :: downgrade :: este repo ya corrio v%s y esta copia es v%s"
                    % (seen, RUNNER_VERSION))

    want = cfg.get("min_version")
    if want is None:
        raise Indeterminado(
            "la puerta no declara 'min_version': sin expectativa no hay nada "
            "contra lo que comparar, y eso es INDETERMINADO, no OK")
    if RUNNER_VERSION < int(want):
        keys.append("runner :: atrasado :: el manifiesto exige v%s y esta copia es v%s"
                    % (want, RUNNER_VERSION))
    return sorted(keys), None


BUILTINS["runner_freshness"] = probe_runner_freshness
