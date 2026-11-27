"""Persistência local das importações e leituras."""
from contextlib import contextmanager
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import json
import math
import os
import sqlite3

DB_PATH = Path(os.environ.get("PUMP_DB_PATH", Path(__file__).with_name("pump_guardian.db")))


@contextmanager
def connection():
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        with db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS bombas (
                    nome TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS importacoes (
                    id INTEGER PRIMARY KEY,
                    hash TEXT NOT NULL UNIQUE,
                    nome TEXT NOT NULL,
                    criado_em TEXT NOT NULL,
                    total INTEGER NOT NULL DEFAULT 0,
                    novas INTEGER NOT NULL DEFAULT 0,
                    repetidas INTEGER NOT NULL DEFAULT 0,
                    ausentes INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS leituras (
                    maquina TEXT NOT NULL REFERENCES bombas(nome),
                    data TEXT NOT NULL,
                    valores TEXT NOT NULL,
                    importacao_id INTEGER NOT NULL REFERENCES importacoes(id),
                    PRIMARY KEY (maquina, data)
                );
                CREATE TABLE IF NOT EXISTS periodos_referencia (
                    maquina TEXT PRIMARY KEY REFERENCES bombas(nome),
                    inicio TEXT NOT NULL,
                    fim TEXT NOT NULL,
                    atualizado_em TEXT NOT NULL
                );
            """)
        yield db
    finally:
        db.close()


def timestamp(value):
    if isinstance(value, datetime):
        date = value
    else:
        text = str(value).strip()
        date = None
        for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S",
                    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                date = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
        if date is None:
            raise ValueError("Data inválida. Use dia/mês/ano hora:minuto.")
    if date.tzinfo is not None:
        raise ValueError("Use horários locais sem fuso explícito.")
    return date.isoformat(timespec="seconds")


def normalize(header, value):
    if value is None or str(value).strip() == "":
        return None
    if header in ("Comunicacao", "Alarme"):
        return str(value).strip()
    try:
        number = float(str(value).strip().replace(",", "."))
    except ValueError:
        raise ValueError(f"Valor numérico inválido na coluna {header}.")
    if not math.isfinite(number):
        raise ValueError(f"Valor não finito na coluna {header}.")
    return number


def save_import(raw, filename, rows):
    fingerprint = sha256(raw).hexdigest()
    with connection() as db:
        with db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM importacoes WHERE hash=?", (fingerprint,)).fetchone()
            if existing:
                return dict(import_id=existing["id"], novas=0, repetidas=existing["total"],
                            ausentes=existing["ausentes"], arquivo_repetido=True)
            headers = [str(v or "").strip() for v in next(rows)]
            index = {name: i for i, name in enumerate(headers)}
            imported = db.execute(
                "INSERT INTO importacoes(hash,nome,criado_em) VALUES(?,?,?)",
                (fingerprint, filename, datetime.now().isoformat(timespec="seconds"))).lastrowid
            total = new = repeated = missing = 0
            for line, row in enumerate(rows, 2):
                if all(v is None or v == "" for v in row):
                    continue
                try:
                    machine = str(row[index["Máquina"]]).strip()
                    date = timestamp(row[index["Data"]])
                    values = {h: normalize(h, row[i]) for i, h in enumerate(headers)
                              if h not in ("Data", "Máquina")}
                except (ValueError, IndexError) as exc:
                    raise ValueError(f"Registro {line}: {exc}") from exc
                payload = json.dumps(values, sort_keys=True, ensure_ascii=False)
                previous = db.execute(
                    "SELECT valores FROM leituras WHERE maquina=? AND data=?", (machine, date)).fetchone()
                if previous and previous["valores"] != payload:
                    raise ValueError(f"Registro {line}: valores conflitantes para {machine} em {date}. "
                                     "A importação foi cancelada. Confira o arquivo.")
                missing += sum(value is None for value in values.values())
                total += 1
                if previous:
                    repeated += 1
                    continue
                db.execute("INSERT OR IGNORE INTO bombas(nome) VALUES(?)", (machine,))
                db.execute("INSERT INTO leituras VALUES(?,?,?,?)", (machine, date, payload, imported))
                new += 1
            db.execute("UPDATE importacoes SET total=?,novas=?,repetidas=?,ausentes=? WHERE id=?",
                       (total, new, repeated, missing, imported))
            return dict(import_id=imported, novas=new, repetidas=repeated, ausentes=missing,
                        arquivo_repetido=False)


def history():
    with connection() as db:
        return {
            "importacoes": [dict(r) for r in db.execute("SELECT * FROM importacoes ORDER BY id DESC LIMIT 100")],
            "bombas": [r["nome"] for r in db.execute("SELECT nome FROM bombas ORDER BY nome")]
        }


def readings(params):
    page = int(params.get("pagina", ["1"])[0])
    if page < 1:
        raise ValueError("Página inválida.")
    clauses, args = [], []
    machine = params.get("maquina", [""])[0]
    if machine:
        clauses.append("maquina=?")
        args.append(machine)
    for key, operator, suffix in (("inicio", ">=", "T00:00:00"), ("fim", "<=", "T23:59:59")):
        value = params.get(key, [""])[0]
        if value:
            datetime.strptime(value, "%Y-%m-%d")
            clauses.append(f"data {operator} ?")
            args.append(value + suffix)
    if params.get("inicio", [""])[0] and params.get("fim", [""])[0]:
        if params["inicio"][0] > params["fim"][0]:
            raise ValueError("A data inicial deve ser anterior à final.")
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with connection() as db:
        total = db.execute("SELECT COUNT(*) FROM leituras" + where, args).fetchone()[0]
        rows = db.execute("SELECT * FROM leituras" + where +
                          " ORDER BY data,maquina LIMIT 50 OFFSET ?", [*args, (page - 1) * 50]).fetchall()
        gaps = db.execute("""
            SELECT COUNT(*) FROM (
                SELECT data, LAG(data) OVER (PARTITION BY maquina ORDER BY data) anterior
                FROM leituras
            """ + where + """) WHERE (julianday(data)-julianday(anterior))*86400 > 60.5
        """, args).fetchone()[0]
        return dict(total=total, pagina=page, lacunas=gaps,
                    leituras=[dict(Data=r["data"], Máquina=r["maquina"], **json.loads(r["valores"])) for r in rows])
def baseline(machine, start=None, end=None):
    if start is None or end is None:
        period = reference_period(machine)
        start = start or period["inicio"]
        end = end or period["fim"]
    datetime.strptime(start, "%Y-%m-%d")
    datetime.strptime(end, "%Y-%m-%d")
    if start > end:
        raise ValueError("A data inicial deve ser anterior à final.")
    with connection() as db:
        records = db.execute(
            "SELECT valores FROM leituras WHERE maquina=? AND data>=? AND data<=?",
            (machine, start + "T00:00:00", end + "T23:59:59")).fetchall()
    active = []
    for record in records:
        values = json.loads(record["valores"])
        import health_rules
        rotation = health_rules._sample(values).get("rpm")
        if isinstance(rotation, (int, float)) and rotation > 100:
            active.append(values)
    if not active:
        raise ValueError("Não há leituras com Rotação acima de 100 rpm neste período. Escolha datas em que a bomba estava operando.")
    weights = {
        "TemperaturaRadial (°C)": 10, "TemperaturaAxial (°C)": 10,
        "VibracaoAxial (mm/s)": 10, "Rendimento (%)": 8,
        "TemperaturaEstatorFaseR (°C)": 8, "TemperaturaEstatorFaseS (°C)": 8,
        "TemperaturaEstatorFaseT (°C)": 8, "Vazao (m³/h)": 7,
        "PressaoRecalque (mca)": 7, "CorrenteMedia (A)": 7,
        "CorrenteR (A)": 6, "CorrenteS (A)": 6, "CorrenteT (A)": 6,
        "PotenciaAtivaMedia (kW)": 6, "TensaoR (V)": 5, "TensaoS (V)": 5,
        "TensaoT (V)": 5, "TensaoMedia (V)": 5, "FatorPotenciaMedio": 5,
        "Frequencia (Hz)": 5, "PotenciaReativaMedia (kVAr)": 4,
        "PotenciaAparenteMedia (kVA)": 4,
    }
    signals = {}
    for name, weight in weights.items():
        observed = [row[name] for row in active if isinstance(row.get(name), (int, float))]
        if observed:
            average = sum(observed) / len(observed)
            variance = sum((value-average)**2 for value in observed) / len(observed)
            signals[name] = dict(peso=weight, leituras=len(observed), media=average,
                                 minimo=min(observed), maximo=max(observed),
                                 amplitude=max(observed)-min(observed), variancia=variance)
    return dict(maquina=machine, inicio=start, fim=end, criterio="Rotacao (rpm) > 100",
                leituras_consideradas=len(active), leituras_periodo=len(records), sinais=signals)


def reference_period(machine):
    """Devolve a janela configurada ou sugere os primeiros oito dias disponíveis."""
    with connection() as db:
        bounds = db.execute(
            "SELECT MIN(substr(data,1,10)) AS inicio, MAX(substr(data,1,10)) AS fim FROM leituras WHERE maquina=?",
            (machine,),
        ).fetchone()
        if not bounds["inicio"]:
            raise ValueError("Esta bomba ainda não tem leituras importadas.")
        saved = db.execute(
            "SELECT inicio,fim FROM periodos_referencia WHERE maquina=?", (machine,)
        ).fetchone()
    if saved:
        start, end, configured = saved["inicio"], saved["fim"], True
    else:
        from datetime import date, timedelta
        first, last = date.fromisoformat(bounds["inicio"]), date.fromisoformat(bounds["fim"])
        start = first.isoformat()
        end = min(first + timedelta(days=7), last).isoformat()
        configured = False
    return {
        "maquina": machine, "inicio": start, "fim": end,
        "disponivel_inicio": bounds["inicio"], "disponivel_fim": bounds["fim"],
        "configurado": configured,
    }


def set_reference_period(machine, start, end):
    datetime.strptime(start, "%Y-%m-%d")
    datetime.strptime(end, "%Y-%m-%d")
    if start > end:
        raise ValueError("A data inicial da referência deve ser anterior ou igual à data final.")
    period = reference_period(machine)
    if start < period["disponivel_inicio"] or end > period["disponivel_fim"]:
        raise ValueError("Escolha um período dentro das datas disponíveis neste CSV.")
    stats = baseline(machine, start, end)
    if stats["leituras_consideradas"] < 30:
        raise ValueError("O período precisa ter ao menos 30 leituras com a bomba em operação. Escolha datas com mais dados.")
    with connection() as db:
        db.execute(
            "INSERT INTO periodos_referencia(maquina,inicio,fim,atualizado_em) VALUES(?,?,?,?) "
            "ON CONFLICT(maquina) DO UPDATE SET inicio=excluded.inicio,fim=excluded.fim,atualizado_em=excluded.atualizado_em",
            (machine, start, end, datetime.now().isoformat(timespec="seconds")),
        )
    return {**period, "inicio": start, "fim": end, "configurado": True,
            "leituras_consideradas": stats["leituras_consideradas"],
            "leituras_periodo": stats["leituras_periodo"], "sinais": stats["sinais"]}

