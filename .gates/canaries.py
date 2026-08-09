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
import subprocess
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


def _canario_config_arbol(tmp, lineas_extra):
    """Arbol minimo: una config, un fichero que ya incumple y otro nuevo.

    Se monta sintetico y no sobre el repo porque lo que se prueba es la LOGICA
    del runner —el corte por subconjunto— y no la configuracion de este repo en
    concreto. Asi el canario corre igual en un repo de python que en uno de TS,
    y no depende de que exista una puerta con `fingerprint_files`.
    """
    with open(os.path.join(tmp, "config.txt"), "w", encoding="utf-8") as fh:
        fh.write("config NUEVA: el fingerprint no es el del baseline\n")
    with open(os.path.join(tmp, "viejo.txt"), "w", encoding="utf-8") as fh:
        fh.write("x\n" * 20)
    for i, n in enumerate(lineas_extra):
        with open(os.path.join(tmp, "nuevo%d.txt" % i), "w", encoding="utf-8") as fh:
            fh.write("x\n" * n)


def canary_config_shrink(root, profile):
    """Canario de --acepta-config: aceptar la config NO acepta deuda nueva.

    La primitiva existe para el caso legitimo —cambiar la config para dejar de
    medir ruido, y que el baseline encoja sin pasar por --rebaseline, que es
    global y ademas escribe desde VIOLACION—. Su unica garantia es el corte por
    subconjunto, y una garantia sin canario es una suposicion.

    Se comprueban las DOS mitades, porque una sola no dice nada: que con el
    fingerprint cambiado y cero claves nuevas la puerta acepte y baje, y que con
    el fingerprint cambiado y UNA clave nueva la puerta enrojezca igual. Si solo
    se probara la primera, un `return OK` incondicional pasaria el canario.
    """
    import gates
    gate = {"name": "canario-config", "type": "ratchet", "builtin": "loc",
            "include": ["*.txt"], "exclude": [], "max_lines": 10,
            "bands": [10, 20, 40], "fingerprint_files": ["config.txt"]}
    base = ["viejo.txt :: >10", "viejo.txt :: >20", "sobrante.txt :: >10"]
    meta = {"canario-config": {"fingerprint": "0000000000000000",
                               "keyfmt": probes.keyfmt_version(gate)}}

    tmp = tempfile.mkdtemp(prefix="trinquete-canario-config-")
    try:
        # Mitad 1: subconjunto estricto (sobrante.txt ya no existe) -> debe bajar.
        _canario_config_arbol(tmp, [])
        probes.write_baseline(tmp, gate["name"], base)
        encoge = gates.eval_ratchet(gate, tmp, dict(meta), False,
                                    acepta_config={"canario-config"})
        # Mitad 2: mismo cambio de config, pero ademas una clave NUEVA.
        _canario_config_arbol(tmp, [15])
        probes.write_baseline(tmp, gate["name"], base)
        cuela = gates.eval_ratchet(gate, tmp, dict(meta), False,
                                   acepta_config={"canario-config"})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("  canario: config nueva, mismo baseline. Sin clave nueva -> %s; "
          "con clave nueva -> %s" % (encoge["state"], cuela["state"]))
    bajo = encoge["state"] == gates.OK and encoge.get("ratchet")
    if not bajo:
        return _veredicto("acepta-config (encogimiento)", False,
                          "con 0 claves nuevas deberia haber bajado y salio %s: %s"
                          % (encoge["state"], encoge.get("detail", "")))
    rojo = cuela["state"] == gates.VIOLACION
    return _veredicto("acepta-config (deuda nueva)", rojo,
                      "%s :: %s" % (cuela.get("detail", ""),
                                    ", ".join(cuela.get("nuevas", []))))


_CANARIO_LOCK = """{
  "name": "canario-osv", "version": "1.0.0", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": {"name": "canario-osv", "version": "1.0.0", "dependencies": {"lodash": "4.17.20"}},
    "node_modules/lodash": {"version": "4.17.20",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz"}
  }
}
"""


def canary_osv(root, profile):
    """Canario de la puerta de vulnerabilidades: una dependencia con CVE conocido
    tiene que enrojecer.

    lodash 4.17.20 y no una version inventada: esta en OSV desde 2021 con cinco
    avisos —GHSA-35jh-r3h4-6jhm entre ellos, inyeccion de comandos— y no va a
    dejar de estarlo. Un canario que dependa de un aviso reciente caduca solo.

    Corre sobre un arbol temporal con baseline vacio, asi que cualquier hallazgo
    es clave nueva. Si el escaner no esta o la API de OSV no responde, la puerta
    sale INDETERMINADO y aqui se dice: un canario que no ha podido medir no es
    un canario verde.
    """
    import gates
    gate = None
    for g in gates.select_gates(gates.load_manifest(root), profile):
        if g.get("keys_format") == "osv-json":
            gate = g
            break
    if gate is None:
        sys.stderr.write("No hay puerta 'osv-json' en el perfil %s: sin canario.\n" % profile)
        return SKIPPED

    tmp = tempfile.mkdtemp(prefix="trinquete-canario-osv-")
    try:
        with open(os.path.join(tmp, "package-lock.json"), "w", encoding="utf-8") as fh:
            fh.write(_CANARIO_LOCK)
        probes.write_baseline(tmp, gate["name"], [])
        print("  canario: package-lock.json con lodash 4.17.20 (5 avisos en OSV)")
        r = gates.eval_ratchet(gate, tmp, {}, False)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if r["state"] == gates.INDETERMINADO:
        sys.stderr.write("El escaner no pudo medir (%s): el canario NO ha demostrado "
                         "nada.\n" % r.get("detail", ""))
        return 2
    return _veredicto(gate["name"], r["state"] == gates.VIOLACION,
                      "%s :: %s" % (r.get("detail", ""),
                                    ", ".join(r.get("nuevas", [])[:3])))


def _veredicto(name, rojo, detail):
    import gates
    if rojo:
        print("  %s la puerta '%s' detecto el fallo sintetico" % (gates.green("OK"), name))
        print("  %s" % gates.dim(detail))
        return 0
    print("  %s la puerta '%s' NO bloqueo el canario (%s)" % (gates.red("FALLO"), name, detail))
    print("  " + gates.red("La puerta es decorativa. No te fies de ella."))
    return 1


def cmd_verify(root, profile):
    import canaries_repo
    codes = [canary_loc(root, profile),
             canary_loc_growth(root, profile),
             canary_config_shrink(root, profile),
             canary_osv(root, profile),
             canaries_repo.canary_contract(root, profile),
             canaries_repo.canary_freshness(root, profile),
             canaries_repo.canary_agent_wiring(root, profile)]
    real = [c for c in codes if c != SKIPPED]
    if not real:
        sys.stderr.write("Ningun canario aplicaba: esto NO es una verificacion.\n")
        return 2
    return max(real)
