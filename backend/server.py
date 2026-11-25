from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from io import BytesIO, StringIO
from zipfile import ZipFile, BadZipFile
import csv
import json
import sqlite3
from urllib.parse import urlsplit, parse_qs, unquote
import database
import event_evaluation

from openpyxl import load_workbook

FRONT = Path(__file__).resolve().parents[1] / "frontend"
LIMIT = 25 * 1024 * 1024


def records(data, extension):
    if extension == "xlsx":
        with ZipFile(BytesIO(data)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 220 * 1024**2:
                raise ValueError("Planilha expandida excede o limite.")
        book = load_workbook(BytesIO(data), read_only=True, data_only=True)
        try:
            if "Relatório Operacional" not in book.sheetnames:
                raise ValueError("A aba Relatório Operacional é obrigatória.")
            yield from book["Relatório Operacional"].values
        finally:
            book.close()
    else:
        try:
            source = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            source = data.decode("cp1252")
        if "\x00" in source:
            raise ValueError("Exporte o CSV como UTF-8.")
        first = source.splitlines()[0] if source.splitlines() else ""
        delimiter = max([";", ",", "\t"], key=first.count)
        yield from csv.reader(StringIO(source, newline=""), delimiter=delimiter, strict=True)


def preview(data, extension):
    rows = records(data, extension)
    try:
        headers = [str(v or "").strip() for v in next(rows, [])]
        if not {"Data", "Máquina"}.issubset(headers):
            raise ValueError("O arquivo precisa das colunas Data e Máquina.")
        if "" in headers or len(set(headers)) != len(headers):
            raise ValueError("Há cabeçalhos vazios ou repetidos.")
        sample = []
        machines = set()
        count = 0
        machine_idx = headers.index("Máquina")
        date_idx = headers.index("Data")
        for line, row in enumerate(rows, 2):
            if all(v is None or v == "" for v in row):
                continue
            if len(row) != len(headers):
                raise ValueError(f"Registro {line} tem quantidade incorreta de campos.")
            if any(row[i] is None or not str(row[i]).strip() for i in (machine_idx, date_idx)):
                raise ValueError(f"Registro {line} sem Data ou Máquina.")
            machines.add(str(row[machine_idx]).strip())
            count += 1
            if len(sample) < 20:
                sample.append(list(row))
        if not count:
            raise ValueError("O arquivo contém apenas o cabeçalho.")
        return dict(headers=headers, rows=sample, count=count, machines=sorted(machines))
    finally:
        rows.close()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONT), **kwargs)

    def respond_json(self, result, status=200):
        body = json.dumps(result, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            if url.path == "/api/historico":
                self.respond_json(database.history())
            elif url.path == "/api/regras":
                self.respond_json({"regras": event_evaluation.public_rules()})
            elif url.path == "/api/leituras":
                self.respond_json(database.readings(parse_qs(url.query)))
            elif url.path == "/api/referencia":
                params = parse_qs(url.query)
                machine = params.get("maquina", [""])[0]
                if not machine:
                    raise ValueError("Selecione uma bomba para calcular a referência.")
                self.respond_json(database.baseline(machine,
                    params.get("inicio", ["2026-06-01"])[0],
                    params.get("fim", ["2026-06-08"])[0]))
            elif url.path == "/api/avaliacao-eventos":
                machine = parse_qs(url.query).get("maquina", [""])[0]
                if not machine:
                    raise ValueError("Selecione uma bomba para comparar os avisos.")
                self.respond_json(event_evaluation.evaluate(machine))
            elif url.path == "/api/saude":
                machine = parse_qs(url.query).get("maquina", [""])[0]
                if not machine:
                    raise ValueError("Selecione uma bomba para calcular a nota de saúde.")
                self.respond_json(event_evaluation.health_score(machine))
            elif url.path == "/api/saude-historico":
                params = parse_qs(url.query)
                machine = params.get("maquina", [""])[0]
                if not machine:
                    raise ValueError("Selecione uma bomba para consultar a evolução da saúde.")
                self.respond_json(event_evaluation.health_history(
                    machine, params.get("inicio", [None])[0], params.get("fim", [None])[0]
                ))
            else:
                super().do_GET()
        except ValueError as exc:
            self.respond_json({"error": str(exc)}, 400)
        except sqlite3.Error:
            self.respond_json({"error": "Falha ao consultar o banco. Tente novamente."}, 503)

    def do_POST(self):
        if self.path != "/api/importar":
            self.send_error(404)
            return
        try:
            extension = self.headers.get("X-Formato", "")
            if extension not in ("csv", "xlsx"):
                raise ValueError("Selecione um arquivo CSV ou XLSX.")
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= LIMIT:
                raise ValueError("Envie um arquivo entre 1 byte e 25 MB.")
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Upload incompleto. Envie o arquivo novamente.")
            result = preview(raw, extension)
            name = unquote(self.headers.get("X-Nome-Arquivo", "arquivo." + extension))[:255]
            rows = records(raw, extension)
            try:
                result.update(database.save_import(raw, name, rows))
            finally:
                rows.close()
            status = 200
        except (ValueError, csv.Error) as exc:
            status, result = 400, {"error": str(exc)}
        except (BadZipFile, KeyError, OSError):
            status, result = 400, {"error": "Arquivo inválido. Confira o formato e exporte novamente."}
        except sqlite3.Error:
            status, result = 503, {"error": "Falha ao salvar no banco. Tente novamente."}
        except Exception:
            status, result = 422, {"error": "Arquivo ilegível. Confira se ele abre no Excel."}
        body = json.dumps(result, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


from http.client import HTTPConnection
from threading import Thread
import sys
import webbrowser


def iniciar():
    testar = "--teste" in sys.argv
    abrir = "--abrir" in sys.argv
    porta = 0 if abrir or testar else 8000
    with ThreadingHTTPServer(("127.0.0.1", porta), Handler) as servidor:
        url = f"http://127.0.0.1:{servidor.server_port}/"
        thread = Thread(target=servidor.serve_forever, daemon=True)
        thread.start()
        try:
            conexao = HTTPConnection("127.0.0.1", servidor.server_port, timeout=8)
            try:
                conexao.request("GET", "/")
                resposta = conexao.getresponse()
                if resposta.status != 200 or b"Importar leituras" not in resposta.read():
                    raise RuntimeError("A tela de importação não foi encontrada.")
                if testar:
                    arquivo = "Data;Máquina\n01/06/2026 00:00;bomba1".encode()
                    conexao.request("POST", "/api/importar", body=arquivo,
                                    headers={"X-Formato": "csv"})
                    resposta = conexao.getresponse()
                    if resposta.status != 200 or json.load(resposta)["count"] != 1:
                        raise RuntimeError("Falha ao verificar o envio de CSV.")
            finally:
                conexao.close()
            print(f"Pump Guardian disponível em {url}", flush=True)
            if testar:
                print("Página e importação CSV verificadas.")
                return
            if abrir:
                webbrowser.open(url)
            print("Mantenha esta janela aberta enquanto usa o sistema.", flush=True)
            thread.join()
        except KeyboardInterrupt:
            pass
        finally:
            servidor.shutdown()


if __name__ == "__main__":
    if "--teste" in sys.argv:
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as folder:
            database.DB_PATH = Path(folder) / "teste.db"
            iniciar()
    else:
        iniciar()
