"""Camada de leitura para nota de saúde, avisos e histórico diário."""
from datetime import date, datetime, timedelta
import json
from threading import RLock

import database
import health_rules


_CACHE = {}
_CACHE_LOCK = RLock()


def _load(machine):
    period = database.reference_period(machine)
    with _CACHE_LOCK:
        with database.connection() as db:
            version = db.execute(
                "SELECT COUNT(*) AS total,MAX(data) AS ultima FROM leituras WHERE maquina=? AND data>=?",
                (machine, period["inicio"] + "T00:00:00"),
            ).fetchone()
            version = (version["total"], version["ultima"], period["inicio"], period["fim"])
            cached = _CACHE.get(machine)
            if cached and cached["version"] == version:
                return cached
            rows = db.execute(
                "SELECT data,valores FROM leituras WHERE maquina=? AND data>=? ORDER BY data",
                (machine, period["inicio"] + "T00:00:00"),
            ).fetchall()
        context = {
            "version": version,
            "period": period,
            "prepared": [(datetime.fromisoformat(row["data"]), json.loads(row["valores"])) for row in rows],
            "analysis": None,
        }
        _CACHE[machine] = context
        while len(_CACHE) > 2:
            _CACHE.pop(next(iter(_CACHE)))
        return context


def _analysis(machine, context):
    with _CACHE_LOCK:
        if context["analysis"] is None:
            context["analysis"] = health_rules.analyze(
                context["prepared"], baseline_start=context["period"]["inicio"],
                baseline_end=context["period"]["fim"],
            )
        return context["analysis"]


def _public_alert(alert, as_of=None):
    alert = dict(alert)
    if as_of and alert.get("resolvido_em") and alert["resolvido_em"] > as_of:
        alert.update(resolvido_em=None, status="confirmado")
    if as_of and alert.get("ultimo_sinal_em", "") > as_of:
        alert["ultimo_sinal_em"] = None
    alert["pontos_na_confirmacao"] = alert.get("pontos_na_confirmacao", alert["pontos_potenciais"])
    alert["pontos_ativos"] = alert["pontos_na_confirmacao"] if not alert["resolvido_em"] and alert["confirmado_em"] else 0
    return {
        **alert,
        "regra": alert["falha"],
        "motivo": alert["previsto"],
        "alerta_confirmado_em": alert["confirmado_em"],
    }


def health_score(machine):
    context = _load(machine)
    prepared = context["prepared"]
    if not prepared:
        raise ValueError("Não há leituras salvas para esta bomba.")
    analysis = _analysis(machine, context)
    alerts = [_public_alert(alert) for alert in analysis["ativos"]
              if alert["tipo"] in health_rules.VISIBLE_RULE_IDS and alert.get("confirmado_em")]
    observations = [_public_alert(alert) for alert in analysis["ativos"]
                    if alert["tipo"] in health_rules.VISIBLE_RULE_IDS and not alert.get("confirmado_em")]
    deductions = [alert for alert in alerts if alert["pontos_descontados"] > 0]
    score = analysis["nota"] if analysis["snapshot_em"] else None
    return {
        "maquina": machine,
        "nota": score,
        "snapshot_em": analysis["snapshot_em"],
        "status": ("Nota calculada após a referência escolhida, usando apenas sinais registrados até cada momento."
                   if score is not None else
                   "Ainda não há leituras posteriores à referência escolhida para calcular a saúde."),
        "descontos": deductions,
        "avisos": alerts,
        "observacoes": observations,
        "operacao": analysis["operacao"],
        "ultima_leitura": analysis["ultima_leitura"],
        "pontos_descontados": 100 - score if score is not None else None,
        "formula": "Cada condição ativa desconta uma vez. Repetições não acumulam pontos.",
        "lacunas_de_comunicacao": analysis["lacunas_de_comunicacao"],
        "nota_metodologica": (
            "O desconto permanece até 6 horas de leituras normais em operação. Paradas não encerram avisos."
        ),
        "referencia": analysis["referencia"],
        "periodo_referencia": context["period"],
    }


def health_history(machine, start=None, end=None):
    context = _load(machine)
    prepared = context["prepared"]
    if not prepared:
        raise ValueError("Não há leituras salvas para esta bomba.")
    period = context["period"]
    available_start = date.fromisoformat(period["fim"]) + timedelta(days=1)
    available_end = prepared[-1][0].date()
    if available_start > available_end:
        raise ValueError("Não há leituras posteriores ao período de referência escolhido.")
    try:
        start_date = date.fromisoformat(start) if start else available_start
        end_date = date.fromisoformat(end) if end else available_end
    except ValueError as exc:
        raise ValueError("Informe as datas no formato válido.") from exc
    if start_date > end_date:
        raise ValueError("A data inicial deve ser anterior ou igual à data final.")
    if start_date < available_start:
        raise ValueError("A análise começa no dia seguinte ao fim do período de referência.")
    end_date = min(end_date, available_end)
    if start_date > end_date:
        raise ValueError("Não há leituras disponíveis dentro do período escolhido.")

    analysis = _analysis(machine, context)
    days = [item for item in analysis["dias"] if start_date.isoformat() <= item["data"] <= end_date.isoformat()]
    scores = [item["nota"] for item in days]
    alerts = [
        _public_alert(alert, end_date.isoformat() + "T23:59:59")
        for alert in analysis["alertas"]
        if alert["tipo"] in health_rules.VISIBLE_RULE_IDS
        and alert.get("confirmado_em")
        and alert["confirmado_em"][:10] <= end_date.isoformat()
        and (not alert["resolvido_em"] or alert["resolvido_em"][:10] >= start_date.isoformat())
    ]
    return {
        "maquina": machine,
        "inicio": start_date.isoformat(),
        "evolucao": _period_timeline(analysis, start_date, end_date),
        "fim": end_date.isoformat(),
        "inicio_disponivel": available_start.isoformat(),
        "fim_disponivel": available_end.isoformat(),
        "nota_atual": days[-1]["nota"] if days else None,
        "data_nota_atual": days[-1]["data"] if days else None,
        "media_diaria": round(sum(scores) / len(scores), 1) if scores else None,
        "minima_diaria": min(scores) if scores else None,
        "dias_com_dados": len(days),
        "dias": days,
        "alertas": alerts,
        "lacunas_de_comunicacao": analysis["lacunas_de_comunicacao"],
        "nota_metodologica": "Cada dia é reproduzido em ordem cronológica: sua nota usa somente leituras até aquele dia. Dias sem dados não recebem nota.",
        "periodo_referencia": period,
    }


def public_rules():
    return health_rules.public_rules()


def _period_timeline(analysis, start, end):
    begin, finish = start.isoformat() + 'T00:00', end.isoformat() + 'T23:59'
    previous = {'nota': 100, 'avisos_ativos': []}
    points = []
    for point in analysis['evolucao']:
        if point['momento'] < begin:
            previous = point
        elif point['momento'] <= finish:
            points.append(point)
    result = [dict(previous, momento=begin), *points]
    observed_end = min(finish, analysis.get('ultima_leitura') or finish)
    result.append(dict(result[-1], momento=observed_end))
    return result
