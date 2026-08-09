#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
canaries.py — los canarios: meten un fallo sintetico y exigen que la puerta
enrojezca.

Aparte de gates.py por el limite de 500 LOC que este mismo runner hace cumplir.
Encaja: solo corre con `--verify`, nunca en el camino caliente, y el codigo que
DEMUESTRA que las puertas funcionan es una preocupacion distinta de las puertas.

`import gates` va dentro de las funciones, no arriba: gates.py importa este
modulo y seria un ciclo. Es el mismo patron que probes_graph._walk.

Todo stdlib, sintaxis <=3.9.
"""

import os
import shutil
import sys
import tempfile

import probes


SKIPPED = 3  # el canario no aplica en este repo: ni verde ni rojo


def _pick(manifest, profile, builtin):
    import gates
    for g in gates.select_gates(manifest, profile):
        if g.get("type") == "ratchet" and g.get("builtin") == builtin:
            return g
    return None


def canary_loc(root, profile):
    """Canario: mete un fallo sintetico y exige que la puerta enrojezca.

    Comprobar que el fichero de hook existe es exactamente el error que tiene
    todo el parque. Esto demuestra el presente, no lo supone.
    """
    import gates
    gate = _pick(gates.load_manifest(root), profile, "loc")
    if gate is None:
        sys.stderr.write("No hay puerta 'loc' en el perfil %s: sin canario.\n" % profile)
        return SKIPPED
    includes = gate.get("include", [])
    if not includes:
        sys.stderr.write("La puerta loc no declara 'include'.\n")
        return 2

    # El canario tiene que caer DENTRO de lo que la puerta mira: hay que sacar
    # la extension y el directorio del propio patron. Un .ts en la raiz no lo
    # detecta una puerta que vigila lib/**/*.js.
    pattern = next((p for p in includes if "*" in p), includes[0])
    ext = os.path.splitext(pattern)[1] or ".txt"
    stem = pattern.split("*")[0].rstrip("/")
    target = os.path.join(root, stem) if stem else root
    if not os.path.isdir(target):
        target = root
    canary = os.path.join(target, "zz_canario_trinquete" + ext)
    limit = int(gate.get("max_lines", 500))

    print("  canario: %s con %s lineas" % (os.path.relpath(canary, root), limit + 100))
    try:
        with open(canary, "w", encoding="utf-8") as fh:
            fh.write("// fichero sintetico del canario de trinquete - se borra solo\n")
            for i in range(limit + 100):
                fh.write("export const canario%d = %d;\n" % (i, i))
        r = gates.eval_ratchet(gate, root, probes.read_meta(root), False)
    finally:
        if os.path.exists(canary):
            os.remove(canary)

    return _veredicto(gate["name"], r["state"] == gates.VIOLACION, r.get("detail", ""))


def canary_loc_growth(root, profile):
    """Canario del tramo: un fichero que YA esta en el baseline y crece hasta
    cruzar el tramo siguiente tiene que enrojecer.

    Es EL fallo que los tramos vienen a cerrar, y el que canary_loc no ve:
    canary_loc mete un fichero nuevo, y un fichero nuevo siempre da clave nueva.
    Añadir a un fichero que ya incumple era el camino de menor resistencia y el
    unico que no vigilaba nadie.

    Se monta en un directorio aparte, no sobre el repo: reescribir un fichero
    real de 700 lineas y restaurarlo deja el repo roto si el canario peta a
    mitad. En el temporal se recrea solo la ruta elegida —con el tamaño real
    medido en el repo de verdad— y un baseline minimo con las claves que ese
    tamaño produce hoy. La meta se pasa a mano por lo mismo: el denominador y el
    fingerprint del repo real no aplican a un arbol de un solo fichero.
    """
    import gates
    gate = _pick(gates.load_manifest(root), profile, "loc")
    if gate is None:
        sys.stderr.write("No hay puerta 'loc' en el perfil %s: sin canario.\n" % profile)
        return SKIPPED

    base = probes.read_baseline(root, gate["name"]) or []
    limit = int(gate.get("max_lines", 500))
    bands = probes.bands_for(gate, limit)
    elegido = None
    for k in base:
        rel = k.split(" :: ")[0]
        n = probes.count_lines(os.path.join(root, rel))
        if n is not None and n > limit:
            elegido = (rel, n)
            break
    if elegido is None:
        sys.stderr.write("Ningun fichero del baseline de '%s' existe y supera %s: "
                         "sin canario de crecimiento.\n" % (gate["name"], limit))
        return SKIPPED

    rel, n = elegido
    siguiente = next((b for b in probes.crossed(n * 1000, bands) if b > n), n * 2)
    tmp = tempfile.mkdtemp(prefix="trinquete-canario-")
    try:
        destino = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(destino) or tmp, exist_ok=True)
        with open(destino, "w", encoding="utf-8") as fh:
            for i in range(siguiente + 5):
                fh.write("linea sintetica %d del canario de crecimiento\n" % i)
        probes.write_baseline(tmp, gate["name"],
                              ["%s :: >%d" % (rel, b) for b in probes.crossed(n, bands)])

        print("  canario: %s ya en el baseline con %s lineas, crece a %s (tramo >%s)"
              % (rel, n, siguiente + 5, siguiente))
        meta = {gate["name"]: {"keyfmt": probes.keyfmt_version(gate)}}
        r = gates.eval_ratchet(gate, tmp, meta, False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    rojo = r["state"] == gates.VIOLACION
    detail = r.get("detail", "")
    if rojo:
        detail = "%s :: %s" % (detail, ", ".join(r.get("nuevas", [])))
    return _veredicto(gate["name"] + " (crecimiento)", rojo, detail)


def _veredicto(name, rojo, detail):
    import gates
    if rojo:
        print("  %s la puerta '%s' detecto el fallo sintetico" % (gates.green("OK"), name))
        print("  %s" % gates.dim(detail))
        return 0
    print("  %s la puerta '%s' NO bloqueo el canario (%s)" % (gates.red("FALLO"), name, detail))
    print("  " + gates.red("La puerta es decorativa. No te fies de ella."))
    return 1


def canary_contract(root, profile):
    """Canario del contrato: encoger un baseline sin tocar codigo debe enrojecer.

    Es la trampa mas barata que tiene un agente —editar .gates/baseline/*.txt a
    mano y borrar lineas— y hasta esta puerta no la veia nadie. El canario la
    ejecuta de verdad, en un worktree aparte, con dos commits reales.
    """
    import gates
    gate = _pick(gates.load_manifest(root), profile, "agent_contract")
    if gate is None:
        sys.stderr.write("No hay puerta 'agent_contract' en el perfil %s: sin canario.\n"
                         % profile)
        return SKIPPED
    try:
        import probes_contract
    except ImportError:
        sys.stderr.write("probes_contract.py no importable: sin canario de contrato.\n")
        return 2
    try:
        rojo, detail = probes_contract.canary_shrink_baseline(root, gate)
    except probes.Indeterminado as e:
        print("  %s el canario no se pudo montar: %s" % (gates.yellow("??"), e))
        return 2
    return _veredicto(gate["name"], rojo, detail)


def canary_freshness(root, profile):
    """Canario de frescura: una copia manipulada del runner debe enrojecer.

    Copia los ficheros del runner a un directorio aparte y le añade un byte a uno.
    Aparte y no in situ a proposito: tocar el runner que esta corriendo deja el
    repo sucio si el canario peta a mitad, y encima cambiaria el codigo que
    ejecuta la comprobacion mientras la ejecuta.
    """
    import gates
    gate = _pick(gates.load_manifest(root), profile, "runner_freshness")
    if gate is None:
        sys.stderr.write("No hay puerta 'runner_freshness' en el perfil %s: sin canario.\n"
                         % profile)
        return SKIPPED

    tmp = tempfile.mkdtemp(prefix="trinquete-canario-")
    try:
        gdir = os.path.join(tmp, ".gates")
        os.makedirs(gdir)
        src = probes.gates_dir(root)
        for name in probes.RUNNER_FILES:
            shutil.copy2(os.path.join(src, name), os.path.join(gdir, name))
        # probes_graph.py y no probes.py: la linea de la firma se excluye del
        # hash, asi que tocar probes.py cerca de esa constante podria colarse.
        # Cualquier otro fichero entra entero en el digest.
        tocado = "probes_graph.py"
        with open(os.path.join(gdir, tocado), "a", encoding="utf-8") as fh:
            fh.write("\n# zz_canario_trinquete: un byte de mas\n")

        print("  canario: copia del runner con %s manipulado" % tocado)
        try:
            keys, _denom = probes.probe_runner_freshness(gate, tmp)
        except probes.Indeterminado as e:
            print("  %s el canario no se pudo montar: %s" % (gates.yellow("??"), e))
            return 2
        hit = [k for k in keys if "alterado" in k]
        detail = hit[0] if hit else "claves devueltas: %s" % (keys or "ninguna")
        return _veredicto(gate["name"], bool(hit), detail)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_verify(root, profile):
    codes = [canary_loc(root, profile),
             canary_loc_growth(root, profile),
             canary_contract(root, profile),
             canary_freshness(root, profile)]
    real = [c for c in codes if c != SKIPPED]
    if not real:
        sys.stderr.write("Ningun canario aplicaba: esto NO es una verificacion.\n")
        return 2
    return max(real)
