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

Na seção **Comparar avisos com os eventos**, escolha uma janela de referência dentro das datas disponíveis para a bomba. O sistema sugere os primeiros oito dias do histórico; você pode selecionar manualmente outro período mais representativo de operação normal. A escolha é salva por bomba no SQLite. A referência usa somente leituras com `Rotacao (rpm) > 100`, para excluir períodos desligados, e mostra quantidade válida, média, mínimo, máximo, amplitude e variância populacional. Os pesos vêm do documento Higra e são parâmetros iniciais.

O arquivo higra.xlsx contém resumos prontos nas abas ligada e ligada e desligada. Eles não substituem o cálculo da janela de referência selecionada, porque cobrem outro recorte. A aba Sheet1 está vazia.

### Validação dos avisos

O botão **Atualizar comparação** reproduz em ordem cronológica os dados posteriores ao fim da referência selecionada, até a última leitura disponível. Nenhum cálculo do detector consulta a coluna `Alarme`, o gabarito ou leituras futuras. O calendário dos quatro eventos conhecidos da amostra original só é usado depois para medir o resultado. Em CSVs sem eventos anotados para o período, a tela mostra os avisos, mas informa que não é possível medir antecedência real ou falsos alarmes.

As regras iniciais exigem sinais combinados e persistência. Cavitação usa vibração alta junto de oscilação recente de vazão e pressão, para filtrar um pico único. Desbalanceamento compara tensão, corrente e temperatura da fase S com as fases R/T. Mancal combina temperatura radial, diferença radial-axial e vibração contra referências por hora. Rotor/entupimento exige três horas operacionais seguidas com vazão abaixo de 97% da referência horária, pressão abaixo de 99,5% e rendimento pelo menos 2 pontos menor. Horas com menos de 30 leituras operacionais não são avaliadas.

O relatório separa antecedência em relação ao início do evento e ao limiar em que o alarme da amostra disparou. Um aviso que chega depois do início, mas antes do limiar, aparece como aviso antecipado do limiar, sem afirmar que previu o começo da falha. Episódios da regra sem correspondência com os eventos são contados como falsos positivos; o limite do desafio é dois. Lacunas de comunicação são contabilizadas e nunca preenchidas com zeros. As regras são heurísticas iniciais baseadas nos sinais descritos no desafio. Como foram definidas para esta amostra conhecida, o resultado não é uma validação independente; para medir generalização, congele as regras e avalie outro período ainda não usado para defini-las.

Na base local atual, a reprodução encontrou aviso antes do limiar nos quatro eventos, um falso positivo (abaixo do limite de dois) e um intervalo sem leitura de 49 minutos. O primeiro aviso de cavitação apareceu 18 minutos depois do início do evento, mas 1 minuto antes do limiar; os outros avisos chegaram 1h17 antes do limiar elétrico, 37h01 antes do limiar do mancal e 5 dias e 56 minutos antes do limiar de vazão. Estes resultados descrevem regras iniciais deste conjunto de dados e precisam ser revistos pela equipe antes de serem tratados como desempenho operacional.

### Nota de saúde

A aba Saúde mostra a nota atual e também a evolução diária no período selecionado, com média, mínima diária, gráfico e avisos identificados. Os cálculos usam apenas dias com leituras operacionais; dias sem dados não recebem uma nota.

O endpoint `/api/saude/historico` aceita `maquina` e os filtros opcionais `inicio` e `fim` no formato `AAAA-MM-DD`.

O botão **Atualizar avaliação** recalcula a nota na última leitura disponível. A fórmula começa em 100 e subtrai os pontos das ocorrências confirmadas ainda ativas, limitada a 0–100. O painel acompanha cinco grupos priorizados: cavitação (regra 1), mancal (regra 2), rotor confirmado (regra 6), correntes por fase (regra 8) e tensões por fase (regra 9). As demais regras do documento não aparecem na nota nem no painel de saúde. A tabela mostra a condição, o estado, os sinais, o peso por sinal, o desconto realmente aplicado e a explicação da regra.

As cinco regras de saúde vêm do documento Regras. Usam a janela de referência escolhida para a bomba; as avaliações e o gráfico começam no dia seguinte e usam apenas leituras disponíveis até cada dia. Novos CSVs são acrescentados ao banco; confira e ajuste o período de referência quando importar dados de outro intervalo. Para cavitação e rotor, quando a descrição apresenta uma faixa de pontos e a tabela informa um valor fechado, o protótipo usa provisoriamente os valores explícitos da tabela: 35 e 20 pontos. O mancal desconta 20 pontos. Corrente anormal desconta 6 pontos por fase detectada (até 18) e tensão anormal desconta 5 por fase (até 15). As fases continuam visíveis como sinais separados, para explicar cada desconto; fases da mesma família detectadas em até cinco minutos aparecem agrupadas visualmente, mantendo o desconto de cada fase. O tempo mostrado na Saúde mede quanto o sinal persistiu antes da confirmação do critério, não quanto antes da falha física. A antecedência real é calculada separadamente na comparação com os eventos rotulados. O pré-alerta de tendência do rotor é mantido internamente para confirmar a regra 6, mas não aparece como uma sexta regra e não desconta pontos. A nota diária e o gráfico são reproduzidos por data em ordem cronológica e só usam leituras até aquele dia; leituras originais não são alteradas.

A comparação com os quatro eventos conhecidos continua sendo uma avaliação separada do detector do desafio. Os pesos da saúde não mudam os registros brutos nem são uma escala clínica validada pela Higra. Revise limiares e pesos com a equipe antes de usar o indicador em decisões de manutenção.

### Organização

- backend/server.py recebe as requisições e lê CSV/Excel.
- backend/database.py valida os valores, salva e consulta o SQLite.
- backend/event_evaluation.py compara os avisos do desafio com os quatro eventos conhecidos.
- backend/health_rules.py reproduz as cinco regras de saúde priorizadas e calcula os descontos sem alterar as leituras.
- backend/health_service.py prepara as respostas da nota atual e do histórico diário.
- frontend/app.js controla o envio e a prévia.
- frontend/history.js controla filtros, histórico e paginação.
- A seção Validação dos avisos compara os resultados com os quatro eventos e conta falsos positivos.
- A seção Nota de saúde distingue pré-alertas, condições confirmadas e avisos informativos, explicando os sinais e os pontos aplicados.
- backend/pump_guardian.db é criado automaticamente e ignorado pelo Git.

### Ocorrências, paradas e períodos

- A rotação deve estar acima de 100 rpm para avaliar novos sinais. Rotação ausente ou até 100 rpm suspende a avaliação, mesmo que haja vazão residual.
- Um aviso confirmado permanece aberto durante paradas e lacunas. Repetir a mesma condição não cria outro desconto. A recuperação exige 6 horas de avaliações normais consecutivas em operação; uma parada reinicia essa contagem. Normalização dos sensores não é comprovação de manutenção realizada.
- Candidatos interrompidos antes da confirmação não aparecem no histórico de ocorrências. Candidatos atuais ficam recolhidos em **Sinais em observação**, sem desconto.
- O histórico mostra um cartão por condição. Os detalhes preservam as fases, confirmações e normalizações reais. Corrente e tensão continuam descontando por fase; episódios antigos não somam novos descontos ao atual.
- **Dados importados**, **Referência** e **Período avaliado** aparecem separadamente. Com referência de 1 a 8, a análise começa no dia 9. A aba Dados abre nesse recorte e permite consultar também o arquivo completo, sem apagar leituras.
- Os testes de regressão ficam em `backend/tests/test_health_lifecycle.py`. Execute `python -m unittest discover -s backend/tests -v`.

### Conferência na aplicação

1. Abra o iniciador e envie a planilha.
2. Veja o resumo de novas leituras e consulte o Histórico salvo.
3. Envie o mesmo arquivo novamente e confira zero novas leituras.
4. Feche o servidor e abra o iniciador novamente. O histórico deve continuar disponível.

O modo --teste usa banco temporário. Guarde uma cópia do banco local com o servidor fechado quando precisar fazer backup dos dados.

### Visualização 3D da bomba

A aba **Saúde** contém um modelo 3D interativo construído em Three.js a partir das formas visíveis na foto oficial de uma bomba submersa apresentada pela [HIGRA](https://higra.com.br/bomba-submersa/). Arraste com o mouse para girar, use a roda para aproximar, passe o cursor sobre as peças para identificá-las e use os botões para pausar ou restaurar a rotação. Alertas persistentes acendem em vermelho a parte aproximada relacionada à regra.

Este modelo é uma reconstrução visual para navegação e apresentação. Não é um arquivo CAD fornecido pela HIGRA e não representa um gêmeo digital; a posição vermelha orienta a inspeção, mas não determina a localização física do defeito. O Three.js 0.187.0 está incluído localmente em `frontend/vendor/three/` com sua licença MIT, para a visualização não depender de uma conexão com CDN.
