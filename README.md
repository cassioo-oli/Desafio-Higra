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

### Funcionamento normal

O painel calcula a referência por bomba entre 01/06/2026 e 08/06/2026. Inclui somente registros com Rotacao (rpm) maior que zero, usando as leituras completas guardadas no banco. Assim as noites em que a bomba ficou desligada não puxam a média dos sensores para baixo. Mostra quantidade válida, média, mínimo, máximo, amplitude e variância populacional. Os pesos vêm do documento Higra e são parâmetros iniciais.

O arquivo higra.xlsx contém resumos prontos nas abas ligada e ligada e desligada. Eles não substituem o cálculo da janela de 01 a 08 de junho, porque cobrem outro recorte. A aba Sheet1 está vazia.

### Validação dos avisos

O botão **Comparar avisos com eventos** reproduz as leituras entre 09 e 30/06/2026 em ordem cronológica. A referência é calculada apenas com leituras em que `Rotacao (rpm) > 0`, entre 01 e 08/06. Nenhum cálculo do detector consulta a coluna `Alarme`, o gabarito ou leituras futuras. O calendário dos quatro eventos só é usado depois para medir o resultado.

As regras iniciais exigem sinais combinados e persistência. Cavitação usa vibração alta junto de oscilação recente de vazão e pressão, para filtrar um pico único. Desbalanceamento compara tensão, corrente e temperatura da fase S com as fases R/T. Mancal combina temperatura radial, diferença radial-axial e vibração contra referências por hora. Rotor/entupimento exige três horas operacionais seguidas com vazão abaixo de 97% da referência horária, pressão abaixo de 99,5% e rendimento pelo menos 2 pontos menor. Horas com menos de 30 leituras operacionais não são avaliadas.

O relatório separa antecedência em relação ao início do evento e ao limiar em que o alarme da amostra disparou. Um aviso que chega depois do início, mas antes do limiar, aparece como aviso antecipado do limiar, sem afirmar que previu o começo da falha. Episódios da regra sem correspondência com os eventos são contados como falsos positivos; o limite do desafio é dois. Lacunas de comunicação são contabilizadas e nunca preenchidas com zeros. As regras são heurísticas iniciais baseadas nos sinais descritos no desafio. Como foram definidas para esta amostra conhecida, o resultado não é uma validação independente; para medir generalização, congele as regras e avalie outro período ainda não usado para defini-las.

Na base local atual, a reprodução encontrou aviso antes do limiar nos quatro eventos, um falso positivo (abaixo do limite de dois) e um intervalo sem leitura de 49 minutos. O primeiro aviso de cavitação apareceu 18 minutos depois do início do evento, mas 1 minuto antes do limiar; os outros avisos chegaram 1h17 antes do limiar elétrico, 37h01 antes do limiar do mancal e 5 dias e 56 minutos antes do limiar de vazão. Estes resultados descrevem regras iniciais deste conjunto de dados e precisam ser revistos pela equipe antes de serem tratados como desempenho operacional.

### Nota de saúde

O botão **Calcular nota de saúde** mostra a nota na última leitura em que a bomba estava ligada. A fórmula provisória começa em 100 e desconta 25 pontos por regra de falha persistente ativa, com limite de 0 a 100. A tabela identifica a regra, os sensores envolvidos, o motivo e quando o aviso começou. A nota usa as regras persistentes descritas acima; leituras com motor desligado não contam como condição de falha e lacunas de dados não reduzem a nota.

Na base local, a última leitura operacional é de 30/06/2026 às 23:59. O alerta de desgaste/entupimento ainda está ativo, então a nota exibida é 75/100, com desconto de 25 pontos para vazão, pressão e rendimento. Os pontos iguais por regra são uma escala inicial de demonstração, não um peso de severidade aprovado pela Higra. A equipe deve validar essa escala com especialistas antes de usá-la para decisões de manutenção.

### Organização

- backend/server.py recebe as requisições e lê CSV/Excel.
- backend/database.py valida os valores, salva e consulta o SQLite.
- backend/event_evaluation.py calcula referências e avalia os alertas da amostra sem usar datas futuras.
- frontend/app.js controla o envio e a prévia.
- frontend/history.js controla filtros, histórico e paginação.
- A seção Validação dos avisos compara os resultados com os quatro eventos e conta falsos positivos.
- A seção Nota de saúde mostra a nota e explica a regra persistente e os sensores que geraram cada desconto.
- backend/pump_guardian.db é criado automaticamente e ignorado pelo Git.

### Conferência manual

1. Abra o iniciador e envie a planilha.
2. Veja o resumo de novas leituras e consulte o Histórico salvo.
3. Envie o mesmo arquivo novamente e confira zero novas leituras.
4. Feche o servidor e abra o iniciador novamente. O histórico deve continuar disponível.

O modo --teste usa banco temporário. Guarde uma cópia do banco local com o servidor fechado quando precisar fazer backup dos dados.
