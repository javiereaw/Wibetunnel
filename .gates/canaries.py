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


def canary_agent_wiring(root, profile):
    """Canario del CABLEADO: el lanzador real tiene que hacer llegar
    TRINQUETE_AGENT hasta la sonda con el valor correcto.

    Los otros tres canarios prueban las puertas. Este prueba lo de antes: que
    quien lanza al agente le pone la firma. Sin eso, el contrato se evalua
    siempre contra `_default` —que esta abierto a proposito— y las puertas
    salen en verde sin haber mirado a nadie. Es el mismo error que fundo todo
    esto ("el fichero de hook existe" en vez de "el hook se dispara"), un piso
    mas abajo.

    Se demuestra ejecutando el lanzador DE VERDAD en un arbol sintetico: un
    origen local, un clon de trabajo ya hecho (para que no toque la red) y un
    `claude` de pega el primero en el PATH que, en vez de gastar cuota,
    interroga a `probes_contract._agent()` con el entorno que le haya llegado.
    Lo que se compara es lo que la SONDA resuelve, no lo que el lanzador dice.

    Lo especifico del lanzador se declara en el manifiesto, no aqui: que copiar
    al origen, que clones espera encontrar ya hechos y que variables necesita.
    """
    import gates
    gate = _pick_canary(gates.load_manifest(root), profile, "agent_wiring")
    if gate is None:
        sys.stderr.write("No hay canario 'agent_wiring' declarado: sin canario de cableado.\n")
        return SKIPPED
    casos = gate.get("cases") or []
    if not gate.get("launcher") or not casos:
        sys.stderr.write("El canario 'agent_wiring' necesita 'launcher' y 'cases'.\n")
        return 2
    codes = [_wiring_case(root, gate, c) for c in casos]
    return max(codes) if codes else 2


def _wiring_case(root, gate, caso):
    """Un caso del canario de cableado, con su arbol sintetico propio.

    Un arbol por caso y no uno compartido: el lanzador deriva su directorio de
    trabajo del nombre que recibe, asi que dos casos comparten tan poco que
    reaprovechar el sandbox solo añadiria acoplamiento.
    """
    import gates
    launcher = list(gate["launcher"]) + list(caso.get("args") or [])
    esperado = caso.get("expect", "")

    sb = tempfile.mkdtemp(prefix="trinquete-cableado-")
    try:
        marca = os.path.join(sb, "agente-resuelto.txt")
        # {caso} = el ultimo argumento, que es como los lanzadores nombran la
        # rutina. Permite declarar clones y ficheros de prompt una sola vez.
        rutas = {"sandbox": sb, "bin": os.path.join(sb, "bin"),
                 "caso": launcher[-1]}
        for nombre in gate.get("dirs") or []:
            rutas[nombre] = os.path.join(sb, nombre)
            os.makedirs(rutas[nombre], exist_ok=True)
        rutas["origen"] = origen = _seed_origin(root, sb, gate, rutas)
        for destino, modo in sorted((gate.get("clones") or {}).items()):
            _git(["clone", "-q"] + (["--bare"] if modo == "bare" else [])
                 + [origen, destino.format(**rutas)])
        _stubs(sb, gate, rutas, marca)

        env = dict(os.environ)
        env.pop("TRINQUETE_AGENT", None)   # heredarla probaria otra cosa
        env["PATH"] = rutas["bin"] + os.pathsep + env.get("PATH", "")
        for k, v in (gate.get("env") or {}).items():
            env[k] = v.format(**rutas)

        print("  canario: %s con TRINQUETE_AGENT sin definir en el entorno"
              % " ".join(launcher))
        cmd = [os.path.join(root, launcher[0])] + list(launcher[1:])
        p = subprocess.run(cmd, cwd=root, env=env, timeout=gate.get("timeout", 180),
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        # La marca se lee por EXISTENCIA, no por contenido: el stub la escribe
        # siempre, aunque la sonda no resuelva nada. Si no existe, el lanzador
        # ni llego a invocar al agente y eso es INDETERMINADO —no se ha
        # comprobado nada—; si existe vacia, la sonda SI corrio y no resolvio
        # a nadie, que es exactamente el fallo que este canario busca.
        if not os.path.exists(marca):
            salida = p.stdout.decode("utf-8", "replace").strip()[-400:]
            print("  %s el lanzador no llego a invocar al agente (exit %s). %s"
                  % (gates.yellow("??"), p.returncode, salida))
            return 2
        with open(marca, encoding="utf-8") as fh:
            visto = fh.read().strip()
    except (probes.Indeterminado, OSError, subprocess.SubprocessError) as e:
        print("  %s el canario no se pudo montar: %s" % (gates.yellow("??"), e))
        return 2
    finally:
        shutil.rmtree(sb, ignore_errors=True)

    if visto == esperado:
        print("  %s la sonda resolvio el agente '%s' desde el lanzador real"
              % (gates.green("OK"), visto))
        return 0
    print("  %s el lanzador NO cablea el agente: la sonda resolvio '%s', se esperaba '%s'"
          % (gates.red("FALLO"), visto or "<nadie>", esperado))
    print("  " + gates.red("El contrato se esta evaluando contra _default. No te fies de el."))
    return 1


def _pick_canary(manifest, profile, builtin):
    import gates
    for g in manifest.get("gates", []):
        if g.get("type") != "canary" or g.get("builtin") != builtin or g.get("exempt"):
            continue
        if profile in g.get("profiles", ["fast", "ci", "full"]):
            return g
    return None


def _git(args, cwd=None):
    r = subprocess.run(["git"] + args, cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        raise probes.Indeterminado("git %s fallo: %s"
                                   % (args[0], r.stdout.decode("utf-8", "replace")[-300:]))


def _seed_origin(root, sb, gate, rutas):
    """Repo de origen sintetico con lo minimo que el lanzador necesita leer."""
    origen = os.path.join(sb, "origen")
    os.makedirs(origen)
    for rel in gate.get("copy") or []:
        src, dst = os.path.join(root, rel), os.path.join(origen, rel)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns(
                "__pycache__", "last-run.json"))
        else:
            os.makedirs(os.path.dirname(dst) or origen, exist_ok=True)
            shutil.copy2(src, dst)
    for rel in gate.get("touch") or []:
        p = os.path.join(origen, rel.format(**rutas))
        os.makedirs(os.path.dirname(p) or origen, exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("fichero sintetico del canario de cableado\n")
    _git(["init", "-q"], origen)
    _git(["checkout", "-q", "-b", "main"], origen)
    _git(["add", "-A"], origen)
    _git(["-c", "user.email=canario@trinquete", "-c", "user.name=canario",
          "commit", "-qm", "semilla del canario"], origen)
    return origen


# El stub NO imprime lo que el lanzador le pase: pregunta a la sonda de verdad,
# importada del .gates del propio arbol de trabajo. Comprobar la variable de
# entorno a pelo demostraria que la shell la exporta, no que probes_contract la
# lee — y es probes_contract quien decide contra que contrato se juzga el diff.
_SONDA = """import json, os, sys
root = sys.argv[1]
sys.path.insert(0, os.path.join(root, ".gates"))
import probes_contract
with open(os.path.join(root, ".gates", "manifest.json"), encoding="utf-8") as fh:
    cfg = next(g for g in json.load(fh)["gates"] if g.get("builtin") == "agent_contract")
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    fh.write(probes_contract._agent(root, "HEAD", cfg))
"""


def _stubs(sb, gate, rutas, marca):
    bindir = rutas["bin"]
    os.makedirs(bindir, exist_ok=True)
    sonda = os.path.join(sb, "preguntar-a-la-sonda.py")
    with open(sonda, "w", encoding="utf-8") as fh:
        fh.write(_SONDA)
    work = (gate.get("agent_cwd") or "{sandbox}").format(**rutas)
    agente = os.path.join(bindir, gate.get("agent_bin", "claude"))
    with open(agente, "w", encoding="utf-8") as fh:
        fh.write('#!/bin/sh\nexec python3 "%s" "%s" "%s"\n' % (sonda, work, marca))
    os.chmod(agente, 0o755)
    for nombre in gate.get("stubs") or []:
        p = os.path.join(bindir, nombre)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(p, 0o755)


def cmd_verify(root, profile):
    codes = [canary_loc(root, profile),
             canary_loc_growth(root, profile),
             canary_config_shrink(root, profile),
             canary_contract(root, profile),
             canary_freshness(root, profile),
             canary_agent_wiring(root, profile)]
    real = [c for c in codes if c != SKIPPED]
    if not real:
        sys.stderr.write("Ningun canario aplicaba: esto NO es una verificacion.\n")
        return 2
    return max(real)
