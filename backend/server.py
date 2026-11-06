from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from io import BytesIO, StringIO
from zipfile import ZipFile, BadZipFile
import csv
import json

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
            result = preview(self.rfile.read(size), extension)
            status = 200
        except (ValueError, csv.Error) as exc:
            status, result = 400, {"error": str(exc)}
        except (BadZipFile, KeyError, OSError):
            status, result = 400, {"error": "Arquivo inválido. Confira o formato e exporte novamente."}
        except Exception:
            status, result = 422, {"error": "Arquivo ilegível. Confira se ele abre no Excel."}
        body = json.dumps(result, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("Pump Guardian em http://127.0.0.1:8000", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
