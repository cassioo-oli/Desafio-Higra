# Pump Guardian — importação de leituras

Na raiz do projeto, com Python 3.10 ou superior, execute no Windows:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\.venv\Scripts\python.exe backend/server.py
```

Abra http://127.0.0.1:8000 e selecione CSV ou XLSX. O frontend em HTML, CSS e JavaScript envia o arquivo ao backend Python. O servidor conta todas as leituras e retorna até 20 linhas para conferência. As leituras ficam salvas em backend/pump_guardian.db e podem ser consultadas após reiniciar o sistema.

O CSV aceita separadores vírgula, ponto e vírgula ou tabulação e codificações UTF-8 ou Windows-1252. Use cabeçalhos únicos incluindo Data e Máquina. No Excel, somente a aba Relatório Operacional é lida. Limite de 25 MB por envio. A interface informa erros de estrutura e o registro que precisa ser conferido quando aplicável.

No Windows, dê dois cliques em **Abrir Pump Guardian.cmd**. Ele escolhe uma porta livre e abre o navegador depois de verificar a página. Mantenha a janela aberta durante o uso.

## Histórico e validação

O upload salva uma importação inteira em uma transação. Arquivos idênticos são reconhecidos pelo conteúdo. Leituras iguais da mesma bomba e horário são contadas como repetidas. Valores conflitantes, datas inválidas e sensores com texto em campos numéricos cancelam a importação inteira. Corrija o arquivo indicado antes de reenviar. Decimais aceitam ponto ou vírgula, sem separadores de milhar.

Campos de sensor vazios ficam como nulos e são contabilizados no resumo. Datas são tratadas como horários locais da fonte. Confirme o fuso do equipamento antes de integrar outras fontes.

O histórico permite filtrar bomba e datas, com 50 leituras por página. A lista mostra as últimas 100 importações. O indicador de lacunas conta intervalos maiores que 1 minuto entre leituras da mesma bomba dentro do período selecionado. Um minuto é a referência adotada para esta amostra e deve ser revisado para outras frequências de coleta.

### Organização

- backend/server.py recebe as requisições e lê CSV/Excel.
- backend/database.py valida os valores, salva e consulta o SQLite.
- frontend/app.js controla o envio e a prévia.
- frontend/history.js controla filtros, histórico e paginação.
- backend/pump_guardian.db é criado automaticamente e ignorado pelo Git.

### Conferência manual

1. Abra o iniciador e envie a planilha.
2. Veja o resumo de novas leituras e consulte o Histórico salvo.
3. Envie o mesmo arquivo novamente e confira zero novas leituras.
4. Feche o servidor e abra o iniciador novamente. O histórico deve continuar disponível.

O modo --teste usa banco temporário. Guarde uma cópia do banco local com o servidor fechado quando precisar fazer backup dos dados.
