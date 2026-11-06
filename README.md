# Pump Guardian — importação de leituras

Na raiz do projeto, com Python 3.10 ou superior, execute no Windows:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\.venv\Scripts\python.exe backend/server.py
```

Abra http://127.0.0.1:8000 e selecione CSV ou XLSX. O frontend em HTML, CSS e JavaScript envia o arquivo ao backend Python. O servidor conta todas as leituras e retorna até 20 linhas para conferência. Os dados ficam em memória durante a requisição.

O CSV aceita separadores vírgula, ponto e vírgula ou tabulação e codificações UTF-8 ou Windows-1252. Use cabeçalhos únicos incluindo Data e Máquina. No Excel, somente a aba Relatório Operacional é lida. Limite de 25 MB por envio. A interface informa erros de estrutura e o registro que precisa ser conferido quando aplicável.

No Windows, dê dois cliques em **Abrir Pump Guardian.cmd**. Ele escolhe uma porta livre e abre o navegador depois de verificar a página. Mantenha a janela aberta durante o uso.
