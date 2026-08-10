#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
canaries_repo.py — canarios que necesitan el REPO de verdad, no un arbol de mentira.

Los de canaries.py se montan sobre un tempdir con dos ficheros sinteticos y
prueban la logica del runner. Estos tres no pueden: el del contrato necesita dos
commits reales en un worktree, el de frescura necesita una copia del propio
runner, y el del cableado necesita ejecutar el lanzador que vive en el repo. Por
eso son mas lentos, mas fragiles y mas faciles de que salgan SKIPPED --- y por
eso van aparte, ademas de por el limite de 500 LOC.

`import gates` va dentro de las funciones, igual que en canaries.py: gates.py
importa este modulo por la cadena y seria un ciclo.

Todo stdlib, sintaxis <=3.9.
"""

import os
import shutil
import subprocess
import sys
import tempfile

import probes
from canaries import SKIPPED, _pick, _veredicto  # noqa: F401


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
