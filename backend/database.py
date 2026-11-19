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

