#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gates_eval.py — decidir el ESTADO de una puerta: OK, VIOLACION o INDETERMINADO.

Aparte de gates.py por el limite de 500 LOC que este mismo runner hace cumplir:
la herramienta que lo aplica no puede incumplirlo. El corte cae donde ya estaba
la frontera conceptual — aqui se JUZGA una puerta, en gates.py se orquestan
todas, se presentan y se persiste el baseline.

No importa gates.py: seria un ciclo. Los tres estados viven aqui y gates.py los
reexporta, asi que `gates.OK` sigue funcionando para canaries.py.

Todo stdlib, sintaxis <=3.9.
"""

import probes

OK = "OK"
VIOLACION = "VIOLACION"
INDETERMINADO = "INDETERMINADO"

# Una bajada sospechosamente grande exige --rebaseline: puede venir de un
# directorio borrado, un glob nuevo en el ignore o un linter que analizo la
# mitad. Pero el porcentaje solo no sirve: con un baseline de 1, bajar a 0 es un
# 100% y es exactamente el resultado que se busca. Hacen falta LAS DOS
# condiciones — porcentaje alto Y una cantidad absoluta que de verdad sorprenda.
DROP_LIMIT = 0.20
DROP_MIN_KEYS = 5



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


def eval_ratchet(gate, root, meta, allow_rebaseline, first_run=False,
                 acepta_config=()):
    name = gate["name"]
    keys, denom, bad = _gather_keys(gate, root)
    if bad:
        return {"state": INDETERMINADO, "detail": bad}

    gmeta = meta.get(name, {})
    # El denominador NO lo cubre --acepta-config a proposito. Que baje significa
    # que han dejado de mirarse ficheros enteros, y eso encoge el baseline
    # cumpliendo el subconjunto igual de bien que un arreglo real: es
    # exactamente el disfraz que el subconjunto no sabe ver. Esa decision se
    # sigue tomando con --rebaseline, que es global y se nota.
    bad = _guard_denominator(denom, gmeta, allow_rebaseline)
    if bad:
        return {"state": INDETERMINADO, "detail": bad}

    # `config_ok` = "acepto que la config de ESTA puerta ha cambiado". No acepta
    # la bajada: mas abajo, una sola clave nueva sigue siendo VIOLACION y una
    # bajada desproporcionada sigue siendo INDETERMINADO. Es la diferencia con
    # --rebaseline, que es global (reescribe las OTRAS puertas del perfil con lo
    # que tengan en ese momento) y ademas escribe baseline desde un estado
    # VIOLACION, o sea que congela en silencio la deuda nueva que encuentre.
    config_ok = name in acepta_config
    fp = probes.fingerprint(gate, root)
    fp_cambio = False
    if fp is not None:
        prev_fp = gmeta.get("fingerprint")
        if prev_fp is not None and prev_fp != fp:
            fp_cambio = True
            if not (allow_rebaseline or config_ok):
                return {"state": INDETERMINADO,
                        "detail": "cambio la config/version del tooling (%s -> %s); "
                                  "usa --acepta-config %s --reason \"...\" si el "
                                  "cambio solo puede QUITAR claves, o --rebaseline "
                                  "--reason si no" % (prev_fp, fp, name)}

    common = {"keys": keys, "denominator": denom, "fingerprint": fp}
    # Se persiste aunque el conjunto de claves no se mueva: un cambio de config
    # aceptado tiene que dejar escrito el fingerprint nuevo o la pasada siguiente
    # vuelve a salir INDETERMINADO por lo mismo.
    if config_ok and fp_cambio:
        common["config_aceptada"] = True
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

    # Este corte es el que le da sentido a --acepta-config: la prueba de que un
    # cambio de config solo ha QUITADO es que el conjunto resultante sea
    # subconjunto del baseline. El dato ya se calculaba aqui; lo que faltaba era
    # llegar hasta el, porque el guard del fingerprint cortaba antes.
    if nuevas:
        d = dict(common)
        d.pop("config_aceptada", None)
        d.update({"state": VIOLACION, "nuevas": nuevas,
                  "detail": "%s clave(s) nueva(s) sobre un baseline de %s"
                            % (len(nuevas), len(base))})
        return d

    res = dict(common)
    res.update({"state": OK, "detail": "%s (baseline %s)" % (len(keys), len(base))})
    if idas:
        drop = float(len(idas)) / max(len(base), 1)
        sospechosa = drop > DROP_LIMIT and len(idas) >= DROP_MIN_KEYS
        # --acepta-config tampoco cubre esto. Aceptar el cambio de config no es
        # aceptar CUALQUIER bajada que traiga: una exclusion que se lleve por
        # delante media puerta cumple el subconjunto sin problema.
        if sospechosa and not allow_rebaseline:
            res["state"] = INDETERMINADO
            res["detail"] = ("bajada del %.0f%% (%s claves) — demasiado grande para "
                             "aceptarla sola; usa --rebaseline --reason"
                             % (drop * 100, len(idas)))
            return res
        res["ratchet"] = idas
        res["detail"] = "%s (baseline %s -> %s, el trinquete baja)" % (
            len(keys), len(base), len(keys))
    if res.get("config_aceptada"):
        res["detail"] += " · config nueva aceptada, 0 claves nuevas"
    return res
