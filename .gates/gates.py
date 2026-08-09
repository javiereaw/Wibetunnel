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

Tres perfiles, por dónde corre cada puerta:
    fast   solo python3 stdlib            pre-push (un hook no tiene pnpm en el PATH)
    ci     fast + ratchets que usan pnpm  CI, cuando las binarias ya son pasos propios
    full   todo, incluidas las binarias   shell interactiva

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

OK = "OK"
VIOLACION = "VIOLACION"
INDETERMINADO = "INDETERMINADO"

# Una sola definicion, en probes.py, junto a la firma que la acompaña.
RUNNER_VERSION = probes.RUNNER_VERSION

# Una bajada sospechosamente grande exige --rebaseline: puede venir de un
# directorio borrado, un glob nuevo en el ignore o un linter que analizo la
# mitad. Pero el porcentaje solo no sirve: con un baseline de 1, bajar a 0 es un
# 100% y es exactamente el resultado que se busca. Hacen falta LAS DOS
# condiciones — porcentaje alto Y una cantidad absoluta que de verdad sorprenda.
DROP_LIMIT = 0.20
DROP_MIN_KEYS = 5

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


# ── Evaluación ──────────────────────────────────────────────────────────────


def eval_binary(gate, root):
    exp = int(gate.get("expected_exit", 0))
    code, so, se, bad = probes.run_cmd(gate["cmd"], root, gate.get("timeout", 300))
    if bad:
        return {"state": INDETERMINADO, "detail": bad}
    if code == exp:
        return {"state": OK, "detail": "exit %s" % code}
    # 12 lineas, no 3: con 3 no se puede diagnosticar nada. Un pytest que falla
    # al recolectar imprime la lista de modulos que no importan, y con tres
    # lineas solo se ve el resumen final ("9 errors during collection"), que no
    # dice cual. Pasó de verdad diagnosticando la CI de quant-smallcap.
    tail = (se or so).strip().splitlines()
    return {"state": VIOLACION,
            "detail": "exit %s (esperado %s)" % (code, exp),
            "output": tail[-12:] if tail else []}


def _gather_keys(gate, root):
    """Devuelve (keys, denom, motivo_indeterminado)."""
    if "builtin" in gate:
        fn = probes.BUILTINS.get(gate["builtin"])
        if fn is None:
            return None, None, "builtin desconocido: %s" % gate["builtin"]
        try:
            keys, denom = fn(gate, root)
        except probes.Indeterminado as e:
            # "No he podido mirar" no es un fallo de la sonda: es el tercer
            # estado, y lleva su propio motivo. No lo disfraces de crash.
            return None, None, str(e)
        except Exception as e:
            return None, None, "sonda fallo: %s" % e
        return keys, denom, None

    code, so, _se, bad = probes.run_cmd(gate["keys_cmd"], root, gate.get("timeout", 300))
    if bad:
        return None, None, bad
    allowed = gate.get("keys_exit_ok", [0, 1])
    if code not in allowed:
        return None, None, "exit %s no esperado (ok: %s)" % (code, allowed)
    try:
        keys, denom = probes.keys_from_output(gate, so, root)
    except Exception as e:
        return None, None, "salida ilegible: %s" % e
    return keys, denom, None


def _guard_denominator(denom, gmeta, allow_rebaseline):
    if denom is None:
        return None
    if denom == 0:
        return "0 ficheros escaneados — glob roto o dependencias sin instalar"
    prev = gmeta.get("denominator")
    if prev is not None and denom < prev and not allow_rebaseline:
        return ("el denominador cayo de %s a %s — posible exclusion nueva; "
                "usa --rebaseline --reason si es legitimo" % (prev, denom))
    return None


def _keyfmt_state(gate, gmeta):
    """(estado, motivo) del FORMATO de clave. Estado: None | 'migrar' | 'roto'.

    Un cambio de formato no puede llegar como "N claves nuevas". Cuando cambia
    como se escribe una clave, cada vieja desaparece y cada nueva aparece de
    golpe: el mismo conjunto de violaciones con otro nombre. Leido como
    violacion, eso pone los cuatro repos en rojo a la vez con un mensaje que no
    dice que hacer. Leido como bajada, congelaria un logro inexistente.
    """
    cur = probes.keyfmt_version(gate)
    if cur <= 1:
        return None, None
    seen = gmeta.get("keyfmt", 1)
    if seen == cur:
        return None, None
    if seen > cur:
        return "roto", ("el baseline usa formato de clave v%s y esta copia del "
                        "runner escribe v%s: es una copia mas vieja, actualizala"
                        % (seen, cur))
    # El "que ha cambiado" se cuenta por version porque las dos migraciones no
    # son iguales, y decir lo mismo de ambas engaña. En la v2 las claves viejas
    # dejan de existir: es el mismo conjunto de violaciones con otro nombre y el
    # baseline no cambia de tamaño. En la v3 la clave base se queda igual y solo
    # se AÑADEN claves `[x>N]`, asi que el baseline CRECE --- y crece justo por
    # las violaciones que hasta ahora eran invisibles, no por deuda nueva.
    if cur >= 3:
        que = ("las claves repetidas en un mismo fichero llevan TRAMO DE CONTEO "
               "(`... [x>1]`, `[x>2]`). La clave base no cambia: solo se añaden "
               "las de repeticion, asi que el baseline CRECE, y lo que aparece "
               "son violaciones que ya estaban y la clave colapsada ocultaba")
    else:
        que = ("las claves llevan TRAMO (`ruta :: >500`, `... [>10]`). Es el "
               "mismo conjunto de violaciones escrito de otra forma, y ninguna "
               "clave vieja puede compararse con una nueva")
    return "migrar", ("el baseline esta en formato de clave v%s y este runner "
                      "escribe v%s: %s. No es una violacion. Migra una sola vez "
                      "con: gates.py --rebaseline --reason \"migracion a claves "
                      "con tramo (runner v%s)\"" % (seen, cur, que, RUNNER_VERSION))


def eval_ratchet(gate, root, meta, allow_rebaseline, first_run=False):
    name = gate["name"]
    keys, denom, bad = _gather_keys(gate, root)
    if bad:
        return {"state": INDETERMINADO, "detail": bad}

    gmeta = meta.get(name, {})
    bad = _guard_denominator(denom, gmeta, allow_rebaseline)
    if bad:
        return {"state": INDETERMINADO, "detail": bad}

    fp = probes.fingerprint(gate, root)
    if fp is not None:
        prev_fp = gmeta.get("fingerprint")
        if prev_fp is not None and prev_fp != fp and not allow_rebaseline:
            return {"state": INDETERMINADO,
                    "detail": "cambio la config/version del tooling (%s -> %s); "
                              "usa --rebaseline --reason" % (prev_fp, fp)}

    common = {"keys": keys, "denominator": denom, "fingerprint": fp}
    base = probes.read_baseline(root, name)
    # Despues de leer el baseline y solo si lo hay: sin baseline no hay formato
    # viejo que migrar, y el mensaje util ahi es el de `--baseline`.
    if base is not None:
        estado, motivo = _keyfmt_state(gate, gmeta)
        if estado and not allow_rebaseline:
            d = dict(common)
            d.update({"state": INDETERMINADO, "detail": motivo})
            return d
        if estado == "migrar":
            # Con --rebaseline la migracion se ejecuta, pero NO se diffea contra
            # el baseline viejo: seria comparar claves que no son comparables y
            # sacar "N claves nuevas" en rojo sobre un cambio que no ha empeorado
            # nada. Se reescribe y se dice cuanto, que es lo unico verificable.
            d = dict(common)
            d.update({"state": OK, "migrado": True,
                      "detail": "formato de clave migrado: %s clave(s) escritas "
                                "(el baseline anterior tenia %s en el formato "
                                "viejo; no son comparables)" % (len(keys), len(base))})
            return d
    if base is None:
        d = dict(common)
        if first_run:
            # `--baseline`: congelar el estado actual es exactamente lo que se pide.
            d.update({"state": OK,
                      "detail": "baseline inicial: %s clave(s) congeladas de %s ficheros"
                                % (len(keys), denom if denom is not None else "?")})
        else:
            d.update({"state": INDETERMINADO,
                      "detail": "sin baseline — corre `gates.py --baseline` la primera vez"})
        return d

    baseset, keyset = set(base), set(keys)
    nuevas = sorted(keyset - baseset)
    idas = sorted(baseset - keyset)

    if nuevas:
        d = dict(common)
        d.update({"state": VIOLACION, "nuevas": nuevas,
                  "detail": "%s clave(s) nueva(s) sobre un baseline de %s"
                            % (len(nuevas), len(base))})
        return d

    res = dict(common)
    res.update({"state": OK, "detail": "%s (baseline %s)" % (len(keys), len(base))})
    if idas:
        drop = float(len(idas)) / max(len(base), 1)
        sospechosa = drop > DROP_LIMIT and len(idas) >= DROP_MIN_KEYS
        if sospechosa and not allow_rebaseline:
            res["state"] = INDETERMINADO
            res["detail"] = ("bajada del %.0f%% (%s claves) — demasiado grande para "
                             "aceptarla sola; usa --rebaseline --reason"
                             % (drop * 100, len(idas)))
            return res
        res["ratchet"] = idas
        res["detail"] = "%s (baseline %s -> %s, el trinquete baja)" % (
            len(keys), len(base), len(keys))
    return res


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
    if not (write_mode or allow_rebaseline or r.get("ratchet")):
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


def run_all(root, profile, write_mode, allow_rebaseline, reason):
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

    for g in gates:
        t0 = time.time()
        if g["type"] == "binary":
            r = eval_binary(g, root)
        elif g["type"] == "ratchet":
            r = eval_ratchet(g, root, meta, allow_rebaseline, first_run=write_mode)
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
    ap.add_argument("--profile", default="full", choices=["fast", "ci", "full"])
    ap.add_argument("--baseline", action="store_true", help="escribe el baseline inicial")
    ap.add_argument("--rebaseline", action="store_true",
                    help="acepta bajada grande o cambio de tooling")
    ap.add_argument("--reason", default="", help="motivo obligatorio con --rebaseline")
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

    if args.rebaseline and not args.reason:
        sys.stderr.write('--rebaseline exige --reason "...": queda escrito en meta.json\n')
        sys.exit(2)

    results, worst = run_all(root, args.profile, args.baseline,
                             args.rebaseline, args.reason)

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
