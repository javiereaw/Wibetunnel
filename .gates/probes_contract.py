#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probes_contract.py — la sonda que mira el DIFF, no el arbol.

Separado de probes_graph.py por el mismo motivo que probes_graph.py se separo de
probes.py: el limite de 500 LOC lo hace cumplir este runner, asi que el runner
no puede incumplirlo.

Todo stdlib, sintaxis <=3.9.
"""

import fnmatch
import glob as _glob
import json
import os
import re
import shutil
import subprocess
import tempfile


# ── Contrato del agente ─────────────────────────────────────────────────────
# Las otras sondas miran el ARBOL: como esta el repo ahora. Esta mira el DIFF:
# que ha hecho quien lo ha tocado. Es la unica que puede ver las trampas que
# bajan el numero sin arreglar nada, porque todas ellas se ven en el diff y en
# ninguna otra parte:
#
#   (a) editar .gates/baseline/*.txt a mano y borrar lineas
#   (b) añadir globs a "exclude" para que dejen de contarse
#   (c) subir max_lines / complexity / el umbral que toque
#   (d) meter eslint-disable, @ts-ignore, # noqa
#
# Inspirada en los role.contract.edn de SwarmForge: cada rol declara donde PUEDE
# escribir, y salirse de ahi es un fallo mecanico, no una opinion en una review.

DEFAULT_THRESHOLDS = ("max_lines", "max_bytes", "complexity", "max_depth",
                      "max_params", "max_nested_callbacks", "limit", "threshold")
DEFAULT_CODE = ["**/*.py", "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
                "**/*.mjs", "**/*.sh", "**/*.go", "**/*.rs"]
DEFAULT_SUPPRESSIONS = [
    ("eslint-disable", r"eslint-disable"),
    ("ts-ignore", r"@ts-(?:ignore|expect-error|nocheck)"),
    ("noqa", r"#\s*noqa"),
    ("type-ignore", r"#\s*type:\s*ignore"),
    ("pylint-disable", r"#\s*pylint:\s*disable"),
    ("istanbul-ignore", r"istanbul ignore"),
    ("skip-test", r"\b(?:it|test|describe)\.skip\b|@pytest\.mark\.skip"),
]
TRAILER = re.compile(r"^\s*Agent:\s*([A-Za-z0-9_-]+)\s*$", re.M)


def _ind(msg):
    from probes import Indeterminado
    return Indeterminado(msg)


def _git(root, argv, timeout=30):
    """(exit_code, stdout). Nunca levanta: el motivo lo decide quien llama."""
    try:
        p = subprocess.run(["git"] + argv, cwd=root, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except Exception:
        return 1, ""
    return p.returncode, p.stdout.decode("utf-8", "replace")


def _rev(root, ref):
    code, out = _git(root, ["rev-parse", "--verify", "--quiet", ref])
    return out.strip() if code == 0 and out.strip() else None


def _resolve_base(root):
    """Sha de la base de comparacion, o None.

    NO se usa refs/remotes/origin/HEAD: en los cuatro repos donde se comprobo
    devuelve vacio (nadie corre `git remote set-head`), y una base vacia se lee
    como "no hay cambios", que es justo lo contrario de lo que pasa.
    """
    env = os.environ.get("TRINQUETE_BASE", "").strip()
    if env:
        sha = _rev(root, env)
        return sha or None
    cands = []
    try:
        p = subprocess.run(["gh", "repo", "view", "--json", "defaultBranchRef",
                            "-q", ".defaultBranchRef.name"], cwd=root, timeout=20,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        name = p.stdout.decode("utf-8", "replace").strip()
        if p.returncode == 0 and name:
            cands.append("origin/" + name)
    except Exception:
        pass
    # Locales al final: un repo sin remote (claude-toolkit mismo) sigue teniendo
    # rama por defecto, y quedarse sin base ahi seria INDETERMINADO para siempre.
    cands += ["origin/main", "origin/master", "main", "master"]
    for ref in cands:
        sha = _rev(root, ref)
        if sha:
            return sha
    return None


def _range(root):
    """(sha_base, ficheros_cambiados). Levanta Indeterminado si no hay con que."""
    base = _resolve_base(root)
    if base is None:
        raise _ind("sin base de comparacion: ni TRINQUETE_BASE, ni gh, ni "
                   "origin/main, ni origin/master")
    head = _rev(root, "HEAD")
    if head is None:
        raise _ind("HEAD no resuelve: repo sin commits")
    code, out = _git(root, ["merge-base", base, head])
    mb = out.strip() if code == 0 else None
    if not mb:
        raise _ind("sin ancestro comun con la base: clon shallow (falta "
                   "fetch-depth: 0) o historia no relacionada")
    if mb == head:
        # Estamos EN la base (push directo a main). El rango util es el ultimo
        # commit; sin el, cada push a main saldria INDETERMINADO y la puerta
        # acabaria desactivada por ruidosa.
        mb = _rev(root, "HEAD~1")
        if not mb:
            raise _ind("HEAD es la base y no hay HEAD~1: nada que comparar")
    code, out = _git(root, ["diff", "--name-only", mb, head])
    if code != 0:
        raise _ind("git diff fallo contra %s" % mb[:8])
    files = sorted(f for f in out.splitlines() if f.strip())
    if not files:
        raise _ind("el diff contra %s esta vacio: nada que juzgar" % mb[:8])
    return mb, files


def _match(rel, pat):
    if fnmatch.fnmatch(rel, pat):
        return True
    # `**/*.py` no casa un fichero en la raiz porque le falta la barra. Es la
    # misma limitacion que glob y sorprende a todo el mundo; se cubre aparte.
    return pat.startswith("**/") and fnmatch.fnmatch(rel, pat[3:])


def _agent(root, mb, cfg):
    """Quien firma el cambio. Env > trailer del commit > nombre de la rama."""
    known = [n for n in cfg.get("agents", {}) if not n.startswith("_")]
    env = os.environ.get("TRINQUETE_AGENT", "").strip()
    if env:
        return env
    _c, log = _git(root, ["log", "--format=%B", "%s..HEAD" % mb])
    found = TRAILER.findall(log)
    if found:
        return found[-1]
    _c, br = _git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
    br = br.strip()
    # El nombre mas largo que aparezca en la rama: `cesar-mejoras-diarias/...`
    # tiene que ganar a `cesar-dev`, no empatar con el.
    hits = [n for n in known if n in br]
    return max(hits, key=len) if hits else ""


def _spec(cfg, agent):
    agents = cfg.get("agents", {})
    base = dict(agents.get("_default", {}))
    base.update(agents.get(agent, {}))
    return base


def _show(root, ref, path):
    code, out = _git(root, ["show", "%s:%s" % (ref, path)])
    return out if code == 0 else None


def _real_lines(text):
    return [l for l in (text or "").splitlines()
            if l.strip() and not l.lstrip().startswith("#")]


def _check_writes(files, spec, agent, keys):
    roots = spec.get("artifact_roots") or []
    for f in files:
        if any(_match(f, p) for p in spec.get("forbidden_writes", [])):
            keys.append("contrato :: %s :: escritura prohibida :: %s" % (agent, f))
        elif roots and not any(_match(f, p) for p in roots):
            keys.append("contrato :: %s :: fuera de sus artefactos :: %s" % (agent, f))


def _rebaselined(root, mb, files):
    """True si este cambio trae un --rebaseline nuevo con su motivo escrito."""
    if ".gates/meta.json" not in files:
        return False

    def reasons(ref):
        try:
            d = json.loads(_show(root, ref, ".gates/meta.json") or "{}")
        except Exception:
            return set()
        return set((k, v.get("rebaseline_reason")) for k, v in d.items()
                   if isinstance(v, dict) and v.get("rebaseline_reason"))
    return bool(reasons("HEAD") - reasons(mb))


def _check_baselines(root, mb, files, cfg, keys):
    """(a) un baseline que PIERDE lineas en un commit que no toca codigo."""
    pats = cfg.get("baselines", [".gates/baseline/*.txt"])
    touched = [f for f in files if any(_match(f, p) for p in pats)]
    if not touched:
        return
    code_pats = cfg.get("code_globs", DEFAULT_CODE)
    toca_codigo = any(any(_match(f, p) for p in code_pats) for f in files)
    if toca_codigo or _rebaselined(root, mb, files):
        return
    for f in touched:
        antes = len(_real_lines(_show(root, mb, f)))
        ahora = len(_real_lines(_show(root, "HEAD", f)))
        if ahora < antes:
            keys.append("contrato :: baseline encogido sin tocar codigo :: "
                        "%s :: %s -> %s" % (f, antes, ahora))


def _walk_nums(node, thresholds, out, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in thresholds and isinstance(v, (int, float)) and not isinstance(v, bool):
                out[path + k] = v
            else:
                _walk_nums(v, thresholds, out, path + str(k) + ".")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk_nums(v, thresholds, out, "%s%d." % (path, i))


def _by_name(mf):
    return dict((g.get("name"), g) for g in (mf or {}).get("gates", [])
                if isinstance(g, dict) and g.get("name"))


def _check_manifest(root, mb, cfg, keys):
    """(c) subir un umbral, y (b) estrechar el denominador o apagar la puerta."""
    path = cfg.get("manifest_path", ".gates/manifest.json")
    try:
        old = json.loads(_show(root, mb, path) or "")
        new = json.loads(_show(root, "HEAD", path) or "")
    except Exception:
        return  # no existia antes: instalacion nueva, nada que comparar
    thresholds = set(cfg.get("thresholds", DEFAULT_THRESHOLDS))
    og, ng = _by_name(old), _by_name(new)
    for name, o in og.items():
        n = ng.get(name)
        if n is None:
            keys.append("contrato :: puerta borrada :: %s" % name)
            continue
        if n.get("exempt") and not o.get("exempt"):
            keys.append("contrato :: puerta marcada exempt :: %s" % name)
        a, b = {}, {}
        _walk_nums(o, thresholds, a)
        _walk_nums(n, thresholds, b)
        for k, v in a.items():
            if k in b and b[k] > v:
                keys.append("contrato :: umbral subido :: %s.%s :: %s -> %s"
                            % (name, k, v, b[k]))
        for field in ("profiles", "include"):
            ido = set(o.get(field, [])) - set(n.get(field, []))
            if ido:
                keys.append("contrato :: %s recortado :: %s :: %s"
                            % (field, name, ", ".join(sorted(ido))))
        nuevas = set(n.get("exclude", [])) - set(o.get("exclude", []))
        if nuevas:
            keys.append("contrato :: exclusion nueva :: %s :: %s"
                        % (name, ", ".join(sorted(nuevas))))


def _check_suppressions(root, mb, cfg, keys):
    """(d) lineas AÑADIDAS que apagan un linter.

    Solo en ficheros de codigo: un `eslint-disable` dentro de un .md es
    documentacion y no apaga nada. Y nunca sobre el propio runner — este fichero
    contiene los patrones literales, asi que escanearse a si mismo se detecta
    como trampa. Un detector que se dispara consigo mismo acaba desactivado.
    """
    pats = [(n, re.compile(rx)) for n, rx in
            (cfg.get("suppressions") or DEFAULT_SUPPRESSIONS)]
    code_pats = cfg.get("code_globs", DEFAULT_CODE)
    skip = cfg.get("suppression_exclude", [".gates/**"])
    code, out = _git(root, ["diff", "-U0", mb, "HEAD"], 60)
    if code != 0:
        return
    mira = False
    cur = "?"
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            cur = line[6:]
            mira = (any(_match(cur, p) for p in code_pats)
                    and not any(_match(cur, p) for p in skip))
        elif mira and line.startswith("+") and not line.startswith("+++"):
            for name, rx in pats:
                if rx.search(line):
                    keys.append("contrato :: supresion nueva :: %s :: %s" % (name, cur))


def probe_agent_contract(cfg, root):
    """Clave = una clausula del contrato que este diff incumple."""
    mb, files = _range(root)
    agent = _agent(root, mb, cfg) or "_default"
    spec = _spec(cfg, agent)
    keys = []
    _check_writes(files, spec, agent, keys)
    _check_baselines(root, mb, files, cfg, keys)
    _check_manifest(root, mb, cfg, keys)
    _check_suppressions(root, mb, cfg, keys)
    # Denominador None a proposito: el numero de ficheros de un diff sube y baja
    # por motivos legitimos, y el guardian del denominador lo leeria como
    # exclusion nueva en cada PR pequeño.
    return sorted(set(keys)), None


# ── Canario del contrato ────────────────────────────────────────────────────


def _wt_commit(wt, msg):
    subprocess.run(["git", "-c", "user.name=canario",
                    "-c", "user.email=canario@trinquete", "commit", "-q",
                    "--no-verify", "-a", "-m", msg],
                   cwd=wt, timeout=60, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def _forbidden_agent(cfg, rel):
    """Un agente real, NO jardinero, que tenga prohibido escribir en `rel`.

    Deterministico (orden alfabetico) para que el canario diga siempre lo mismo
    y su salida se pueda comparar entre ejecuciones.
    """
    for name in sorted(cfg.get("agents", {})):
        if name.startswith("_") or name == "jardinero":
            continue
        spec = _spec(cfg, name)
        if any(_match(rel, p) for p in spec.get("forbidden_writes", [])):
            return name
    return None


def canary_shrink_baseline(root, gate):
    """Encoge un baseline en un worktree aparte y exige que la puerta enrojezca.

    Dos commits reales, no un fichero suelto: la sonda mira `git diff`, asi que
    un canario que no commitea no prueba nada. El primero mete una clave
    sintetica (y es la base), el segundo la borra sin tocar codigo — que es
    exactamente la trampa (a).

    Y lo firma un agente que NO es el jardinero: asi el canario cubre las dos
    mitades del contrato a la vez —quien puede escribir donde, y que ha hecho—
    en vez de solo la segunda. TRINQUETE_AGENT se fija a mano porque si no el
    canario heredaria el del entorno (claude-wrap.sh lo exporta) y probaria una
    cosa distinta en cada maquina.
    """
    tmp = tempfile.mkdtemp(prefix="trinquete-canario-")
    wt = os.path.join(tmp, "wt")
    prev = os.environ.get("TRINQUETE_BASE")
    prev_agent = os.environ.get("TRINQUETE_AGENT")
    try:
        code, _ = _git(root, ["worktree", "add", "--detach", "-q", wt, "HEAD"], 120)
        if code != 0:
            raise _ind("no se pudo crear el worktree temporal")
        bases = sorted(_glob.glob(os.path.join(wt, ".gates", "baseline", "*.txt")))
        if not bases:
            raise _ind("no hay ningun .gates/baseline/*.txt que encoger")
        target = bases[0]
        rel = os.path.relpath(target, wt)

        with open(target, "a", encoding="utf-8") as fh:
            fh.write("zz_canario_trinquete :: clave sintetica\n")
        _wt_commit(wt, "canario: mete la clave sintetica")
        base_sha = _rev(wt, "HEAD")

        with open(target, "r", encoding="utf-8") as fh:
            keep = [l for l in fh if "zz_canario_trinquete" not in l]
        with open(target, "w", encoding="utf-8") as fh:
            fh.writelines(keep)
        _wt_commit(wt, "canario: borra la clave a mano, sin tocar codigo")

        agent = _forbidden_agent(gate, rel)
        os.environ["TRINQUETE_BASE"] = base_sha or "HEAD~1"
        os.environ["TRINQUETE_AGENT"] = agent or "_default"
        print("  canario: '%s' borra una linea de %s sin tocar codigo"
              % (agent or "_default", rel))

        keys, _denom = probe_agent_contract(gate, wt)
        falta = []
        if not [k for k in keys if "baseline encogido" in k]:
            falta.append("baseline encogido")
        # Solo se exige si el manifiesto declara a alguien con esa ruta
        # prohibida: en un repo sin esa regla el canario no puede inventarsela.
        if agent and not [k for k in keys if "escritura prohibida" in k]:
            falta.append("escritura prohibida")
        if falta:
            return False, "no detecto %s (claves: %s)" % (
                " ni ".join(falta), keys or "ninguna")
        return True, " | ".join(keys)
    finally:
        for var, val in (("TRINQUETE_BASE", prev), ("TRINQUETE_AGENT", prev_agent)):
            if val is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = val
        _git(root, ["worktree", "remove", "--force", wt], 60)
        shutil.rmtree(tmp, ignore_errors=True)


CONTRACT_BUILTINS = {"agent_contract": probe_agent_contract}
