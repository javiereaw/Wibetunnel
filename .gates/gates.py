#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gates.py — runner de puertas con trinquete. Portátil, python3 stdlib, sintaxis <=3.9.

Por qué python3 y no node: un git hook NO hereda el PATH de la shell interactiva.
Con nvm, `node` y `pnpm` no existen ahí; `python3` sí, en /usr/bin.

Tres estados, nunca dos:
    OK             la puerta pasa                -> exit 0
    VIOLACION      hay algo nuevo                -> exit 1
    INDETERMINADO  no se pudo medir             -> exit 2, y NUNCA se escribe baseline

INDETERMINADO existe porque el exit code no sirve de señal de salud: hay
validadores que salen 1 funcionando bien y otros que salen 0 siempre. Confundir
"petó" con "cero violaciones" congelaría un baseline falso.

Dos formas de reconciliar, y NO son intercambiables:

    --rebaseline        global y sin condiciones. Reescribe TODAS las puertas
                        del perfil, y escribe baseline incluso desde un estado
                        VIOLACION: sale rojo una vez y a la siguiente pasada la
                        deuda nueva está congelada en verde. Es el martillo.
    --acepta-config P   solo la puerta P, y solo el fingerprint. La bajada la
                        sigue juzgando el trinquete: una sola clave nueva es
                        VIOLACION y una bajada desproporcionada es
                        INDETERMINADO. Es para el caso real y frecuente —
                        cambiar la config para dejar de medir ruido— sin abrir
                        la puerta a todo lo demás.

Perfiles, por dónde corre cada puerta. Son cadenas libres, no un enum: el
manifiesto de cada repo declara los suyos, y un perfil que no existe sale
INDETERMINADO ("ninguna puerta declara el perfil X"), nunca un verde vacío.
Los tres del camino del commit:
    fast   solo python3 stdlib            pre-push (un hook no tiene pnpm en el PATH)
    ci     fast + ratchets que usan pnpm  CI, cuando las binarias ya son pasos propios
    full   todo, incluidas las binarias   shell interactiva

Y uno que NO va en ese camino:
    temporal   puertas que se disparan solas, por el paso del tiempo y no por un
               commit. Van en un CRON. Toda la vigilancia de este runner era
               atómica, estática y DISPARADA POR UN CAMBIO — y los incidentes
               reales del parque no fueron de esa forma: el cron caído que solo
               escribía en su log, la analítica que dejó de cargar, la factura
               de Gemini. Ningún agente disparaba esas puertas porque no hay
               diff que mirar.

'ci' existe porque un workflow que ya corre `test`/`lint`/`typecheck` como pasos
con nombre propio no debe correrlos otra vez dentro del runner: es tiempo
duplicado y encima peor atribuido (en rojo se lee "Puertas", no "Unit tests").
Pero sacar el perfil entero se llevaba por delante los ratchets que necesitan
pnpm —eslint-estructural— que NO estaban duplicados por ningún paso. 'ci' es
justo esa diferencia: todos los ratchets, ninguna puerta binaria.

Uso:
    gates.py                              perfil 'full'
    gates.py --profile fast               puertas baratas (pre-push)
    gates.py --profile ci                 ratchets sin puertas binarias
    gates.py --baseline                   escribe el baseline inicial
    gates.py --rebaseline --reason "..."  acepta bajada grande o cambio de tooling
    gates.py --acepta-config P --reason   acepta config nueva en la puerta P si NO trae claves nuevas
    gates.py --verify                     canario: demuestra que la puerta bloquea
    gates.py --sign                       firma el runner (solo en la canonica)
    gates.py --status                     salida JSON
"""

import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canaries  # noqa: E402
import probes  # noqa: E402

# Reexportados desde gates_eval para que `gates.OK` siga existiendo: canaries.py
# y cualquier consumidor externo los leen de aqui.
from gates_eval import (DROP_LIMIT, DROP_MIN_KEYS, INDETERMINADO,  # noqa: F401,E402
                        OK, VIOLACION, eval_binary, eval_ratchet)

# Una sola definicion, en probes.py, junto a la firma que la acompaña.
RUNNER_VERSION = probes.RUNNER_VERSION

IS_TTY = sys.stdout.isatty()


def c(code, text):
    return text if not IS_TTY else "\033[%sm%s\033[0m" % (code, text)


def red(t):
    return c("31", t)


def green(t):
    return c("32", t)


def yellow(t):
    return c("33", t)


def dim(t):
    return c("2", t)


def repo_root():
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=15)
        if out.returncode == 0:
            return out.stdout.decode("utf-8", "replace").strip()
    except Exception:
        pass
    return os.getcwd()


# ── Orquestación ────────────────────────────────────────────────────────────


def load_manifest(root):
    p = os.path.join(probes.gates_dir(root), "manifest.json")
    if not os.path.exists(p):
        sys.stderr.write("No hay %s. Este repo no tiene trinquete instalado.\n" % p)
        sys.exit(2)
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)


def select_gates(manifest, profile):
    out = []
    for g in manifest.get("gates", []):
        if g.get("exempt"):
            continue
        # Los canarios se declaran en el mismo manifiesto pero NO son puertas:
        # solo corren con --verify. Sin este filtro saldrian como "tipo
        # desconocido" —o sea INDETERMINADO— en cada pasada normal.
        if g.get("type") == "canary":
            continue
        # El default cubre las puertas viejas del manifiesto que no declaran
        # 'profiles': son ratchets baratos, luego entran tambien en 'ci'.
        if profile in g.get("profiles", ["fast", "ci", "full"]):
            out.append(g)
    return out


def _persist(gate, r, root, meta, write_mode, allow_rebaseline, reason):
    """Escribe baseline solo desde un estado no-indeterminado."""
    if gate["type"] != "ratchet" or r["state"] == INDETERMINADO:
        return
    # allow_rebaseline tiene que escribir aunque el conjunto de claves NO haya
    # cambiado: si no, un --rebaseline reconcilia solo las puertas que ademas
    # bajaron, y las otras se quedan con el denominador o el fingerprint viejo
    # y vuelven a salir INDETERMINADO en la siguiente pasada.
    # `config_aceptada` solo vale desde OK. Nunca se limpia sola en VIOLACION
    # (eval_ratchet la quita de ese resultado), pero el estado se comprueba aqui
    # tambien: es justo el fallo que tiene --rebaseline —escribir baseline desde
    # un estado VIOLACION, congelando la deuda nueva— y no se replica.
    config_ok = r.get("config_aceptada") and r["state"] == OK
    if not (write_mode or allow_rebaseline or config_ok or r.get("ratchet")):
        return
    if r.get("keys") is None:
        return
    probes.write_baseline(root, gate["name"], r["keys"])
    gm = meta.setdefault(gate["name"], {})
    if r.get("denominator") is not None:
        gm["denominator"] = r["denominator"]
    if r.get("fingerprint") is not None:
        gm["fingerprint"] = r["fingerprint"]
    kf = probes.keyfmt_version(gate)
    if kf > 1:
        gm["keyfmt"] = kf
    if allow_rebaseline and reason:
        gm["rebaseline_reason"] = reason
    if config_ok and reason:
        gm["config_reason"] = reason


def run_all(root, profile, write_mode, allow_rebaseline, reason,
            acepta_config=()):
    manifest = load_manifest(root)
    meta = probes.read_meta(root)
    results = []
    worst = 0

    gates = select_gates(manifest, profile)
    # Cero puertas seleccionadas NO es "todo bien": es que el perfil no existe en
    # este manifiesto. Visto en quant-smallcap el 08-08-2026 — su gates.py acepta
    # --profile ci pero ninguna puerta lo declara, asi que el perfil corria nada y
    # salia 0. Un verde que no ha mirado nada es peor que un rojo.
    if not gates:
        results.append({"name": "perfil-%s" % profile, "type": "meta",
                        "state": INDETERMINADO, "secs": 0.0,
                        "detail": "ninguna puerta declara el perfil '%s': "
                                  "no se ha comprobado NADA" % profile})
        return results, 2

    # Un nombre mal escrito en --acepta-config no puede pasar en silencio: el
    # runner saldria 2 por el fingerprint que se pretendia aceptar y el mensaje
    # hablaria de otra cosa. Lo mismo si la puerta existe pero no corre en este
    # perfil: se estaria aceptando un cambio en algo que no se ha medido.
    corren = set(g["name"] for g in gates)
    huerfanas = sorted(set(acepta_config) - corren)
    if huerfanas:
        results.append({"name": "acepta-config", "type": "meta",
                        "state": INDETERMINADO, "secs": 0.0,
                        "detail": "--acepta-config nombra puerta(s) que no corren "
                                  "en el perfil '%s': %s" % (profile, ", ".join(huerfanas))})
        return results, 2

    for g in gates:
        t0 = time.time()
        if g["type"] == "binary":
            r = eval_binary(g, root)
        elif g["type"] == "ratchet":
            r = eval_ratchet(g, root, meta, allow_rebaseline,
                             first_run=write_mode, acepta_config=acepta_config)
        else:
            r = {"state": INDETERMINADO, "detail": "tipo desconocido: %s" % g["type"]}
        r["name"] = g["name"]
        r["type"] = g["type"]
        r["secs"] = round(time.time() - t0, 1)
        results.append(r)

        _persist(g, r, root, meta, write_mode, allow_rebaseline, reason)

        if r["state"] == VIOLACION:
            worst = max(worst, 1)
        elif r["state"] == INDETERMINADO:
            worst = max(worst, 2)

    # Monotono a proposito: solo sube. Es lo que permite a la sonda de frescura
    # detectar que alguien ha metido una copia mas vieja del runner — si aqui se
    # escribiera siempre la version actual, el primer run tras el downgrade
    # borraria la unica prueba que hay dentro del repo. Bajarlo exige
    # --rebaseline, igual que cualquier otra bajada del trinquete.
    prev = meta.get("_runner_version")
    if allow_rebaseline or not isinstance(prev, int) or RUNNER_VERSION > prev:
        meta["_runner_version"] = RUNNER_VERSION
    probes.write_meta(root, meta)
    return results, worst


def report(results, profile):
    print("")
    print("  trinquete · perfil %s" % profile)
    print("  " + "-" * 58)
    for r in results:
        st = r["state"]
        mark = green("  OK  ") if st == OK else (
            red(" FALLA") if st == VIOLACION else yellow("  ??  "))
        print("  %s  %-22s %s" % (mark, r["name"], dim(r.get("detail", ""))))
        for k in r.get("nuevas", [])[:10]:
            print("            %s %s" % (red("+"), k))
        if len(r.get("nuevas", [])) > 10:
            print("            %s y %s mas" % (red("+"), len(r["nuevas"]) - 10))
        for k in r.get("ratchet", [])[:5]:
            print("            %s %s" % (green("-"), k))
        for line in r.get("output", []):
            print("            %s" % dim(line[:100]))
    # El recuento va SIEMPRE, tambien en verde. Un log de CI que solo dice "OK"
    # no distingue "ocho puertas pasaron" de "no corrio ninguna": es exactamente
    # la mina que tenia quant-smallcap, donde --profile ci ejecutaba cero puertas
    # y salia 0. El numero es lo unico que lo delata de un vistazo.
    n = len(results)
    ok = sum(1 for r in results if r["state"] == OK)
    ko = sum(1 for r in results if r["state"] == VIOLACION)
    ind = n - ok - ko
    print("  " + "-" * 58)
    print("  %d puerta(s) ejecutada(s): %s, %s, %s" % (
        n, green("%d OK" % ok), red("%d en rojo" % ko),
        yellow("%d indeterminada(s)" % ind)))
    print("")


def cmd_sign(root):
    """Firma el runner. Solo tiene sentido en la fuente canonica."""
    try:
        digest = probes.sign_runner(probes.gates_dir(root))
    except probes.Indeterminado as e:
        sys.stderr.write("%s\n" % e)
        return 2
    print("  runner v%s firmado: %s" % (RUNNER_VERSION, digest))
    print("  " + dim("sincroniza las copias vendorizadas antes de commitear"))
    return 0



def main():
    ap = argparse.ArgumentParser(description="Runner de puertas con trinquete")
    # Sin `choices`: los perfiles los declara el manifiesto de cada repo, no
    # este fichero. Un nombre inventado no cuela igualmente --- run_all sale
    # INDETERMINADO si ninguna puerta lo declara, que es mas estricto que el
    # enum: el enum dejaba pasar `--profile ci` en un repo donde ci no existia
    # (paso en quant-smallcap) y ese si salia 0 sin mirar nada.
    ap.add_argument("--profile", default="full",
                    help="fast | ci | full | temporal | el que declare el manifiesto")
    ap.add_argument("--baseline", action="store_true", help="escribe el baseline inicial")
    ap.add_argument("--rebaseline", action="store_true",
                    help="acepta bajada grande o cambio de tooling")
    ap.add_argument("--acepta-config", action="append", default=[],
                    metavar="PUERTA", dest="acepta_config",
                    help="acepta el fingerprint nuevo de esa puerta si el "
                         "conjunto de claves es subconjunto del baseline "
                         "(repetible o separado por comas)")
    ap.add_argument("--reason", default="",
                    help="motivo obligatorio con --rebaseline y --acepta-config")
    ap.add_argument("--verify", action="store_true", help="canario")
    ap.add_argument("--sign", action="store_true",
                    help="firma el runner (solo en la fuente canonica)")
    ap.add_argument("--status", action="store_true", help="salida JSON")
    args = ap.parse_args()

    root = repo_root()

    if args.sign:
        sys.exit(cmd_sign(root))

    if args.verify:
        sys.exit(canaries.cmd_verify(root, args.profile))

    acepta = set()
    for item in args.acepta_config:
        acepta.update(p.strip() for p in item.split(",") if p.strip())

    if args.rebaseline and not args.reason:
        sys.stderr.write('--rebaseline exige --reason "...": queda escrito en meta.json\n')
        sys.exit(2)
    if acepta and not args.reason:
        sys.stderr.write('--acepta-config exige --reason "...": queda escrito en meta.json\n')
        sys.exit(2)

    results, worst = run_all(root, args.profile, args.baseline,
                             args.rebaseline, args.reason, acepta)

    try:
        stamp = {"when": int(time.time()), "profile": args.profile,
                 "states": dict((r["name"], r["state"]) for r in results)}
        with open(os.path.join(probes.gates_dir(root), "last-run.json"),
                  "w", encoding="utf-8") as fh:
            json.dump(stamp, fh, indent=2)
    except Exception:
        pass

    if args.status:
        print(json.dumps({"results": results, "exit": worst},
                         indent=2, ensure_ascii=False))
        sys.exit(worst)

    report(results, args.profile)
    if worst == 1:
        print("  " + red("Puertas en rojo. El commit/push no debe seguir."))
    elif worst == 2:
        print("  " + yellow("INDETERMINADO: no se pudo medir. Falla cerrado a proposito."))
    sys.exit(worst)


if __name__ == "__main__":
    main()
