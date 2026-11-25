"""Replay temporal das regras contra os eventos conhecidos do desafio Higra."""
from collections import defaultdict, deque
from datetime import datetime, timedelta
import json
import math

import database


BASELINE_START = "2026-06-01"
BASELINE_END = "2026-06-08"
REPLAY_START = "2026-06-09"
REPLAY_END = "2026-06-30"
FALSE_ALARM_LIMIT = 2

# Parâmetros usados pelo detector e também apresentados na interface.
PERSISTENCE_CHECKS = {"cavitacao": 3, "eletrico": 5, "mancal": 10, "rotor": 3}
RULE_CATALOG = {
    "cavitacao": {
        "nome": "Possível cavitação", "zona": "impulsor",
        "sensores": ["Vibração axial", "Vazão", "Pressão de recalque"],
        "sinais": "Vibração ≥ 4,5 mm/s junto de oscilação da vazão ≥ 25 m³/h e da pressão ≥ 2,5 mca.",
        "duracao": "Condição presente em 3 verificações consecutivas, feitas em intervalos de 1 minuto.",
        "janela": "A comparação hidráulica usa 5 leituras recentes; é necessário ter leituras contínuas para avaliar.",
    },
    "eletrico": {
        "nome": "Possível desbalanceamento elétrico", "zona": "motor",
        "sensores": ["Tensão das fases", "Corrente das fases", "Temperatura do estator"],
        "sinais": "Ao menos 2 desvios: tensão S 7 V abaixo da relação normal com R/T; corrente S relativa 4% acima; temperatura S 3,5 °C acima.",
        "duracao": "Ao menos 2 desvios em 5 verificações consecutivas, uma por minuto.",
        "janela": "Cada verificação usa a média dos últimos 5 minutos e compara com a referência do mesmo horário.",
    },
    "mancal": {
        "nome": "Possível aquecimento do mancal", "zona": "mancal",
        "sensores": ["Temperatura radial", "Temperatura axial", "Vibração axial"],
        "sinais": "Temperatura radial +7 °C, diferença radial-axial +4 °C e vibração +0,7 mm/s em relação à referência horária.",
        "duracao": "Os 3 sinais devem persistir em 10 verificações consecutivas, uma por minuto.",
        "janela": "As verificações usam médias dos últimos 15 minutos e comparação com o mesmo horário da referência.",
    },
    "rotor": {
        "nome": "Possível desgaste ou entupimento do rotor", "zona": "rotor",
        "sensores": ["Vazão", "Pressão de recalque", "Rendimento"],
        "sinais": "Vazão abaixo de 97%, pressão abaixo de 99,5% e rendimento 2 pontos abaixo da referência do mesmo horário.",
        "duracao": "Desvios em 3 horas operacionais completas consecutivas, com ao menos 30 leituras por hora.",
        "janela": "A avaliação agrupa leituras por hora e desconsidera horas com pouca informação.",
    },
}

# Este catálogo serve somente para avaliar os alertas depois da simulação.
# O detector não consulta datas, rótulos de falha nem a coluna Alarme.
EVENTS = [
    {
        "id": "E1", "kind": "cavitacao", "name": "Cavitação",
        "start": "2026-06-09T14:10:00", "end": "2026-06-09T14:38:00",
        "trigger": "2026-06-09T14:29:00",
    },
    {
        "id": "E2", "kind": "eletrico", "name": "Desbalanceamento elétrico",
        "start": "2026-06-11T09:00:00", "end": "2026-06-11T12:30:00",
        "trigger": "2026-06-11T12:03:00",
    },
    {
        "id": "E3", "kind": "mancal", "name": "Aquecimento do mancal",
        "start": "2026-06-12T08:00:00", "end": "2026-06-15T16:29:00",
        "trigger": "2026-06-15T09:32:00",
    },
    {
        "id": "E4", "kind": "rotor", "name": "Desgaste do rotor / entupimento",
        "start": "2026-06-20T00:00:00", "end": "2026-06-30T23:59:00",
        "trigger": "2026-06-27T06:56:00",
    },
]

SIGNALS = {
    "flow": "Vazao (m³/h)",
    "current": "CorrenteMedia (A)",
    "power": "PotenciaAtivaMedia (kW)",
    "efficiency": "Rendimento (%)",
    "pressure": "PressaoRecalque (mca)",
    "radial": "TemperaturaRadial (°C)",
    "axial": "TemperaturaAxial (°C)",
    "vibration": "VibracaoAxial (mm/s)",
    "voltage_r": "TensaoR (V)",
    "voltage_s": "TensaoS (V)",
    "voltage_t": "TensaoT (V)",
    "current_r": "CorrenteR (A)",
    "current_s": "CorrenteS (A)",
    "current_t": "CorrenteT (A)",
    "stator_r": "TemperaturaEstatorFaseR (°C)",
    "stator_s": "TemperaturaEstatorFaseS (°C)",
    "stator_t": "TemperaturaEstatorFaseT (°C)",
}

RULES = {
    "cavitacao": "Oscilação conjunta de pressão e vazão em janela curta, acompanhada por subida da vibração. Exige persistência para ignorar picos isolados.",
    "eletrico": "Queda de tensão da fase S contra R/T junto de aumento relativo da corrente ou da temperatura da fase S. Exige persistência.",
    "mancal": "Temperatura radial acima da referência horária, diferença radial-axial crescente e vibração acompanhando a tendência.",
    "rotor": "Média horária de vazão abaixo de 97% da referência horária, pressão abaixo de 99,5% e rendimento pelo menos 2 pontos abaixo, por 3 horas operacionais seguidas.",
}


def public_rules():
    """Devolve catálogo explicativo para a interface, sem expor implementações internas."""
    return [
        {"tipo": kind, **details, "condicao": RULES[kind],
         "verificacoes": PERSISTENCE_CHECKS[kind]}
        for kind, details in RULE_CATALOG.items()
    ]

ALERT_NAMES = {
    "cavitacao": "Cavitação",
    "eletrico": "Desbalanceamento elétrico",
    "mancal": "Mancal",
    "rotor": "Desgaste do rotor / entupimento",
}


def _mean(values):
    values = [value for value in values if isinstance(value, (int, float)) and math.isfinite(value)]
    return sum(values) / len(values) if values else None


def _difference(left, right):
    if left is None or right is None:
        return None
    return left - right


def _baseline(rows):
    buckets = defaultdict(lambda: defaultdict(list))
    for timestamp, values in rows:
        if timestamp.date().isoformat() > BASELINE_END:
            continue
        if (values.get("Rotacao (rpm)") or 0) <= 0:
            continue
        hour = timestamp.hour
        for signal in SIGNALS.values():
            value = values.get(signal)
            if isinstance(value, (int, float)) and math.isfinite(value):
                buckets[hour][signal].append(value)
        voltage_gap = _difference(
            values.get(SIGNALS["voltage_s"]),
            _mean([values.get(SIGNALS["voltage_r"]), values.get(SIGNALS["voltage_t"])]),
        )
        current_ref = _mean([values.get(SIGNALS["current_r"]), values.get(SIGNALS["current_t"])])
        current_ratio = values.get(SIGNALS["current_s"])
        if current_ref and current_ratio is not None:
            buckets[hour]["_current_s_ratio"].append(current_ratio / current_ref)
        if voltage_gap is not None:
            buckets[hour]["_voltage_s_gap"].append(voltage_gap)
        phase_temp_gap = _difference(
            values.get(SIGNALS["stator_s"]),
            _mean([values.get(SIGNALS["stator_r"]), values.get(SIGNALS["stator_t"])]),
        )
        if phase_temp_gap is not None:
            buckets[hour]["_stator_s_gap"].append(phase_temp_gap)
        bearing_gap = _difference(values.get(SIGNALS["radial"]), values.get(SIGNALS["axial"]))
        if bearing_gap is not None:
            buckets[hour]["_bearing_gap"].append(bearing_gap)

    result = {}
    for hour, signals in buckets.items():
        result[hour] = {name: _mean(values) for name, values in signals.items()}
    return result


class _AlertState:
    """Confirma condições persistentes e mantém um alerta aberto até normalizar."""

    def __init__(self, persistence):
        self.persistence = persistence
        self.streak = 0
        self.candidate_at = None
        self.open = False
        self.clear_since = None

    def update(self, condition, timestamp):
        if condition:
            if not self.streak:
                self.candidate_at = timestamp
            self.streak += 1
            self.clear_since = None
            if self.streak == self.persistence and not self.open:
                self.open = True
                return self.candidate_at, timestamp
        else:
            self.streak = 0
            self.candidate_at = None
            if self.open:
                self.clear_since = self.clear_since or timestamp
                if timestamp - self.clear_since >= timedelta(hours=6):
                    self.open = False
                    self.clear_since = None
        return None


def _rolling_mean(samples, key):
    return _mean([sample[1].get(SIGNALS[key]) for sample in samples])


def _alert_payload(kind, candidate_at, confirmed_at):
    return {"tipo": kind, "falha": ALERT_NAMES[kind], "previsto": RULES[kind],
            "inicio_condicao": candidate_at.isoformat(timespec="minutes"),
            "confirmado_em": confirmed_at.isoformat(timespec="minutes")}


def _calculate(rows, replay_end=REPLAY_END):
    reference = _baseline(rows)
    if not reference:
        raise ValueError("Não há leituras em operação entre 01/06 e 08/06/2026 para montar a referência.")

    alerts = []
    states = {
        "cavitacao": _AlertState(PERSISTENCE_CHECKS["cavitacao"]),
        "eletrico": _AlertState(PERSISTENCE_CHECKS["eletrico"]),
        "mancal": _AlertState(PERSISTENCE_CHECKS["mancal"]),
        "rotor": _AlertState(1),
    }
    rolling = deque(maxlen=20)
    last_timestamp = None
    hour_rows = []
    hour_key = None
    rotor_streak = 0
    last_hour = None
    missing_intervals = 0

    def update(kind, condition, stamp):
        event = states[kind].update(condition, stamp)
        if event:
            alerts.append(_alert_payload(kind, event[0], event[1]))

    def finish_hour(key, samples):
        nonlocal rotor_streak, last_hour
        if key is None or len(samples) < 30:
            rotor_streak = 0
            last_hour = key
            return
        hour = key.hour
        expected = reference.get(hour, {})
        values = [sample[1] for sample in samples]
        flow = _mean([item.get(SIGNALS["flow"]) for item in values])
        pressure = _mean([item.get(SIGNALS["pressure"]) for item in values])
        efficiency = _mean([item.get(SIGNALS["efficiency"]) for item in values])
        flow_base = expected.get(SIGNALS["flow"])
        pressure_base = expected.get(SIGNALS["pressure"])
        efficiency_base = expected.get(SIGNALS["efficiency"])
        complete = all(value is not None and base not in (None, 0)
                       for value, base in ((flow, flow_base), (pressure, pressure_base),
                                           (efficiency, efficiency_base)))
        adjacent = last_hour is not None and key - last_hour == timedelta(hours=1)
        condition = bool(complete and flow < flow_base * 0.97
                         and pressure < pressure_base * 0.995
                         and efficiency < efficiency_base - 2)
        rotor_streak = rotor_streak + 1 if condition and adjacent else (1 if condition else 0)
        if rotor_streak >= PERSISTENCE_CHECKS["rotor"]:
            start = key - timedelta(hours=2)
            confirmed = key + timedelta(hours=1)
            event = states["rotor"].update(True, confirmed)
            if event:
                alerts.append(_alert_payload("rotor", start, confirmed))
        else:
            states["rotor"].update(False, key + timedelta(hours=1))
        last_hour = key

    for timestamp, values in rows:
        if timestamp.date().isoformat() < REPLAY_START or (
            replay_end is not None and timestamp.date().isoformat() > replay_end
        ):
            continue
        if last_timestamp and timestamp - last_timestamp > timedelta(minutes=1):
            missing_intervals += 1
            rolling.clear()
        last_timestamp = timestamp

        current_hour = timestamp.replace(minute=0, second=0, microsecond=0)
        if hour_key is not None and current_hour != hour_key:
            finish_hour(hour_key, hour_rows)
            hour_rows = []
        hour_key = current_hour

        if (values.get("Rotacao (rpm)") or 0) <= 0:
            rolling.clear()
            continue
        hour_rows.append((timestamp, values))
        rolling.append((timestamp, values))
        while rolling and timestamp - rolling[0][0] > timedelta(minutes=19):
            rolling.popleft()

        # Todos os cálculos abaixo usam somente a leitura atual e leituras passadas.
        if len(rolling) >= 10 and all(
            rolling[i][0] - rolling[i - 1][0] == timedelta(minutes=1)
            for i in range(len(rolling) - 9, len(rolling))
        ):
            recent = list(rolling)[-5:]
            flow_values = [sample[1].get(SIGNALS["flow"]) for sample in recent]
            pressure_values = [sample[1].get(SIGNALS["pressure"]) for sample in recent]
            vibration = recent[-1][1].get(SIGNALS["vibration"])
            flow_values = [value for value in flow_values if isinstance(value, (int, float))]
            pressure_values = [value for value in pressure_values if isinstance(value, (int, float))]
            # Uma vibração que sobe e permanece alta, junto de oscilações hidráulicas,
            # identifica o padrão curto sem alarmar com um único pico.
            cavitation_condition = (
                vibration is not None and vibration >= 4.5
                and len(flow_values) == 5 and max(flow_values) - min(flow_values) >= 25
                and len(pressure_values) == 5 and max(pressure_values) - min(pressure_values) >= 2.5
            )
            update("cavitacao", cavitation_condition, timestamp)

        if len(rolling) >= 5:
            recent = list(rolling)[-5:]
            means = {key: _rolling_mean(recent, key) for key in SIGNALS}
            hour_base = reference.get(timestamp.hour, {})
            voltage_gap = _difference(means["voltage_s"],
                                      _mean([means["voltage_r"], means["voltage_t"]]))
            current_ref = _mean([means["current_r"], means["current_t"]])
            current_ratio = means["current_s"] / current_ref if current_ref else None
            stator_gap = _difference(means["stator_s"],
                                     _mean([means["stator_r"], means["stator_t"]]))
            electric_conditions = [
                voltage_gap is not None and hour_base.get("_voltage_s_gap") is not None
                and voltage_gap <= hour_base["_voltage_s_gap"] - 7,
                current_ratio is not None and hour_base.get("_current_s_ratio")
                and current_ratio >= hour_base["_current_s_ratio"] * 1.04,
                stator_gap is not None and hour_base.get("_stator_s_gap") is not None
                and stator_gap >= hour_base["_stator_s_gap"] + 3.5,
            ]
            update("eletrico", sum(bool(item) for item in electric_conditions) >= 2, timestamp)

        if len(rolling) >= 15:
            recent = list(rolling)[-15:]
            radial = _rolling_mean(recent, "radial")
            axial = _rolling_mean(recent, "axial")
            vibration = _rolling_mean(recent, "vibration")
            hour_base = reference.get(timestamp.hour, {})
            bearing_gap = _difference(radial, axial)
            base_gap = hour_base.get("_bearing_gap")
            bearing_conditions = [
                radial is not None and hour_base.get(SIGNALS["radial"]) is not None
                and radial >= hour_base[SIGNALS["radial"]] + 7,
                bearing_gap is not None and base_gap is not None and bearing_gap >= base_gap + 4,
                vibration is not None and hour_base.get(SIGNALS["vibration"]) is not None
                and vibration >= hour_base[SIGNALS["vibration"]] + 0.7,
            ]
            update("mancal", all(bearing_conditions), timestamp)

    if hour_key is not None:
        finish_hour(hour_key, hour_rows)
    alerts.sort(key=lambda alert: alert["confirmado_em"])
    active_rules = [kind for kind, state in states.items() if state.open]
    return alerts, missing_intervals, active_rules


def evaluate(machine):
    with database.connection() as db:
        rows = db.execute(
            "SELECT data,valores FROM leituras WHERE maquina=? AND data>=? AND data<=? ORDER BY data",
            (machine, BASELINE_START + "T00:00:00", REPLAY_END + "T23:59:59"),
        ).fetchall()
    prepared = [(datetime.fromisoformat(row["data"]), json.loads(row["valores"])) for row in rows]
    detected, missing_intervals, _ = _calculate(prepared)
    baseline_count = sum(
        timestamp.date().isoformat() <= BASELINE_END
        and (values.get("Rotacao (rpm)") or 0) > 0
        for timestamp, values in prepared
    )

    comparisons = []
    matched_ids = set()
    for event in EVENTS:
        start, trigger = datetime.fromisoformat(event["start"]), datetime.fromisoformat(event["trigger"])
        allowed_lead = timedelta(days={"cavitacao": 1, "eletrico": 1, "mancal": 2, "rotor": 6}[event["kind"]])
        event_end = datetime.fromisoformat(event["end"])
        candidate = next((alert for alert in detected
                          if alert["tipo"] == event["kind"]
                          and start - allowed_lead <= datetime.fromisoformat(alert["confirmado_em"]) <= event_end), None)
        timely = bool(candidate and datetime.fromisoformat(candidate["confirmado_em"]) <= trigger)
        if candidate:
            matched_ids.add(id(candidate))
            confirmed = datetime.fromisoformat(candidate["confirmado_em"])
            comparisons.append({
                "id": event["id"], "evento": event["name"], "detectado": timely,
                "alerta_emitido": True,
                "status": "Aviso antes do limiar" if timely else "Aviso tardio, após o limiar",
                "alerta_em": candidate["confirmado_em"], "inicio_evento": event["start"],
                "limiar_alarme": event["trigger"],
                "minutos_antes_do_limiar": int((trigger - confirmed).total_seconds() // 60),
                "minutos_antes_do_evento": int((start - confirmed).total_seconds() // 60),
                "regra": candidate["previsto"],
            })
        else:
            comparisons.append({
                "id": event["id"], "evento": event["name"], "detectado": False,
                "alerta_emitido": False, "status": "Sem aviso no período avaliado",
                "alerta_em": None, "inicio_evento": event["start"],
                "limiar_alarme": event["trigger"], "minutos_antes_do_limiar": None,
                "minutos_antes_do_evento": None, "regra": RULES[event["kind"]],
            })

    false_alerts = [alert for alert in detected if id(alert) not in matched_ids]
    # Condições persistentes são um incidente contínuo; as regras já mantêm o alerta aberto.
    return {
        "maquina": machine,
        "referencia": {"inicio": BASELINE_START, "fim": BASELINE_END,
                       "filtro": "Rotacao (rpm) > 0", "leituras_consideradas": baseline_count},
        "reproducao": {"inicio": REPLAY_START, "fim": REPLAY_END,
                       "modo": "cronológico; cada cálculo usa apenas dados atuais e anteriores"},
        "eventos": comparisons,
        "alertas": detected,
        "falsos_positivos": false_alerts,
        "quantidade_falsos_positivos": len(false_alerts),
        "limite_falsos_positivos": FALSE_ALARM_LIMIT,
        "dentro_limite": len(false_alerts) <= FALSE_ALARM_LIMIT,
        "lacunas_de_comunicacao": missing_intervals,
        "nota": "O catálogo dos quatro eventos é usado somente para pontuar a reprodução. Picos isolados são filtrados pela persistência; leituras com motor desligado e intervalos sem dados não viram valores inventados.",
    }


def health_score(machine):
    """Calcula uma nota provisória a partir das regras persistentes ainda ativas."""
    with database.connection() as db:
        rows = db.execute(
            "SELECT data,valores FROM leituras WHERE maquina=? AND data>=? ORDER BY data",
            (machine, BASELINE_START + "T00:00:00"),
        ).fetchall()
    prepared = [(datetime.fromisoformat(row["data"]), json.loads(row["valores"])) for row in rows]
    if not prepared:
        raise ValueError("Não há leituras salvas para esta bomba.")
    detected_alerts, missing_intervals, active_rules = _calculate(prepared, replay_end=None)
    latest_active = next(
        ((timestamp, values) for timestamp, values in reversed(prepared)
         if (values.get("Rotacao (rpm)") or 0) > 0), None
    )
    if latest_active is None:
        return {"maquina": machine, "nota": None, "snapshot_em": None,
                "status": "Sem leitura da bomba em operação.", "descontos": [],
                "formula": "100 menos 25 pontos por regra ativa, limitada ao intervalo de 0 a 100.",
                "lacunas_de_comunicacao": missing_intervals}

    snapshot_at, _ = latest_active
    deductions = {
        "cavitacao": ("Vibração axial, vazão e pressão",
                      "Vibração de pelo menos 4,5 mm/s junto de oscilações de 25 m³/h na vazão e 2,5 mca na pressão, em sequência persistente."),
        "eletrico": ("Tensão, corrente e temperatura da fase S",
                     "Pelo menos dois desvios simultâneos e persistentes: tensão da fase S 7 V abaixo da relação normal com R/T, corrente relativa 4% maior ou temperatura da fase S 3,5 °C acima da relação normal."),
        "mancal": ("Temperatura radial, temperatura axial e vibração axial",
                   "Temperatura radial pelo menos 7 °C acima da referência horária, diferença radial-axial 4 °C maior e vibração 0,7 mm/s maior, com persistência."),
        "rotor": ("Vazão, pressão de recalque e rendimento",
                  "Média horária de vazão abaixo de 97% da referência, pressão abaixo de 99,5% e rendimento 2 pontos menor por 3 horas operacionais seguidas."),
    }
    active_alerts = []
    active_set = set(active_rules)
    for alert in reversed(detected_alerts):
        if alert["tipo"] in active_set and alert["tipo"] not in {item["tipo"] for item in active_alerts}:
            active_alerts.append(alert)

    rows_out = []
    for kind in active_rules:
        signals, reason = deductions[kind]
        alert = next((item for item in active_alerts if item["tipo"] == kind), None)
        rows_out.append({
            "regra": ALERT_NAMES[kind], "sinais": signals, "pontos_descontados": 25,
            "motivo": reason, "zona": RULE_CATALOG[kind]["zona"],
            "alerta_confirmado_em": alert["confirmado_em"] if alert else None,
        })
    score = max(0, 100 - 25 * len(rows_out))
    return {
        "maquina": machine, "nota": score,
        "snapshot_em": snapshot_at.isoformat(timespec="minutes"),
        "status": "Nota calculada com as regras ativas no fim do histórico salvo.",
        "descontos": rows_out,
        "formula": "100 menos 25 pontos por regra ativa, limitada ao intervalo de 0 a 100.",
        "lacunas_de_comunicacao": missing_intervals,
        "nota_metodologica": "Pesos iguais e limiar de persistência são parâmetros iniciais de protótipo, não uma escala clínica ou de segurança validada pela Higra. Dados ausentes não reduzem a saúde da bomba; aparecem como lacunas de qualidade do dado.",
    }



def health_history(machine, start=None, end=None):
    """Resume a nota atual, a evolução diária e os alertas de um período."""
    requested_start = datetime.strptime(start, "%Y-%m-%d").date() if start else None
    requested_end = datetime.strptime(end, "%Y-%m-%d").date() if end else None
    if requested_start and requested_end and requested_start > requested_end:
        raise ValueError("A data inicial deve ser anterior à final.")

    with database.connection() as db:
        rows = db.execute(
            "SELECT data,valores FROM leituras WHERE maquina=? AND data>=? ORDER BY data",
            (machine, BASELINE_START + "T00:00:00"),
        ).fetchall()
    prepared = [(datetime.fromisoformat(row["data"]), json.loads(row["valores"])) for row in rows]
    if not prepared:
        raise ValueError("Não há leituras salvas para esta bomba.")

    operating = [
        (timestamp, values) for timestamp, values in prepared
        if (values.get("Rotacao (rpm)") or 0) > 0
    ]
    if not operating:
        return {
            "maquina": machine, "nota_atual": None, "snapshot_em": None,
            "periodo": {"inicio": None, "fim": None}, "serie": [],
            "media_diaria": None, "minima_diaria": None, "dias_com_dados": 0,
            "alertas_periodo": [],
            "mensagem": "Não há leituras operacionais para calcular a evolução.",
        }

    current = health_score(machine)
    replay_start = datetime.strptime(REPLAY_START, "%Y-%m-%d").date()
    first_operating = operating[0][0].date()
    last_operating = operating[-1][0].date()
    earliest_day = max(replay_start, first_operating)
    period_start = max(requested_start or earliest_day, earliest_day)
    period_end = min(requested_end or last_operating, last_operating)

    series = []
    alerts_in_period = []
    if period_start <= period_end:
        operation_days = {timestamp.date() for timestamp, _ in operating}
        next_row = 0
        for day_offset in range((period_end - period_start).days + 1):
            day = period_start + timedelta(days=day_offset)
            while next_row < len(prepared) and prepared[next_row][0].date() <= day:
                next_row += 1
            if day not in operation_days or next_row == 0:
                continue
            alerts, _, active_rules = _calculate(
                prepared[:next_row], replay_end=day.isoformat()
            )
            score = max(0, 100 - 25 * len(active_rules))
            series.append({"data": day.isoformat(), "nota": score})

        next_row = 0
        while next_row < len(prepared) and prepared[next_row][0].date() <= period_end:
            next_row += 1
        if next_row:
            alerts, _, _ = _calculate(
                prepared[:next_row], replay_end=period_end.isoformat()
            )
            alerts_in_period = [
                alert for alert in alerts
                if period_start <= datetime.fromisoformat(alert["confirmado_em"]).date() <= period_end
            ]

    scores = [item["nota"] for item in series]
    minimum = min(series, key=lambda item: item["nota"]) if series else None
    return {
        "maquina": machine,
        "nota_atual": current["nota"],
        "snapshot_em": current["snapshot_em"],
        "periodo": {
            "inicio": period_start.isoformat() if period_start <= period_end else None,
            "fim": period_end.isoformat() if period_start <= period_end else None,
        },
        "serie": series,
        "media_diaria": round(sum(scores) / len(scores), 1) if scores else None,
        "minima_diaria": minimum,
        "dias_com_dados": len(series),
        "alertas_periodo": alerts_in_period,
        "mensagem": (
            "A média e a mínima consideram apenas dias com leituras da bomba em operação. "
            "Dias sem dados não recebem uma nota."
        ),
    }
