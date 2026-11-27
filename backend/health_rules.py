"""Regras de saúde descritas no documento Regras, sem alterar as leituras originais."""
from collections import deque
from datetime import datetime, timedelta
from functools import lru_cache
import math
import unicodedata


BASELINE_START = "2026-06-01"
BASELINE_END = "2026-06-08"
REPLAY_START = "2026-06-09"
RESET_AFTER = timedelta(hours=6)


RULES = {
    "cavitacao": {"nome": "Cavitação ou instabilidade hidráulica", "sinais": "Vibração axial", "peso": 8, "pontos": 35, "zona": "impulsor", "status": "confirmado", "duracao": "2 avaliações consecutivas", "janela": "Média de vibração de 5 min comparada com a média 10 min antes; vazão ajuda a contextualizar.", "explicacao": "Vibração axial acima de 2 vezes a média do período de referência e aumento mínimo de 0,8 mm/s em relação à média observada 10 minutos antes."},
    "mancal": {"nome": "Desgaste do mancal ou desalinhamento", "sinais": "Temperaturas radial e axial, vibração axial", "peso": 10, "pontos": 20, "zona": "mancal", "status": "confirmado", "duracao": "6 avaliações horárias consecutivas", "janela": "Médias móveis das últimas 8 horas; 10 pontos por temperatura, sem contar os mesmos sinais duas vezes.", "explicacao": "Temperatura radial acima da referência em 3 °C, diferença radial-axial acima de 3 °C e vibração acima de 2 vezes a referência."},
    "estator_r": {"nome": "Aquecimento anormal do estator · fase R", "sinais": "Temperatura do estator R", "peso": 8, "pontos": 8, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Fase R acima de 39,91 °C ou diferença superior a 5 °C em relação às demais fases."},
    "estator_s": {"nome": "Aquecimento anormal do estator · fase S", "sinais": "Temperatura do estator S", "peso": 8, "pontos": 8, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Fase S acima de 39,92 °C ou diferença superior a 5 °C em relação às demais fases."},
    "estator_t": {"nome": "Aquecimento anormal do estator · fase T", "sinais": "Temperatura do estator T", "peso": 8, "pontos": 8, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Fase T acima de 39,76 °C ou diferença superior a 5 °C em relação às demais fases."},
    "desbalanceamento_eletrico": {"nome": "Desbalanceamento elétrico entre fases", "sinais": "Tensões e correntes R, S e T", "peso": 9, "pontos": 25, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Médias móveis de 10 minutos.", "explicacao": "Diferença entre a maior e a menor tensão superior a 3% da tensão média, acompanhada de corrente de fase mais de 10% acima da referência."},
    "rotor_pre_alerta": {"nome": "Tendência de desgaste do rotor ou obstrução", "sinais": "Vazão média horária", "peso": 0, "pontos": 0, "zona": "rotor", "status": "pré-alerta", "duracao": "12 avaliações horárias consecutivas", "janela": "Média móvel de 8 horas; queda progressiva de vazão.", "explicacao": "Vazão média de 8 horas abaixo de 95% da referência escolhida e em queda. Pré-alerta sem desconto de pontos."},
    "rotor_confirmado": {"nome": "Desgaste do rotor ou obstrução confirmado", "sinais": "Vazão, corrente média ou potência ativa", "peso": 8, "pontos": 20, "zona": "rotor", "status": "confirmado", "duracao": "6 de 12 avaliações horárias", "janela": "Mantém a condição de vazão do pré-alerta e verifica médias móveis de 8 horas.", "explicacao": "Vazão abaixo de 95% da referência e em queda, com corrente média ou potência ativa acima de 104% da respectiva referência. Não soma com o pré-alerta."},
    "corrente_media": {"nome": "Corrente média anormal", "sinais": "Corrente média", "peso": 7, "pontos": 7, "zona": "motor", "status": "confirmado", "duracao": "15 minutos; prioridade elevada após 8 horas", "janela": "Média móvel de 10 minutos.", "explicacao": "Corrente média acima de 106% da referência escolhida."},
    "corrente_r": {"nome": "Corrente anormal · fase R", "sinais": "Corrente da fase R", "peso": 6, "pontos": 6, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Corrente R mais de 10% acima da referência escolhida."},
    "corrente_s": {"nome": "Corrente anormal · fase S", "sinais": "Corrente da fase S", "peso": 6, "pontos": 6, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Corrente S mais de 10% acima da referência escolhida."},
    "corrente_t": {"nome": "Corrente anormal · fase T", "sinais": "Corrente da fase T", "peso": 6, "pontos": 6, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Corrente T mais de 10% acima da referência escolhida."},
    "tensao_r": {"nome": "Tensão anormal · fase R", "sinais": "Tensão da fase R", "peso": 5, "pontos": 5, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Desvio absoluto superior a 3% em relação à referência escolhida da fase R."},
    "tensao_s": {"nome": "Tensão anormal · fase S", "sinais": "Tensão da fase S", "peso": 5, "pontos": 5, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Desvio absoluto superior a 3% em relação à referência escolhida da fase S."},
    "tensao_t": {"nome": "Tensão anormal · fase T", "sinais": "Tensão da fase T", "peso": 5, "pontos": 5, "zona": "motor", "status": "confirmado", "duracao": "15 minutos", "janela": "Média móvel de 10 minutos.", "explicacao": "Desvio absoluto superior a 3% em relação à referência escolhida da fase T."},
    "potencia_ativa": {"nome": "Potência ativa anormal", "sinais": "Potência ativa", "peso": 6, "pontos": 6, "zona": "motor", "status": "confirmado", "duracao": "30 minutos", "janela": "Médias móveis de 10 minutos e 1 hora; limiar de 2 desvios-padrão da referência.", "explicacao": "Desvio superior a 2 desvios-padrão em relação à referência de 227,35 kW."},
    "potencia_reativa": {"nome": "Potência reativa anormal", "sinais": "Potência reativa", "peso": 4, "pontos": 4, "zona": "motor", "status": "confirmado", "duracao": "30 minutos", "janela": "Médias móveis de 10 minutos e 1 hora; limiar de 2 desvios-padrão da referência.", "explicacao": "Desvio superior a 2 desvios-padrão em relação à referência de 95,90 kVAr."},
    "potencia_aparente": {"nome": "Potência aparente anormal", "sinais": "Potência aparente", "peso": 4, "pontos": 4, "zona": "motor", "status": "confirmado", "duracao": "30 minutos", "janela": "Médias móveis de 10 minutos e 1 hora; limiar de 2 desvios-padrão da referência.", "explicacao": "Desvio superior a 2 desvios-padrão em relação à referência de 247,38 kVA."},
    "fator_potencia": {"nome": "Fator de potência anormal", "sinais": "Fator de potência", "peso": 5, "pontos": 5, "zona": "motor", "status": "confirmado", "duracao": "30 minutos", "janela": "Médias móveis de 10 minutos e 1 hora; limiar de 2 desvios-padrão da referência.", "explicacao": "Desvio superior a 2 desvios-padrão em relação à referência de 0,9202."},
    "rotacao": {"nome": "Rotação fora do padrão", "sinais": "Rotação", "peso": 7, "pontos": 7, "zona": "motor", "status": "confirmado", "duracao": "10 minutos", "janela": "Média móvel de 5 minutos; desvio superior a 2 desvios-padrão da referência.", "explicacao": "Rotação fora de 2 desvios-padrão da referência de 1.557,95 rpm."},
    "frequencia": {"nome": "Frequência fora do padrão", "sinais": "Frequência", "peso": 5, "pontos": 5, "zona": "motor", "status": "confirmado", "duracao": "10 minutos", "janela": "Média móvel de 5 minutos; desvio superior a 2 desvios-padrão ou incompatibilidade com a rotação.", "explicacao": "Frequência fora de 2 desvios-padrão da referência de 60,02 Hz ou incompatível com a rotação observada."},
    "sensor_travado": {"nome": "Sensor possivelmente travado", "sinais": "Sensor repetindo o mesmo valor", "peso": 0, "pontos": 0, "zona": "sensor", "status": "informativo", "duracao": "30 leituras consecutivas", "janela": "Exige que outros sinais relacionados continuem variando.", "explicacao": "Sinaliza necessidade de verificar o sensor; não reduz a saúde da bomba."},
    "pico_isolado": {"nome": "Pico isolado ou ruído", "sinais": "Qualquer sensor", "peso": 0, "pontos": 0, "zona": "sensor", "status": "informativo", "duracao": "Classificado após 4 leituras seguintes", "janela": "Compara o pico com as 4 leituras seguintes e a média móvel de 5 minutos.", "explicacao": "Um pico isolado classificado como ruído não reduz a saúde da bomba."},
    "falha_comunicacao": {"nome": "Falha de comunicação", "sinais": "Chegada das leituras", "peso": 0, "pontos": 0, "zona": "comunicacao", "status": "informativo", "duracao": "Mais de 5 minutos sem registro", "janela": "Suspende regras que dependem dos dados ausentes; lacunas nunca são preenchidas com zero.", "explicacao": "Aviso de qualidade dos dados; não reduz a saúde da bomba."},
    "bomba_desligada": {"nome": "Bomba desligada", "sinais": "Rotação e vazão", "peso": 0, "pontos": 0, "zona": "bomba", "status": "informativo", "duracao": "10 minutos", "janela": "Rotação até 100 rpm com vazão zerada; regras de saúde ficam suspensas.", "explicacao": "Desligamento intencional não reduz a saúde da bomba."},
}


VISIBLE_RULE_IDS = {
    "cavitacao", "mancal", "rotor_confirmado",
    "corrente_r", "corrente_s", "corrente_t",
    "tensao_r", "tensao_s", "tensao_t",
}
TRACKED_RULE_IDS = VISIBLE_RULE_IDS | {"rotor_pre_alerta"}


ALIASES = {
    "flow": ("vazao",), "rpm": ("rotacao",), "vibration": ("vibracaoaxial", "vibracao"),
    "radial": ("temperaturaradial",), "axial": ("temperaturaaxial",),
    "voltage_r": ("tensaor",), "voltage_s": ("tensaos",), "voltage_t": ("tensaot",),
    "current_avg": ("correntemedia",), "current_r": ("correnter",), "current_s": ("correntes",), "current_t": ("correntet",),
    "stator_r": ("temperaturaestatorfaser", "temperaturaestatorr"),
    "stator_s": ("temperaturaestatorfases", "temperaturaestators"),
    "stator_t": ("temperaturaestatorfaset", "temperaturaestatorfacet", "temperaturaestator t"),
    "power_active": ("potenciaativamedia", "potenciaativa"),
    "power_reactive": ("potenciareativamedia", "potenciareativa"),
    "power_apparent": ("potenciaaparentemedia", "potenciaaparente"),
    "power_factor": ("fatorpotencia",), "frequency": ("frequencia",),
}

REFERENCE_FIELDS = (
    "flow", "vibration", "radial", "axial", "stator_r", "stator_s", "stator_t",
    "current_avg", "current_r", "current_s", "current_t", "voltage_r", "voltage_s",
    "voltage_t", "power_active", "power_reactive", "power_apparent", "power_factor",
    "rpm", "frequency",
)


def _norm(text):
    value = unicodedata.normalize("NFD", str(text).lower())
    return "".join(char for char in value if char.isalnum())


_ALIASES = {key: tuple(_norm(alias) for alias in aliases) for key, aliases in ALIASES.items()}


@lru_cache(maxsize=32)
def _field_map(headers):
    normalized = [(header, _norm(header)) for header in headers]
    mapping = {}
    for field, aliases in _ALIASES.items():
        for alias in aliases:
            match = next((header for header, key in normalized if key == alias or key.startswith(alias)), None)
            if match is not None:
                mapping[match] = field
                break
    return mapping


def _numeric(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def _sample(raw):
    mapping = _field_map(tuple(raw.keys()))
    result = {name: None for name in _ALIASES}
    numeric = {}
    for key, value in raw.items():
        if not _numeric(value):
            continue
        number = float(value)
        numeric[key] = number
        field = mapping.get(key)
        if field is not None:
            result[field] = number
    result["_numeric"] = numeric
    return result


def _mean(values):
    values = [value for value in values if value is not None]
    return sum(values) / len(values) if values else None


def _std(values):
    values = [value for value in values if value is not None]
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))


def _date_time(value):
    return value.isoformat(timespec="minutes")


def _new_alert(rule_id, started, confirmed, *, sensor=None, status=None):
    rule = RULES[rule_id]
    alert = {
        "id": f"{rule_id}:{_date_time(confirmed)}:{sensor or ''}",
        "tipo": rule_id, "falha": rule["nome"], "previsto": rule["explicacao"],
        "inicio_condicao": _date_time(started), "confirmado_em": _date_time(confirmed),
        "status": status or rule["status"], "peso": rule["peso"],
        "pontos_potenciais": rule["pontos"], "pontos_descontados": 0,
        "prioridade": "normal",
        "sinais": rule["sinais"], "zona": rule["zona"], "grupo": rule_id,
        "sensor": sensor, "resolvido_em": None,
        "detectado_em": _date_time(confirmed),
    }
    return alert


class _Tracker:
    def __init__(self, rule_id, alerts, *, checks=None, duration_minutes=None, interval_minutes=1):
        self.rule_id = rule_id
        self.alerts = alerts
        self.checks = checks
        self.duration = timedelta(minutes=duration_minutes) if duration_minutes else None
        self.interval = timedelta(minutes=interval_minutes)
        self.streak_start = None
        self.streak = 0
        self.last_eval = None
        self.clear_since = None
        self.alert = None

    @property
    def active(self):
        return self.alert is not None and self.alert["resolvido_em"] is None

    def reset_candidate(self):
        self.streak_start = None
        self.streak = 0

    def pause(self, timestamp, reason="Observação interrompida"):
        self.close_candidate(timestamp, reason)
        self.reset_candidate()
        # Parada ou dados ausentes não comprovam recuperação.
        self.clear_since = None
        self.last_eval = None

    def update(self, condition, timestamp):
        if condition is None:
            self.pause(timestamp)
            return
        if self.last_eval and timestamp - self.last_eval > self.interval * 1.6:
            self.reset_candidate()
            self.clear_since = None
        if condition:
            if self.streak_start is None:
                self.streak_start = timestamp
                self.streak = 1
            else:
                self.streak += 1
            self.clear_since = None
            if not self.active:
                self.alert = _new_alert(self.rule_id, self.streak_start, timestamp, status="pré-alerta")
                self.alert["confirmado_em"] = None
                self.alert["detectado_em"] = _date_time(self.streak_start)
                self.alerts.append(self.alert)
            confirmed = (self.checks is not None and self.streak >= self.checks) or (
                self.duration is not None and timestamp - self.streak_start >= self.duration
            )
            if confirmed and self.alert.get("confirmado_em") is None:
                self.alert["confirmado_em"] = _date_time(timestamp)
                self.alert["status"] = RULES[self.rule_id]["status"]
                self.alert["pontos_na_confirmacao"] = RULES[self.rule_id]["pontos"]
                self.alert["pontos_descontados"] = RULES[self.rule_id]["pontos"]
            self.alert["ultimo_sinal_em"] = _date_time(timestamp)
            if self.rule_id == "corrente_media" and self.alert.get("confirmado_em"):
                confirmed_at = datetime.fromisoformat(self.alert["confirmado_em"])
                if timestamp - confirmed_at >= timedelta(hours=8):
                    self.alert["prioridade"] = "alta"
        else:
            self.reset_candidate()
            if self.active:
                if self.alert.get("confirmado_em") is None:
                    self.force_close(timestamp, "Pré-alerta encerrado sem confirmação")
                else:
                    self.clear_since = self.clear_since or timestamp
                if self.active and self.clear_since and timestamp - self.clear_since >= RESET_AFTER:
                    self.alert["resolvido_em"] = _date_time(timestamp)
                    self.alert["status"] = "Normalizado"
                    self.clear_since = None
        self.last_eval = timestamp

    def force_close(self, timestamp, status="Encerrado"):
        if self.active:
            self.alert["resolvido_em"] = _date_time(timestamp)
            self.alert["status"] = status
        self.reset_candidate()
        self.clear_since = None

    def close_candidate(self, timestamp, status):
        if self.active and self.alert.get("confirmado_em") is None:
            self.force_close(timestamp, status)


def _effective_points(active_alerts):
    confirmed = [item for item in active_alerts
                 if item.get("resolvido_em") is None and item.get("status") == "confirmado"]
    ids = {item["tipo"] for item in confirmed}
    suppressed = set()
    if "desbalanceamento_eletrico" in ids:
        suppressed.update({"corrente_media", "corrente_r", "corrente_s", "corrente_t",
                          "tensao_r", "tensao_s", "tensao_t", "estator_r", "estator_s", "estator_t"})
    if "rotor_confirmado" in ids:
        suppressed.update({"rotor_pre_alerta", "corrente_media", "potencia_ativa"})
    if ids.intersection({"corrente_r", "corrente_s", "corrente_t"}):
        suppressed.add("corrente_media")
    points = {}
    for item in confirmed:
        points[item["id"]] = 0 if item["tipo"] in suppressed else int(item.get("pontos_potenciais", 0))
    return points


def _score(active_alerts):
    points = _effective_points(active_alerts)
    return max(0, 100 - sum(points.values())), points


def _consecutive_window(samples, count):
    if len(samples) < count:
        return None
    return list(samples)[-count:]


def _mean_field(samples, field):
    total = 0.0
    count = 0
    for _, sample in samples:
        value = sample.get(field)
        if value is not None:
            total += value
            count += 1
    return total / count if count else None


def _simple_alert(alerts, rule_id, started, confirmed, *, sensor=None, status=None, description=None):
    alert = _new_alert(rule_id, started, confirmed, sensor=sensor, status=status)
    if description:
        alert["previsto"] = description
    alerts.append(alert)
    return alert


def _build_references(prepared, baseline_start, baseline_end):
    baseline = []
    start, end = datetime.fromisoformat(baseline_start).date(), datetime.fromisoformat(baseline_end).date()
    for timestamp, sample in prepared:
        if start <= timestamp.date() <= end and (sample.get("rpm") or 0) > 100:
            baseline.append(sample)
    refs = {}
    for field in REFERENCE_FIELDS:
        vals = [item.get(field) for item in baseline]
        refs[field] = {"mean": _mean(vals), "std": _std(vals)}
    # Relação rpm/frequência de referência para detectar incompatibilidade sem supor número de polos.
    ratios = [item["rpm"] / item["frequency"] for item in baseline
              if item.get("rpm") is not None and item.get("frequency") not in (None, 0)]
    refs["rpm_frequency_ratio"] = {"mean": _mean(ratios), "std": _std(ratios)}
    refs["baseline_count"] = len(baseline)
    return refs


def _active_alerts(trackers, extra_active):
    result = [tracker.alert for tracker in trackers.values() if tracker.active]
    result.extend(item for item in extra_active.values() if item.get("resolvido_em") is None)
    return result


def analyze(prepared, *, baseline_start=BASELINE_START, baseline_end=BASELINE_END, replay_end=None):
    """Reproduz as regras em ordem; cada avaliação usa somente o passado disponível."""
    # Os chamadores entregam as leituras no formato original do banco; normalize
    # antes de calcular a referência, que usa os nomes internos dos sinais.
    prepared = [(timestamp, _sample(values)) for timestamp, values in prepared]
    references = _build_references(prepared, baseline_start, baseline_end)
    if references["baseline_count"] < 30:
        raise ValueError("O período de referência precisa conter ao menos 30 leituras operacionais com Rotação acima de 100 rpm.")
    alerts = []
    trackers = {}
    for rule_id in RULES:
        if rule_id not in TRACKED_RULE_IDS:
            continue
        if rule_id == "cavitacao":
            trackers[rule_id] = _Tracker(rule_id, alerts, checks=2)
        elif rule_id == "mancal":
            trackers[rule_id] = _Tracker(rule_id, alerts, checks=6, interval_minutes=60)
        elif rule_id == "rotor_pre_alerta":
            trackers[rule_id] = _Tracker(rule_id, alerts, checks=12, interval_minutes=60)
        elif rule_id == "rotor_confirmado":
            trackers[rule_id] = _Tracker(rule_id, alerts, checks=1, interval_minutes=60)
        elif rule_id == "corrente_media":
            trackers[rule_id] = _Tracker(rule_id, alerts, duration_minutes=15)
        elif rule_id in {"potencia_ativa", "potencia_reativa", "potencia_aparente", "fator_potencia"}:
            trackers[rule_id] = _Tracker(rule_id, alerts, duration_minutes=30)
        elif rule_id in {"rotacao", "frequencia"}:
            trackers[rule_id] = _Tracker(rule_id, alerts, duration_minutes=10)
        else:
            trackers[rule_id] = _Tracker(rule_id, alerts, duration_minutes=15)
    start_replay = datetime.fromisoformat(baseline_end).date() + timedelta(days=1)
    end_replay = datetime.fromisoformat(replay_end).date() if replay_end else None
    minute_window = deque(maxlen=20)
    hour_window = deque(maxlen=60)
    hourly = deque(maxlen=16)
    hour_key = None
    hour_samples = []
    last_hour = None
    last_timestamp = None
    current_day = None
    daily = []
    day_has_operating = False
    missing_intervals = 0
    rotor_confirmation_window = deque(maxlen=12)
    last_operating = None

    def finalize_day(day):
        if not day_has_operating:
            return
        active = [item for item in _active_alerts(trackers, {}) if item["tipo"] in VISIBLE_RULE_IDS]
        score, deductions = _score(active)
        for item in active:
            item["pontos_descontados"] = deductions.get(item["id"], 0)
        daily.append({"data": day.isoformat(), "nota": score,
                      "regras_ativas": [item["falha"] for item in active],
                      "avisos_ativos": [{"tipo": item["tipo"], "nome": item["falha"],
                                         "pontos_descontados": deductions.get(item["id"], 0),
                                         "status": item["status"]} for item in active]})

    def clear_candidates(timestamp=None):
        for key, tracker in trackers.items():
            if isinstance(tracker, _Tracker):
                if timestamp is not None:
                    tracker.pause(timestamp, "Observação interrompida por lacuna")
        minute_window.clear()
        hour_window.clear()
        hourly.clear()
        rotor_confirmation_window.clear()

    def finish_hour(key, samples):
        nonlocal last_hour
        if last_hour is not None and key - last_hour != timedelta(hours=1):
            hourly.clear()
            rotor_confirmation_window.clear()
        summary = None
        if len(samples) >= 30:
            summary = {field: _mean([sample.get(field) for _, sample in samples])
                       for field in ("flow", "radial", "axial", "vibration", "current_avg", "power_active")}
            summary["count"] = len(samples)
        hourly.append((key, summary))
        last_hour = key
        # Nunca confirme no horário seguinte (que pode já ser uma parada).
        hour_stamp = samples[-1][0] if samples else key
        recent_8 = list(hourly)[-8:]
        bearing_ready = len(recent_8) == 8 and all(item[1] is not None for item in recent_8)
        if bearing_ready:
            mean8 = lambda selection, field: _mean([entry[1][field] for entry in selection])
            radial8, axial8, vibration8 = (mean8(recent_8, name) for name in ("radial", "axial", "vibration"))
            radial_reference = references["radial"]["mean"]
            vibration_reference = references["vibration"]["mean"]
            bearing_condition = (None if radial8 is None or axial8 is None or vibration8 is None or
                                 radial_reference is None or vibration_reference is None else
                                 radial8 > radial_reference + 3 and abs(radial8 - axial8) > 3 and
                                 vibration8 > vibration_reference * 2)
            trackers["mancal"].update(bearing_condition, hour_stamp)
        else:
            trackers["mancal"].update(None, hour_stamp)
        if len(hourly) < 16 or any(item[1] is None for item in list(hourly)[-16:]):
            trackers["rotor_pre_alerta"].update(None, hour_stamp)
            trackers["rotor_confirmado"].update(None, hour_stamp)
            return
        blocks = list(hourly)[-16:]
        current_8 = blocks[-8:]
        earlier_8 = blocks[-16:-8]
        mean8 = lambda selection, field: _mean([entry[1][field] for entry in selection])
        flow8 = mean8(current_8, "flow")
        flow_previous = mean8(earlier_8, "flow")
        flow_reference = references["flow"]["mean"]
        rotor_trend = (None if flow8 is None or flow_previous is None or flow_reference in (None, 0)
                       else flow8 < flow_reference * 0.95 and flow8 < flow_previous)
        trackers["rotor_pre_alerta"].update(rotor_trend, hour_stamp)
        current8 = mean8(current_8, "current_avg")
        power8 = mean8(current_8, "power_active")
        current_reference = references["current_avg"]["mean"]
        power_reference = references["power_active"]["mean"]
        confirmation_signal = (None if (current8 is None and power8 is None) or
                               (current_reference is None and power_reference is None) else bool(
            (current8 is not None and current_reference is not None and current8 > current_reference * 1.04) or
            (power8 is not None and power_reference is not None and power8 > power_reference * 1.04)))
        if rotor_trend is not None and confirmation_signal is not None:
            rotor_confirmation_window.append(bool(rotor_trend and confirmation_signal))
        else:
            rotor_confirmation_window.clear()
        confirmed_rotor = (None if rotor_trend is None or confirmation_signal is None else
                           rotor_trend and len(rotor_confirmation_window) == 12 and sum(rotor_confirmation_window) >= 6)
        trackers["rotor_confirmado"].update(confirmed_rotor, hour_stamp)
        if trackers["rotor_confirmado"].active:
            trackers["rotor_pre_alerta"].force_close(hour_stamp, "Elevado a confirmação")

    for timestamp, sample in prepared:
        if timestamp.date() < start_replay or (end_replay and timestamp.date() > end_replay):
            continue
        if last_timestamp is not None:
            gap = timestamp - last_timestamp
            if gap > timedelta(minutes=1):
                missing_intervals += 1
                clear_candidates(timestamp)
        if current_day is not None and timestamp.date() != current_day:
            if hour_key is not None:
                finish_hour(hour_key, hour_samples)
            finalize_day(current_day)
            day_has_operating = False
            hour_key, hour_samples = None, []
        current_day = timestamp.date()
        hour = timestamp.replace(minute=0, second=0, microsecond=0)
        if hour_key is not None and hour != hour_key:
            finish_hour(hour_key, hour_samples)
            hour_samples = []
        hour_key = hour
        last_timestamp = timestamp

        rpm, flow = sample.get("rpm"), sample.get("flow")
        is_off = rpm is not None and rpm <= 100
        if is_off or rpm is None:
            clear_candidates(timestamp)
            hour_samples = []
            continue
        last_operating = timestamp
        day_has_operating = True
        sample["_numeric"] = sample.get("_numeric", {})
        minute_window.append((timestamp, sample))
        hour_window.append((timestamp, sample))
        hour_samples.append((timestamp, sample))

        # Regra 1: vibração alta e crescente, confirmada em duas avaliações consecutivas.
        latest5 = _consecutive_window(minute_window, 5)
        previous5 = list(minute_window)[-15:-10] if len(minute_window) >= 15 else None
        vibration5 = _mean_field(latest5, "vibration") if latest5 else None
        vibration_before = _mean_field(previous5, "vibration") if previous5 and len(previous5) == 5 else None
        trackers["cavitacao"].update(
            None if vibration5 is None or vibration_before is None else
            references["vibration"]["mean"] is not None and
            vibration5 > references["vibration"]["mean"] * 2 and
            vibration5 - vibration_before >= 0.8, timestamp)

        # Regras 8 e 9: corrente e tensão de cada fase, avaliadas separadamente.
        win10 = _consecutive_window(minute_window, 10)
        if win10:
            for phase in "rst":
                current = _mean_field(win10, "current_" + phase)
                current_ref = references["current_" + phase]["mean"]
                trackers["corrente_" + phase].update(
                    None if current is None or current_ref is None else current > current_ref * 1.10, timestamp)
                voltage = _mean_field(win10, "voltage_" + phase)
                voltage_ref = references["voltage_" + phase]["mean"]
                trackers["tensao_" + phase].update(
                    None if voltage is None or voltage_ref is None else
                    abs(voltage - voltage_ref) > voltage_ref * 0.03, timestamp)

    if hour_key is not None:
        finish_hour(hour_key, hour_samples)
    if current_day is not None:
        finalize_day(current_day)

    for day in daily:
        day["pontos_descontados"] = 100 - day["nota"]
    active = _active_alerts(trackers, {})
    note, effective = _score(active)
    for item in active:
        item["pontos_descontados"] = effective.get(item["id"], 0)
    # Registro cronológico de cada desconto e recuperação, inclusive dentro do dia.
    changes = {}
    for alert in alerts:
        if alert['tipo'] not in VISIBLE_RULE_IDS or not alert.get('confirmado_em'):
            continue
        changes.setdefault(alert['confirmado_em'], []).append((True, alert))
        if alert.get('resolvido_em'):
            changes.setdefault(alert['resolvido_em'], []).append((False, alert))
    timeline = []
    opened = {}
    for stamp, events in sorted(changes.items()):
        for opening, alert in events:
            if opening:
                opened[alert['id']] = dict(alert, status='confirmado', resolvido_em=None)
            else:
                opened.pop(alert['id'], None)
        value, discounts = _score(list(opened.values()))
        timeline.append({'momento': stamp, 'nota': value,
                         'avisos_ativos': [{'nome': a['falha'], 'status': 'confirmado',
                                            'pontos_descontados': discounts.get(a['id'], 0)} for a in opened.values()]})
    return {
        "evolucao": timeline,
        "nota": note, "alertas": alerts, "ativos": active,
        "dias": daily, "lacunas_de_comunicacao": missing_intervals,
        "snapshot_em": _date_time(last_operating) if last_operating else None,
        "ultima_leitura": _date_time(last_timestamp) if last_timestamp else None,
        "operacao": ("sem_dados" if last_timestamp is None or sample.get("rpm") is None else
                     "parada" if sample["rpm"] <= 100 else "operando"),
        "referencia": references,
    }


def public_rules():
    groups = [
        {"tipo": "cavitacao", "numero": 1, **RULES["cavitacao"]},
        {"tipo": "mancal", "numero": 2, **RULES["mancal"]},
        {"tipo": "rotor_confirmado", "numero": 6, **RULES["rotor_confirmado"]},
        {
            "tipo": "correntes_fase", "numero": 8, "nome": "Corrente anormal por fase",
            "sinais": "Corrente R, S e T", "peso": 6,
            "pontos": "6 por fase detectada (até 18)", "zona": "motor",
            "status": "confirmado", "duracao": "15 minutos",
            "janela": "Médias móveis de 10 minutos; cada fase é avaliada separadamente.",
            "explicacao": "Corrente acima de 110% da média da respectiva fase no período de referência escolhido.",
        },
        {
            "tipo": "tensoes_fase", "numero": 9, "nome": "Tensão anormal por fase",
            "sinais": "Tensão R, S e T", "peso": 5,
            "pontos": "5 por fase detectada (até 15)", "zona": "motor",
            "status": "confirmado", "duracao": "15 minutos",
            "janela": "Médias móveis de 10 minutos; cada fase é avaliada separadamente.",
            "explicacao": "Desvio absoluto acima de 3% da média de tensão de cada fase no período escolhido.",
        },
    ]
    return [{**rule, "condicao": rule["explicacao"], "verificacoes": rule["duracao"]} for rule in groups]


