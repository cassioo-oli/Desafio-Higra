const historyStatus = document.querySelector("#history-status");
const filterForm = document.querySelector("#filters");
const machineSelect = document.querySelector("#machine");
let page = 1;
let requestNumber = 0;
let healthRequestNumber = 0;
let healthHistoryRequestNumber = 0;
let importedRows = [];
let currentReference = null;
let referenceRequestNumber = 0;
let evaluationRequestNumber = 0;
const selectedMachineStorageKey = "pump-guardian-machine";

function phaseFamily(alert) {
  if (/^corrente_[rst]$/.test(alert.tipo || "")) return "corrente";
  if (/^tensao_[rst]$/.test(alert.tipo || "")) return "tensao";
  return null;
}

function visibleStatus(status) {
  return status === "confirmado" ? "Em aberto" : status === "pré-alerta" ? "Em observação" : status || "Aviso";
}

function groupPhaseAlerts(alerts, windowMinutes = 5) {
  const sorted = [...alerts].sort((left, right) =>
    Date.parse(left.confirmado_em || left.detectado_em) - Date.parse(right.confirmado_em || right.detectado_em));
  const groups = [];
  for (const alert of sorted) {
    const family = phaseFamily(alert);
    const timestamp = Date.parse(alert.confirmado_em || alert.detectado_em);
    const group = family && [...groups].reverse().find(item => item.family === family &&
      Math.abs(timestamp - item.firstTimestamp) <= windowMinutes * 60000);
    if (group) {
      group.members.push(alert);
    } else {
      groups.push({family, members: [alert], firstTimestamp: timestamp});
    }
  }
  return groups.map(group => {
    const members = group.members;
    const first = members[0];
    const phases = members.map(item => (item.sinais.match(/fase\s+([RST])/i) || [])[1]?.toUpperCase()).filter(Boolean);
    const points = members.reduce((sum, item) => sum + Number(item.pontos_descontados || 0), 0);
    const starts = members.map(item => item.inicio_condicao || item.detectado_em).filter(Boolean).sort();
    const confirmations = members.map(item => item.confirmado_em).filter(Boolean).sort();
    const durationMinutes = starts.length && confirmations.length
      ? Math.max(0, Math.round((Date.parse(confirmations.at(-1)) - Date.parse(starts[0])) / 60000))
      : null;
    return {
      ...first,
      family: group.family,
      members,
      nome: group.family === "corrente" ? "Corrente anormal" : group.family === "tensao" ? "Tensão anormal" : (first.regra || first.falha),
      regra: group.family ? (group.family === "corrente" ? "Corrente anormal" : "Tensão anormal") : (first.regra || first.falha),
      status: members.some(item => item.status === "confirmado") ? "confirmado" : first.status,
      prioridade: members.some(item => item.prioridade === "alta") ? "alta" : first.prioridade,
      pontos_descontados: points,
      inicio_condicao: starts[0] || first.inicio_condicao,
      confirmado_em: confirmations.at(-1) || first.confirmado_em,
      fases: phases,
      duracao_confirmacao_minutos: durationMinutes,
      sinais: group.family
        ? members.map(item => `${(item.sinais.match(/fase\s+([RST])/i) || [])[1]?.toUpperCase() || "Fase"}: ${Number(item.pontos_descontados || 0)} pts`).join(" · ")
        : first.sinais,
      motivo: [...new Set(members.map(item => item.motivo || item.previsto).filter(Boolean))].join(" "),
    };
  });
}

async function getJson(url) {
  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function showTable(target, records) {
  target.replaceChildren();
  if (!records.length) return;
  const headers = [...new Set(records.flatMap(record => Object.keys(record)))];
  const head = target.createTHead().insertRow();
  for (const title of headers) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = title;
    head.append(cell);
  }
  const body = target.createTBody();
  for (const record of records) {
    const row = body.insertRow();
    for (const title of headers) row.insertCell().textContent = record[title] ?? "—";
  }
}

async function loadReadings() {
  const currentRequest = ++requestNumber;
  const readingsTable = document.querySelector("#saved-readings");
  document.querySelector("#previous").disabled = true;
  document.querySelector("#next").disabled = true;
  if (!machineSelect.value) {
    readingsTable.replaceChildren();
    historyStatus.textContent = "Selecione uma bomba no cabeçalho para consultar as leituras salvas.";
    return;
  }
  readingsTable.replaceChildren();
  historyStatus.textContent = "Consultando histórico…";
  if (currentReference && document.querySelector("#reading-period").value === "analysis" &&
      nextDay(currentReference.fim) > currentReference.disponivel_fim) {
    historyStatus.textContent = "Ainda não há leituras posteriores à referência. Você pode consultar todos os dados importados.";
    return;
  }
  const params = new URLSearchParams(new FormData(filterForm));
  params.set("maquina", machineSelect.value);
  params.set("pagina", page);
  try {
    const data = await getJson("/api/leituras?" + params);
    if (currentRequest !== requestNumber) return;
    showTable(document.querySelector("#saved-readings"), data.leituras);
    historyStatus.textContent = data.total.toLocaleString("pt-BR") + " leituras encontradas. Página " +
      page + " de " + Math.max(1, Math.ceil(data.total / 50)) + ". " + data.lacunas +
      " intervalos maiores que 1 minuto no período selecionado.";
    document.querySelector("#previous").disabled = page <= 1;
    document.querySelector("#next").disabled = page * 50 >= data.total;
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    historyStatus.textContent = error.message;
    document.querySelector("#saved-readings").replaceChildren();
    document.querySelector("#previous").disabled = true;
    document.querySelector("#next").disabled = true;
  }
}

async function refreshHistory(event) {
  try {
    const data = await getJson("/api/historico");
    const uploadedMachine = event?.detail?.machines?.find(name => data.bombas.includes(name));
    const rememberedMachine = localStorage.getItem(selectedMachineStorageKey);
    const selected = uploadedMachine || machineSelect.value || rememberedMachine || "";
    machineSelect.replaceChildren(new Option("Selecione uma bomba…", ""));
    for (const name of data.bombas) machineSelect.add(new Option(name, name));
    if (data.bombas.includes(selected)) machineSelect.value = selected;
    resetSelectedPump();
    if (machineSelect.value) localStorage.setItem(selectedMachineStorageKey, machineSelect.value);
    importedRows = data.importacoes.map(item => ({
      Arquivo: item.nome, Enviado: item.criado_em.replace("T", " "),
      Leituras: item.total, Novas: item.novas, Repetidas: item.repetidas,
      "Campos vazios": item.ausentes
    }));
    document.querySelector("#imports-section").hidden = !machineSelect.value;
    showTable(document.querySelector("#imports"), machineSelect.value ? importedRows : []);
    page = 1;
    await loadReferencePeriod();
    await loadReadings();
    await calculateHealth();
    if (machineSelect.value) await loadHealthHistory();
    await evaluateEvents();
  } catch (error) {
    historyStatus.textContent = "Não foi possível carregar o histórico. " + error.message;
  }
}

filterForm.addEventListener("submit", event => {
  event.preventDefault();
  page = 1;
  loadReadings();
});
document.querySelector("#previous").addEventListener("click", () => {
  page = Math.max(1, page - 1);
  loadReadings();
});
document.querySelector("#next").addEventListener("click", () => {
  page += 1;
  loadReadings();
});
window.addEventListener("importacao-concluida", refreshHistory);
refreshHistory();
machineSelect.addEventListener("change", async () => {
  resetSelectedPump();
  page = 1;
  document.querySelector("#imports-section").hidden = !machineSelect.value;
  showTable(document.querySelector("#imports"), machineSelect.value ? importedRows : []);
  document.querySelector("#calculate-health").disabled = !machineSelect.value;
  if (machineSelect.value) localStorage.setItem(selectedMachineStorageKey, machineSelect.value);
  else localStorage.removeItem(selectedMachineStorageKey);
  await loadReferencePeriod();
  await loadReadings();
  await calculateHealth();
  if (machineSelect.value) await loadHealthHistory();
  else clearHealthHistory();
  await evaluateEvents();
});

function formatDelay(minutes, anchor) {
  if (minutes === null || minutes === undefined) return "Sem aviso";
  const amount = Math.abs(minutes);
  const days = Math.floor(amount / 1440);
  const hours = Math.floor((amount % 1440) / 60);
  const rest = amount % 60;
  const duration = [days ? days + " d" : "", hours ? hours + " h" : "", rest ? rest + " min" : ""]
    .filter(Boolean).join(" ") || "0 min";
  return minutes >= 0 ? duration + " antes" : duration + " depois do " + anchor;
}

async function evaluateEvents() {
  const request = ++evaluationRequestNumber;
  const machine = machineSelect.value;
  const button = document.querySelector("#evaluate-events");
  const status = document.querySelector("#evaluation-status");
  if (!machine) {
    status.textContent = "Importe as leituras e selecione uma bomba antes de avaliar.";
    document.querySelector("#evaluation-summary").replaceChildren();
    document.querySelector("#evaluation-events").replaceChildren();
    document.querySelector("#false-alerts").replaceChildren();
    document.querySelector("#false-alerts-status").textContent = "";
    document.querySelector("#evaluation-notes").textContent = "";
    return;
  }
  button.disabled = true;
  status.textContent = "Reproduzindo as leituras em ordem cronológica…";
  document.querySelector("#evaluation-summary").replaceChildren();
  document.querySelector("#evaluation-events").replaceChildren();
  document.querySelector("#false-alerts").replaceChildren();
  try {
    const data = await getJson("/api/avaliacao-eventos?" + new URLSearchParams({maquina: machine}));
    if (request !== evaluationRequestNumber || machine !== machineSelect.value) return;
    showTable(document.querySelector("#evaluation-events"), data.eventos.map(event => ({
      Ocorrência: event.id + " · " + event.evento,
      "Aviso confirmado": event.alerta_em || "Sem aviso",
      "Início real anotado": new Date(event.inicio_evento).toLocaleString("pt-BR"),
      "Antecedência ao início": formatDelay(event.minutos_antes_do_evento, "início do evento"),
      "Antecedência ao limiar": formatDelay(event.minutos_antes_do_limiar, "limiar de alarme")
    })));
    if (!data.eventos_rotulados_disponiveis) {
      showTable(document.querySelector("#evaluation-events"), data.alertas.map(alert => ({
        "Aviso encontrado": alert.falha,
        "Confirmado em": formatMoment(alert.confirmado_em),
        "Condição observada": alert.previsto,
        "Antecedência real": "Sem evento real anotado"
      })));
    }
    showTable(document.querySelector("#false-alerts"), (data.falsos_positivos || []).map(alert => ({
      Tipo: alert.falha, "Aviso confirmado": alert.confirmado_em, Condição: alert.previsto
    })));
    const summary = document.querySelector("#evaluation-summary");
    const summaries = data.eventos_rotulados_disponiveis ? [
      data.eventos.filter(event => event.alerta_emitido).length + " de " + data.eventos.length + " eventos tiveram aviso associado",
      data.eventos.filter(event => event.detectado).length + " avisos chegaram antes do limiar anotado",
      data.quantidade_falsos_positivos + " alertas sem evento correspondente · limite " + data.limite_falsos_positivos,
      data.lacunas_de_comunicacao + " intervalos sem leitura; lacunas não viram zeros"
    ] : [
      "Referência: " + data.referencia.inicio + " a " + data.referencia.fim,
      "Replay: " + data.reproducao.inicio + " a " + data.reproducao.fim,
      data.alertas.length + " aviso(s) persistente(s) encontrados no replay",
      "Sem eventos reais anotados nesta faixa: antecedência e falsos alarmes não podem ser medidos"
    ];
    for (const text of summaries) {
      const line = document.createElement("div"); line.className = "summary-item";
      line.textContent = text;
      summary.append(line);
    }
    document.querySelector("#false-alerts-status").textContent = !data.eventos_rotulados_disponiveis
      ? "Sem rótulos de falha para comparar neste período. Não classificamos os avisos como falsos positivos."
      : data.falsos_positivos.length
        ? "São contados episódios sem correspondência com os eventos conhecidos."
        : "Nenhum episódio de alerta sem correspondência foi encontrado.";
    document.querySelector("#evaluation-notes").textContent = data.nota;
    status.textContent = data.eventos_rotulados_disponiveis
      ? "Comparação concluída. A antecedência é medida contra os horários reais anotados, que não entram no detector."
      : "Replay concluído. O CSV não tem eventos reais anotados neste período, então não é possível calcular quanto antes a falha ocorreria.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#evaluate-events").addEventListener("click", evaluateEvents);
document.querySelector("#health-validation-link").addEventListener("click", () => {
  document.querySelector("#tab-avisos").click();
  document.querySelector("#evaluate-events").scrollIntoView({behavior: "smooth", block: "center"});
  evaluateEvents();
});

async function calculateHealth() {
  const currentRequest = ++healthRequestNumber;
  const startedAt = performance.now();
  const machine = machineSelect.value;
  const button = document.querySelector("#calculate-health");
  const status = document.querySelector("#health-status");
  if (!machine) {
    button.disabled = true;
    status.textContent = "Selecione uma bomba no cabeçalho para ver a avaliação.";
    document.querySelector("#health-score").innerHTML = "— <small>/ 100</small>";
    document.querySelector("#health-formula").textContent = "";
    document.querySelector("#health-methodology").textContent = "";
    document.querySelector("#observations-panel").hidden = true;
    document.querySelector("#operation-state").textContent = "Aguardando dados";
    document.querySelector("#health-discounts").replaceChildren();
    document.querySelector("#active-zones").textContent = "Selecione uma bomba para ver avisos.";
    clearHealthHistory();
    window.pumpHealthAlerts = [];
    window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
    updateHealthAlert("", null);
    return;
  }
  button.disabled = true;
  status.textContent = "Calculando a nota pelas regras persistentes…";
  updateHealthAlert(machine, {calculando:true});
  window.pumpHealthAlerts = [];
  window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
  try {
    document.querySelector("#health-discounts").replaceChildren();
    document.querySelector("#health-score").textContent = "";
    document.querySelector("#active-zones").textContent = "Atualizando os avisos ativos…";
    const data = await getJson("/api/saude?" + new URLSearchParams({maquina: machine}));
    const loadingTimeLeft = 500 - (performance.now() - startedAt);
    if (loadingTimeLeft > 0) await new Promise(resolve => setTimeout(resolve, loadingTimeLeft));
    if (currentRequest !== healthRequestNumber) return;
    document.querySelector("#health-score").textContent = data.nota === null
      ? "Nota indisponível"
      : data.nota + " / 100";
    document.querySelector("#health-formula").textContent = data.formula;
    document.querySelector("#health-methodology").textContent = data.nota_metodologica || "";
    const alerts = data.avisos || data.descontos || [];
    const groups = groupPhaseAlerts(alerts, Infinity);
    const confirmedCount = groups.filter(item => item.status === "confirmado").length;
    const observations = data.observacoes || [];
    document.querySelector("#observations-panel").hidden = !observations.length;
    document.querySelector("#observations-title").textContent = observations.length + " sinais em observação · sem desconto";
    const observationList = document.querySelector("#health-observations");
    observationList.replaceChildren();
    for (const observation of observations) {
      const row = document.createElement("p");
      row.textContent = observation.falha + " · desde " + formatMoment(observation.detectado_em);
      observationList.append(row);
    }
    const operation = document.querySelector("#operation-state");
    operation.textContent = data.operacao === "parada" ? "Bomba parada" : data.operacao === "operando" ? "Em operação" : "Sem leitura de rotação";
    operation.classList.toggle("is-stopped", data.operacao !== "operando");
    renderSignalGroups(document.querySelector("#health-discounts"), groups);
    const activeZones = document.querySelector("#active-zones");
    activeZones.replaceChildren();
    if (alerts.length) {
      for (const item of groups) {
        const chip = document.createElement("span");
        chip.className = "zone-chip";
        chip.textContent = (item.regra || item.falha) + (item.fases?.length ? " · " + item.fases.join("/") : "") + " · " + visibleStatus(item.status);
        activeZones.append(chip);
      }
    } else {
      activeZones.textContent = "Nenhum aviso persistente ativo nesta bomba no fim do histórico.";
    }
    window.pumpHealthAlerts = alerts;
    window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: alerts}));
    updateHealthAlert(machine, data);
    status.textContent = data.nota === null ? data.status
      : confirmedCount + (confirmedCount === 1 ? " condição em aberto" : " condições em aberto") +
        " · última leitura " + formatMoment(data.ultima_leitura || data.snapshot_em) +
        (data.operacao === "parada" ? ". Avisos anteriores permanecem em acompanhamento." : "");
  } catch (error) {
    if (currentRequest !== healthRequestNumber) return;
    document.querySelector("#active-zones").textContent = "Não foi possível atualizar os avisos ativos.";
    window.pumpHealthAlerts = [];
    window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
    updateHealthAlert(machine, {erro:error.message});
    status.textContent = error.message;
  } finally {
    if (currentRequest === healthRequestNumber) button.disabled = false;
  }
}

function updateHealthAlert(machine, data) {
  const banner = document.querySelector("#health-alert");
  const detail = document.querySelector("#health-alert-detail");
  if (!machine || !data) {
    banner.hidden = true;
    banner.dataset.signature = "";
    banner.dataset.dismissed = "";
    banner.classList.remove("is-critical", "is-watch", "is-clear", "is-error", "is-loading");
    return;
  }
  const alerts = data.avisos || data.descontos || [];
  const points = alerts.reduce((total, item) => total + Number(item.pontos_descontados || 0), 0);
  const groups = groupPhaseAlerts(alerts, Infinity);
  const confirmed = groups.filter(item => item.status === "confirmado");
  const preAlerts = groups.filter(item => item.status === "pré-alerta");
  const informational = groups.filter(item => item.status === "informativo");
  const signature = machine + ":" + (data.calculando ? "calculando" : data.erro || data.nota) + ":" +
    alerts.map(item => (item.tipo || item.regra || item.falha) + item.status + item.pontos_descontados).sort().join("|");
  const kicker = document.querySelector("#health-alert-kicker");
  const title = document.querySelector("#health-alert-title");
  const action = document.querySelector("#health-alert-go");
  const mark = banner.querySelector(".alert-mark");
  banner.classList.remove("is-critical", "is-watch", "is-clear", "is-error", "is-loading");
  if (data.calculando) {
    banner.classList.add("is-loading");
    mark.textContent = "…";
    kicker.textContent = "PUMP GUARDIAN · ATUALIZANDO DADOS";
    title.textContent = "Calculando a saúde da bomba…";
    detail.textContent = "Reproduzindo as leituras em ordem e atualizando a avaliação.";
    action.textContent = "Abrir saúde da bomba";
  } else if (data.erro) {
    banner.classList.add("is-error");
    mark.textContent = "×";
    kicker.textContent = "PUMP GUARDIAN · NÃO FOI POSSÍVEL CONCLUIR";
    title.textContent = "A avaliação da bomba falhou";
    detail.textContent = machine + " · " + data.erro;
    action.textContent = "Ver detalhes";
  } else if (!alerts.length) {
    banner.classList.add("is-clear");
    mark.textContent = "✓";
    kicker.textContent = "PUMP GUARDIAN · AVALIAÇÃO CONCLUÍDA";
    title.textContent = "Nenhum aviso persistente detectado";
    detail.textContent = machine + " · Nota " + (data.nota == null ? "indisponível" : data.nota + "/100") +
      (data.snapshot_em ? " · Leituras avaliadas até " + data.snapshot_em : "") +
      " · A tela foi atualizada com as leituras salvas.";
    action.textContent = "Ver saúde da bomba";
  } else {
    const critical = points > 0;
    banner.classList.add(critical ? "is-critical" : "is-watch");
    mark.textContent = critical ? "!" : "i";
    kicker.textContent = critical ? "PUMP GUARDIAN · AÇÃO RECOMENDADA" : "PUMP GUARDIAN · ACOMPANHAMENTO";
    title.textContent = critical ? "Sinais fora do padrão por tempo prolongado" :
      preAlerts.length ? "Pré-alerta: acompanhe a bomba" : "Aviso de monitoramento";
    detail.textContent = machine + " · Nota " + data.nota + "/100 · " +
      (confirmed.length ? confirmed.length + " ocorrência(s) persistente(s)" : "") +
      (preAlerts.length ? (confirmed.length ? " · " : "") + preAlerts.length + " pré-alerta(s)" : "") +
      (informational.length ? " · " + informational.length + " aviso(s) informativo(s)" : "") +
      " · desconto total: " + points + " pontos.";
    action.textContent = "Ver saúde da bomba";
  }
  const assertive = Boolean(data.erro || alerts.some(item => item.status === "confirmado" && item.pontos_descontados > 0));
  banner.setAttribute("role", assertive ? "alert" : "status");
  banner.setAttribute("aria-live", assertive ? "assertive" : "polite");
  if (banner.dataset.signature !== signature) {
    banner.dataset.signature = signature;
    banner.dataset.dismissed = "";
    banner.classList.remove("alert-pulse");
    void banner.offsetWidth;
    banner.classList.add("alert-pulse");
  }
  banner.hidden = banner.dataset.dismissed === signature || (!data.calculando && !data.erro && !confirmed.length);
}

document.querySelector("#health-alert-go").addEventListener("click", () => {
  const banner = document.querySelector("#health-alert");
  banner.dataset.dismissed = banner.dataset.signature;
  banner.hidden = true;
  document.querySelector('#tab-saude').click();
  document.querySelector("#health-score").focus({preventScroll:true});
});
document.querySelector("#health-alert-dismiss").addEventListener("click", () => {
  const banner = document.querySelector("#health-alert");
  banner.dataset.dismissed = banner.dataset.signature;
  banner.hidden = true;
});

document.querySelector("#calculate-health").addEventListener("click", calculateHealth);

function clearHealthHistory() {
  healthHistoryRequestNumber += 1;
  document.querySelector("#health-history-card").hidden = true;
  document.querySelector("#health-chart").replaceChildren();
  document.querySelector("#health-period-alerts").replaceChildren();
  document.querySelector("#period-current").textContent = "—";
  document.querySelector("#period-current-date").textContent = "";
  document.querySelector("#period-average").textContent = "—";
  document.querySelector("#period-minimum").textContent = "—";
}

async function loadHealthHistory(useSelectedPeriod = false) {
  const machine = machineSelect.value;
  if (!machine) {
    clearHealthHistory();
    return;
  }
  const currentRequest = ++healthHistoryRequestNumber;
  const card = document.querySelector("#health-history-card");
  const status = document.querySelector("#health-history-status");
  card.hidden = false;
  status.textContent = "Calculando a evolução por dia…";
  document.querySelector("#health-chart").replaceChildren();
  document.querySelector("#health-period-alerts").replaceChildren();
  const params = new URLSearchParams({maquina: machine});
  if (useSelectedPeriod) {
    const start = document.querySelector("#health-start").value;
    const end = document.querySelector("#health-end").value;
    if (start) params.set("inicio", start);
    if (end) params.set("fim", end);
  }
  try {
    const data = await getJson("/api/saude-historico?" + params);
    if (currentRequest !== healthHistoryRequestNumber) return;
    if (!useSelectedPeriod) {
      document.querySelector("#health-start").value = data.inicio;
      document.querySelector("#health-end").value = data.fim;
    }
    document.querySelector("#health-start").min = data.inicio_disponivel;
    document.querySelector("#health-end").min = data.inicio_disponivel;
    document.querySelector("#health-start").max = data.fim_disponivel;
    document.querySelector("#health-end").max = data.fim_disponivel;
    renderHealthHistory(data);
  } catch (error) {
    if (currentRequest !== healthHistoryRequestNumber) return;
    renderHealthHistory({error: error.message, dias: [], alertas: [], nota_atual: null, media_diaria: null, minima_diaria: null});
  }
}

function renderHealthHistory(data) {
  const chart = document.querySelector("#health-chart");
  const status = document.querySelector("#health-history-status");
  const svgNS = "http://www.w3.org/2000/svg";
  const makeSvg = (name, attributes = {}) => {
    const element = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  };
  const days = data.dias || [];
  const alerts = (data.alertas || []).filter(alert => alert.confirmado_em);
  const reference = data.periodo_referencia;
  if (reference) {
    document.querySelector("#health-period-caption").textContent =
      "Referência: " + new Date(reference.inicio + "T12:00:00").toLocaleDateString("pt-BR") + " a " +
      new Date(reference.fim + "T12:00:00").toLocaleDateString("pt-BR") +
      " · dias da referência não recebem nota.";
  }
  document.querySelector("#period-current").textContent = data.nota_atual == null ? "—" : data.nota_atual + "/100";
  document.querySelector("#period-current-date").textContent = data.data_nota_atual
    ? new Date(data.data_nota_atual + "T12:00:00").toLocaleDateString("pt-BR") : "Sem leituras no período";
  document.querySelector("#period-average").textContent = data.media_diaria == null ? "—" : data.media_diaria + "/100";
  document.querySelector("#period-minimum").textContent = data.minima_diaria == null ? "—" : data.minima_diaria + "/100";
  chart.replaceChildren();
  const title = makeSvg("title");
  title.textContent = "Nota diária da bomba selecionada";
  chart.append(title);
  const plotPoints = days.length ? (data.evolucao || []) : [];
  if (plotPoints.length) {
    const left = 52, right = 18, top = 20, bottom = 42;
    const width = 760 - left - right, height = 280 - top - bottom;
    const yFor = score => top + ((100 - score) / 100) * height;
    for (const score of [0, 25, 50, 75, 100]) {
      const y = yFor(score);
      chart.append(makeSvg("line", {x1:left, y1:y, x2:left+width, y2:y, class:"chart-gridline"}));
      const label = makeSvg("text", {x:left-10, y:y+4, "text-anchor":"end", class:"chart-axis-label"});
      label.textContent = score;
      chart.append(label);
    }
    const firstTime = Date.parse(plotPoints[0].momento), lastTime = Date.parse(plotPoints.at(-1).momento);
    const xFor = index => lastTime === firstTime ? left + width / 2 : left + (Date.parse(plotPoints[index].momento)-firstTime) / (lastTime-firstTime) * width;
    const points = plotPoints.map((day,index) => (index ? xFor(index) + "," + yFor(plotPoints[index-1].nota) + " " : "") + xFor(index) + "," + yFor(day.nota)).join(" ");
    chart.append(makeSvg("polyline", {points, class:"chart-line"}));
    const labelStep = Math.max(1, Math.ceil((plotPoints.length - 1) / 5));
    plotPoints.forEach((day, index) => {
      const x = xFor(index), y = yFor(day.nota);
      const activeAlerts = (day.avisos_ativos || []).filter(alert =>
        alert.status === "confirmado" && Number(alert.pontos_descontados || 0) > 0);
      const dot = makeSvg("circle", {
        cx:x, cy:y, r:plotPoints.length > 35 ? 3.5 : 5,
        class:"chart-point " + (activeAlerts.length ? "is-alert" : "is-normal")
      });
      const tip = makeSvg("title");
      const difference = index ? day.nota - plotPoints[index - 1].nota : null;
      const changeText = difference === null ? "" : difference === 0 ? " · sem mudança desde a alteração anterior"
        : difference > 0 ? " · subiu " + difference + " pontos desde a alteração anterior"
          : " · caiu " + Math.abs(difference) + " pontos desde a alteração anterior";
      const alertText = activeAlerts.length
        ? " · Descontos ativos: " + activeAlerts.map(alert => alert.nome + " (-" + alert.pontos_descontados + ")").join(", ")
        : " · Sem desconto de alerta confirmado ativo";
      tip.textContent = new Date(day.momento).toLocaleString("pt-BR") +
        " · Nota " + day.nota + "/100" + changeText + alertText;
      dot.append(tip);
      chart.append(dot);
      if (index % labelStep === 0 || index === plotPoints.length - 1) {
        const dateLabel = makeSvg("text", {x, y:top+height+24, "text-anchor":"middle", class:"chart-axis-label"});
        dateLabel.textContent = new Date(day.momento).toLocaleDateString("pt-BR", {day:"2-digit", month:"2-digit"});
        chart.append(dateLabel);
      }
    });
  } else {
    const empty = makeSvg("text", {x:380, y:135, "text-anchor":"middle", class:"chart-empty"});
    empty.textContent = "Sem leituras para este período";
    chart.append(empty);
  }
  status.textContent = days.length
    ? days.length + " dias avaliados · " + new Set(alerts.map(alert => phaseFamily(alert) || alert.tipo)).size + " condições no período"
    : data.error || "Não há leituras dentro do período escolhido.";
  renderOccurrenceHistory(alerts);
}

function formatPersistence(minutes) {
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours + " h" + (rest ? " " + rest + " min" : "");
}

function renderSignalGroups(target, groups) {
  target.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("p"); empty.className = "empty-state";
    empty.textContent = "Nenhuma condição confirmada em aberto."; target.append(empty);
  }
  for (const group of groups) {
    const card = document.createElement("article");
    card.className = "signal-item";
    const header = document.createElement("div");
    header.className = "signal-item-header";
    const name = document.createElement("strong");
    name.textContent = (group.regra || group.falha) + (group.fases?.length ? " · " + group.fases.join("/") : "");
    const state = document.createElement("span");
    state.className = "signal-state" + (group.pontos_descontados ? " is-warning" : "");
    state.textContent = visibleStatus(group.status) + " · " + group.pontos_descontados + " pts";
    header.append(name, state);
    const signals = document.createElement("p");
    signals.className = "signal-item-signals";
    signals.textContent = group.sinais || "Sinais conforme a regra";
    const meta = document.createElement("p");
    meta.className = "signal-item-meta";
    const start = group.inicio_condicao ? new Date(group.inicio_condicao).toLocaleString("pt-BR") : "—";
    const confirmed = group.confirmado_em ? formatMoment(group.confirmado_em) : "aguardando confirmação";
    meta.textContent = "Sinal desde " + start + " · confirmação " + confirmed +
      (group.duracao_confirmacao_minutos != null ? " · persistiu " + formatPersistence(group.duracao_confirmacao_minutos) + " até confirmar" : "");
    const reason = document.createElement("details");
    reason.className = "signal-reason";
    const summary = document.createElement("summary");
    summary.textContent = "Por que este aviso apareceu?";
    const explanation = document.createElement("p");
    explanation.textContent = group.motivo || group.previsto || "Sinal fora da referência definida.";
    reason.append(summary, signals, meta, explanation);
    card.append(header, reason);
    target.append(card);
  }
}

document.querySelector("#period-alert-toggle").addEventListener("click", event => {
  const button = event.currentTarget;
  const expanded = button.getAttribute("aria-expanded") === "true";
  const extras = document.querySelectorAll(".extra-period-alert");
  for (const item of extras) item.classList.toggle("is-collapsed", expanded);
  button.setAttribute("aria-expanded", String(!expanded));
  button.textContent = expanded ? "Mostrar todos" : "Mostrar menos";
});

document.querySelector("#health-period-form").addEventListener("submit", event => {
  event.preventDefault();
  loadHealthHistory(true);
});

async function loadRuleCatalog() {
  const grid = document.querySelector("#rules-grid");
  try {
    const data = await getJson("/api/regras");
    grid.replaceChildren();
    for (const rule of data.regras) {
      const card = document.createElement("article"); card.className = "rule-card";
      const title = document.createElement("h3"); title.textContent = "Regra " + rule.numero + " · " + rule.nome;
      const signals = document.createElement("p"); signals.innerHTML = "<strong>Sinais:</strong> "; signals.append(document.createTextNode(rule.sinais));
      const duration = document.createElement("p"); duration.className = "rule-duration"; duration.textContent = "Tempo mínimo: " + rule.duracao;
      const windowText = document.createElement("p"); windowText.textContent = rule.janela;
      const points = document.createElement("p"); points.className = "rule-duration";
      points.textContent = typeof rule.pontos === "string"
        ? "Peso por fase: " + rule.peso + " · Desconto: " + rule.pontos + "."
        : "Peso por sinal: " + rule.peso + " · Desconto da regra: " + rule.pontos + " pontos.";
      card.append(title, signals, duration, points, windowText); grid.append(card);
    }
  } catch (error) { grid.textContent = "Não foi possível carregar as regras. " + error.message; }
}
loadRuleCatalog();

async function loadReferencePeriod() {
  const request = ++referenceRequestNumber;
  const machine = machineSelect.value;
  const start = document.querySelector("#baseline-start");
  const end = document.querySelector("#baseline-end");
  const status = document.querySelector("#baseline-status");
  if (!machine) {
    currentReference = null;
    document.querySelector("#period-overview").hidden = true;
    document.querySelector("#data-period-caption").textContent = "";
    start.value = end.value = "";
    status.textContent = "Selecione uma bomba para carregar as datas disponíveis.";
    document.querySelector("#health-period-caption").textContent = "A referência e o período avaliado aparecem após selecionar uma bomba.";
    return;
  }
  try {
    const period = await getJson("/api/referencia-periodo?" + new URLSearchParams({maquina: machine}));
    if (request !== referenceRequestNumber || machine !== machineSelect.value) return;
    currentReference = period;
    renderPeriodOverview(period);
    applyReadingScope("analysis");
    start.min = end.min = period.disponivel_inicio;
    start.max = end.max = period.disponivel_fim;
    start.value = period.inicio;
    end.value = period.fim;
    document.querySelector("#health-period-caption").textContent =
      "Referência: " + new Date(period.inicio + "T12:00:00").toLocaleDateString("pt-BR") + " a " +
      new Date(period.fim + "T12:00:00").toLocaleDateString("pt-BR") +
      " · dias da referência não recebem nota.";
    status.textContent = (period.configurado ? "Referência salva" : "Período sugerido pelo arquivo") +
      " · disponível de " + period.disponivel_inicio + " a " + period.disponivel_fim +
      ". Confirme ou escolha outro intervalo com a bomba em operação.";
    try {
      const params = new URLSearchParams({maquina: machine, inicio: period.inicio, fim: period.fim});
      const baseline = await getJson("/api/referencia?" + params);
      if (request === referenceRequestNumber) renderBaselineTable(baseline);
    } catch (error) {
      status.textContent += " A janela atual não serve como referência: " + error.message;
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

async function loadBaseline() {
  const machine = machineSelect.value;
  if (!machine) {
    document.querySelector("#baseline-status").textContent = "Selecione uma bomba no cabeçalho antes de calcular a referência.";
    return;
  }
  const start = document.querySelector("#baseline-start").value;
  const end = document.querySelector("#baseline-end").value;
  try {
    const data = await postJson("/api/referencia-periodo", {maquina: machine, inicio: start, fim: end});
    renderBaselineTable(data);
    document.querySelector("#baseline-status").textContent =
      data.maquina + " · " + data.inicio + " a " + data.fim + " · " +
      data.leituras_consideradas.toLocaleString("pt-BR") + " leituras consideradas com Rotação acima de 100 rpm" +
      " (de " + data.leituras_periodo.toLocaleString("pt-BR") + " registros no período).";
    await loadReferencePeriod();
    page = 1;
    await loadReadings();
    await calculateHealth();
    await loadHealthHistory();
    await evaluateEvents();
  } catch (error) {
    document.querySelector("#baseline-status").textContent = error.message;
  }
}

function renderBaselineTable(data) {
  showTable(document.querySelector("#baseline-table"), Object.entries(data.sinais).map(([signal, stats]) => ({
    Sinal: signal, Peso: stats.peso, Leituras: stats.leituras,
    Média: stats.media.toFixed(2), Mínimo: stats.minimo.toFixed(2),
    Máximo: stats.maximo.toFixed(2), Amplitude: stats.amplitude.toFixed(2),
    Variância: stats.variancia.toFixed(2)
  })));
}
document.querySelector("#calculate-baseline").addEventListener("click", loadBaseline);


function formatMoment(value) {
  return value ? new Date(value).toLocaleString("pt-BR", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"}) : "—";
}

function resetSelectedPump() {
  healthRequestNumber += 1;
  evaluationRequestNumber += 1;
  requestNumber += 1;
  currentReference = null;
  clearHealthHistory();
  updateHealthAlert("", null);
  window.pumpHealthAlerts = [];
  window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
  for (const id of ["#health-discounts", "#baseline-table", "#evaluation-summary", "#evaluation-events", "#false-alerts"]) {
    document.querySelector(id).replaceChildren();
  }
  document.querySelector("#health-score").textContent = "—";
  document.querySelector("#health-status").textContent = "Carregando a bomba selecionada…";
  document.querySelector("#operation-state").textContent = "Aguardando dados";
  document.querySelector("#observations-panel").hidden = true;
  document.querySelector("#period-overview").hidden = true;
}

function renderOccurrenceHistory(alerts) {
  const families = new Map();
  for (const alert of alerts) {
    const key = phaseFamily(alert) || alert.tipo;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(alert);
  }
  const list = document.querySelector("#health-period-alerts");
  list.replaceChildren();
  document.querySelector("#period-alert-count").textContent = families.size + " condições";
  document.querySelector("#period-alert-toggle").hidden = true;
  document.querySelector("#period-alerts-empty").hidden = families.size > 0;
  for (const [key, members] of families) {
    members.sort((a,b) => a.confirmado_em.localeCompare(b.confirmado_em));
    const active = members.filter(item => !item.resolvido_em);
    const points = [...new Map(active.map(item => [item.tipo, Number(item.pontos_ativos || 0)])).values()].reduce((a,b)=>a+b,0);
    const item = document.createElement("li");
    item.className = "occurrence-card" + (active.length ? "" : " is-resolved");
    const header = document.createElement("div"); header.className = "occurrence-header";
    const name = document.createElement("strong");
    name.textContent = key === "corrente" ? "Corrente anormal" : key === "tensao" ? "Tensão anormal" : members[0].falha;
    const badge = document.createElement("span"); badge.className = "signal-state" + (active.length ? " is-warning" : "");
    badge.textContent = active.length ? "Em aberto · −" + points + " pts" : "Normalizada · sem desconto ativo";
    header.append(name, badge);
    const meta = document.createElement("p"); meta.className = "occurrence-meta";
    meta.textContent = "Primeiro aviso: " + formatMoment(members[0].confirmado_em) + " · situação no fim do período";
    const details = document.createElement("details"); details.className = "signal-reason";
    const summary = document.createElement("summary"); summary.textContent = "Ver fases e histórico";
    const scroll = document.createElement("div"); scroll.className = "scroll";
    const table = document.createElement("table");
    showTable(table, members.map(member => ({
      Sinal: member.sinais,
      "Aviso confirmado": formatMoment(member.confirmado_em),
      "Normalização observada": member.resolvido_em ? formatMoment(member.resolvido_em) : "Ainda em acompanhamento",
      "Desconto da condição": member.pontos_na_confirmacao + " pts"
    })));
    scroll.append(table); details.append(summary, scroll);
    item.append(header, meta, details); list.append(item);
  }
}

function nextDay(value) {
  const date = new Date(value + "T12:00:00"); date.setDate(date.getDate() + 1);
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
}
function shortDate(value) { return new Date(value + "T12:00:00").toLocaleDateString("pt-BR"); }
function renderPeriodOverview(period) {
  document.querySelector("#period-overview").hidden = false;
  document.querySelector("#period-imported").textContent = shortDate(period.disponivel_inicio) + " — " + shortDate(period.disponivel_fim);
  document.querySelector("#period-reference").textContent = shortDate(period.inicio) + " — " + shortDate(period.fim);
  document.querySelector("#period-analysis").textContent = nextDay(period.fim) <= period.disponivel_fim
    ? shortDate(nextDay(period.fim)) + " — " + shortDate(period.disponivel_fim) : "Aguardando novas leituras";
}
function applyReadingScope(scope) {
  if (!currentReference || scope === "custom") return;
  const p = currentReference;
  document.querySelector("#reading-period").value = scope;
  const start = document.querySelector("#start"), end = document.querySelector("#end");
  start.min = end.min = p.disponivel_inicio;
  start.max = end.max = p.disponivel_fim;
  start.value = scope === "all" ? p.disponivel_inicio : scope === "reference" ? p.inicio : nextDay(p.fim);
  end.value = scope === "reference" ? p.fim : p.disponivel_fim;
  document.querySelector("#data-period-caption").textContent = scope === "all" ? "Histórico completo, incluindo os dias usados como referência."
    : scope === "reference" ? "Dias usados para aprender o padrão de operação. Não recebem nota."
    : "Leituras avaliadas após o período de referência.";
}
document.querySelector("#reading-period").addEventListener("change", event => {applyReadingScope(event.target.value); page = 1; loadReadings();});
for (const input of ["#start", "#end"]) document.querySelector(input).addEventListener("input", () => {
  document.querySelector("#reading-period").value = "custom";
  document.querySelector("#data-period-caption").textContent = "Consulta das leituras nas datas escolhidas.";
});
document.querySelector("#edit-reference").addEventListener("click", () => {
  document.querySelector("#tab-avisos").click();
  document.querySelector("#baseline-start").focus();
});
