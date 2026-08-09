#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probes_keys.py — como se ESCRIBE una clave: tramos, magnitud y version de formato.

Separado de probes.py por el mismo motivo que probes_graph.py y
probes_contract.py: el limite de 500 LOC lo hace cumplir este runner, asi que el
runner no puede incumplirlo. Y el corte cae en un sitio limpio: probes.py mide
el repo, este fichero decide como se nombra lo que se ha medido.

A diferencia de probes_graph.py y probes_contract.py, este modulo NO se importa
con try/except: probe_loc depende de el, y un fallback silencioso volveria a
emitir claves sin tramo, que es exactamente el agujero que esto viene a cerrar.
Si falta, el runner debe romper y no medir de menos.

Todo stdlib, sintaxis <=3.9.
"""

import json
import os
import re


# ── Tramos ──────────────────────────────────────────────────────────────────
# Un unico umbral (>500) deja el agujero mas grande que ha tenido este runner:
# un fichero que YA esta en el baseline puede crecer sin limite sin generar
# clave nueva. Y añadir a un fichero que ya existe es justo el camino de menor
# resistencia de un agente, o sea el que mas vigilancia necesita.
#
# La clave lleva el tramo cruzado, y el conjunto de claves de una violacion es
# ACUMULATIVO: 3.000 lineas con limite 500 emiten >500, >750, >1000, >1500 y
# >2000. Acumulativo y no "solo el tramo actual" porque con un unico tramo
# ENCOGER tambien inventaria una clave nueva (>1000 pasa a >500, que no esta en
# el baseline) y arreglar el fichero saldria en rojo. Asi crecer solo AÑADE
# claves y encoger solo las QUITA, que es la unica semantica que un trinquete
# de conjuntos puede leer bien.
#
# Multiplicadores y no valores absolutos: el mismo escalon vale para un repo con
# max_lines 500 y para uno con 300, sin reconfigurar nada. Razon ~1,33-1,5 entre
# tramos: lo bastante estrecha para que un fichero no pueda duplicarse en
# silencio, y lo bastante ancha para que añadir una funcion a un fichero que ya
# incumple no enrojezca en cada commit. Una puerta que enrojece siempre acaba en
# --rebaseline de rutina, y un rebaseline de rutina es un trinquete muerto.
BAND_MULTIPLIERS = (1, 1.5, 2, 3, 4, 6, 8, 12, 16)


def bands_for(cfg, limit):
    """Escalera de tramos para un umbral. 'bands' absoluto gana si se declara."""
    b = cfg.get("bands")
    if b:
        got = sorted(set(int(x) for x in b if int(x) >= limit))
        return got or [limit]
    mults = cfg.get("band_multipliers") or BAND_MULTIPLIERS
    return sorted(set(int(limit * m) for m in mults if m >= 1))


def crossed(value, bands):
    """Tramos que `value` supera.

    Por encima del ultimo tramo la escalera se dobla sola. Sin esto el agujero
    original reaparece intacto arriba del todo: un fichero de 8.000 lineas
    podria llegar a 80.000 sin clave nueva.
    """
    out = [b for b in bands if value > b]
    top = bands[-1] if bands else 1
    while value > top * 2:
        top *= 2
        out.append(top)
    return out


# ── Claves desde la salida de una herramienta ───────────────────────────────
# Preferir SIEMPRE formatos máquina (json) sobre parsear prosa: la prosa cambia
# el día que alguien reescribe un mensaje y nadie se entera.

# Borrar TODOS los digitos hacia N tenia el mismo agujero que el loc sin tramos,
# y peor: "complexity of 12" y "complexity of 40" eran literalmente la misma
# clave, asi que una funcion podia triplicar su complejidad sin que la puerta se
# enterase. Pero conservar el numero crudo reintroduce justo el ruido que la N
# venia a quitar: el numero de linea vuelve, y 12 -> 13 enrojece.
#
# El corte esta aqui: se conserva —y EN TRAMOS, no crudo— solo el numero que la
# propia regla declara como medida contra un maximo explicito. Todo lo demas
# (numeros de linea, literales del codigo, el propio maximo) se sigue borrando.
# Por eso el hueco entre la medida y "Maximum allowed is" se exige \D: el valor
# medido es, por construccion, el ultimo numero antes del maximo declarado.
_MEASURED = (
    re.compile(r"(\d+)\D{0,40}?Maximum allowed is (\d+)"),   # reglas core de eslint
    re.compile(r"\((\d+)\s*>\s*(\d+)\)"),                    # C901 de ruff
)


def stable_msgs(msg):
    """Identidades estables de un mensaje de linter: una por tramo cruzado.

    Devuelve lista, no cadena, por el mismo motivo que probe_loc emite claves
    acumuladas: si una complejidad de 40 diera UNA clave `[>30]`, bajarla a 12
    produciria `[>10]`, que no esta en el baseline, y arreglar la funcion
    saldria en rojo.

    Sin medida reconocible el resultado es exactamente el de antes —todos los
    digitos a N—, asi que ningun mensaje que hoy es estable se vuelve ruidoso.
    """
    txt = (msg or "").strip()
    plano = re.sub(r"\d+", "N", txt)
    for rx in _MEASURED:
        m = rx.search(txt)
        if not m:
            continue
        val, top = int(m.group(1)), int(m.group(2))
        if top > 0 and val > top:
            return ["%s [>%d]" % (plano, b)
                    for b in crossed(val, bands_for({}, top))]
        break
    return [plano]


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
                rule = m.get("ruleId") or "?"
                for s in stable_msgs(m.get("message")):
                    keys.append("%s :: %s :: %s" % (rel, rule, s))
        return sorted(set(keys)), len(data)
    if fmt == "ruff-json":
        data = json.loads(stdout)
        keys = ["%s :: %s :: %s" % (_rel(m.get("filename", "?"), root),
                                    m.get("code", "?"), s)
                for m in data for s in stable_msgs(m.get("message"))]
        return sorted(set(keys)), None
    raise ValueError("keys_format desconocido: %s" % fmt)


# ── Version del formato de clave ────────────────────────────────────────────
# Cambiar como se escribe una clave invalida el baseline entero: todas las
# viejas desaparecen y todas las nuevas aparecen a la vez. Sin marca eso llega
# como "387 claves nuevas", que es indistinguible de un desastre real.
#
# La marca se escribe en meta.json junto al denominador y al fingerprint, y se
# compara antes de mirar el baseline. Solo se declara aqui lo que YA ha cambiado
# de formato: la v1 no se comprueba nunca, porque ningun repo la tiene escrita y
# el chequeo saltaria en todas las puertas del parque sin nada que migrar.
KEYFMT = {"loc": 2, "eslint-json": 2, "ruff-json": 2}


def keyfmt_version(gate):
    return KEYFMT.get(gate.get("builtin") or gate.get("keys_format"), 1)
