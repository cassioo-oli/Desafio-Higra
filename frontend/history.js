const historyStatus = document.querySelector("#history-status");
const filterForm = document.querySelector("#filters");
const machineSelect = document.querySelector("#machine");
let page = 1;
let requestNumber = 0;
let healthRequestNumber = 0;
let healthHistoryRequestNumber = 0;
let importedRows = [];

async function getJson(url) {
  const response = await fetch(url);
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

async function refreshHistory() {
  try {
    const data = await getJson("/api/historico");
    const selected = machineSelect.value;
    machineSelect.replaceChildren(new Option("Selecione uma bomba…", ""));
    for (const name of data.bombas) machineSelect.add(new Option(name, name));
    if (data.bombas.includes(selected)) machineSelect.value = selected;
    importedRows = data.importacoes.map(item => ({
      Arquivo: item.nome, Enviado: item.criado_em.replace("T", " "),
      Leituras: item.total, Novas: item.novas, Repetidas: item.repetidas,
      "Campos vazios": item.ausentes
    }));
    document.querySelector("#imports-section").hidden = !machineSelect.value;
    showTable(document.querySelector("#imports"), machineSelect.value ? importedRows : []);
    page = 1;
    await loadReadings();
    await calculateHealth();
    if (machineSelect.value) await loadHealthHistory();
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
machineSelect.addEventListener("change", () => {
  page = 1;
  document.querySelector("#imports-section").hidden = !machineSelect.value;
  showTable(document.querySelector("#imports"), machineSelect.value ? importedRows : []);
  document.querySelector("#calculate-health").disabled = !machineSelect.value;
  loadReadings();
  calculateHealth();
  if (machineSelect.value) loadHealthHistory();
  else clearHealthHistory();
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
  const machine = machineSelect.value;
  const button = document.querySelector("#evaluate-events");
  const status = document.querySelector("#evaluation-status");
  if (!machine) {
    status.textContent = "Importe as leituras e selecione uma bomba antes de avaliar.";
    return;
  }
  button.disabled = true;
  status.textContent = "Reproduzindo as leituras em ordem cronológica…";
  document.querySelector("#evaluation-summary").replaceChildren();
  document.querySelector("#evaluation-events").replaceChildren();
  document.querySelector("#false-alerts").replaceChildren();
  try {
    const data = await getJson("/api/avaliacao-eventos?" + new URLSearchParams({maquina: machine}));
    showTable(document.querySelector("#evaluation-events"), data.eventos.map(event => ({
      Evento: event.id + " · " + event.evento,
      Resultado: event.status,
      "Aviso confirmado": event.alerta_em || "—",
      "Início do evento": event.inicio_evento,
      "Limiar de alarme": event.limiar_alarme,
      "Antecedência ao início": formatDelay(event.minutos_antes_do_evento, "início do evento"),
      "Antecedência ao limiar": formatDelay(event.minutos_antes_do_limiar, "limiar de alarme"),
      "Regra utilizada": event.regra
    })));
    showTable(document.querySelector("#false-alerts"), data.falsos_positivos.map(alert => ({
      Tipo: alert.falha, "Aviso confirmado": alert.confirmado_em, Condição: alert.previsto
    })));
    const timely = data.eventos.filter(event => event.detectado).length;
    const summary = document.querySelector("#evaluation-summary");
    for (const text of [
      timely + " de " + data.eventos.length + " eventos tiveram aviso até o limiar de alarme",
      data.eventos.filter(event => event.alerta_emitido).length + " de " + data.eventos.length + " tiveram algum aviso associado",
      data.quantidade_falsos_positivos + " alertas sem evento correspondente · limite " +
        data.limite_falsos_positivos + " · " + (data.dentro_limite ? "dentro do limite" : "acima do limite"),
      data.lacunas_de_comunicacao + " intervalo(s) sem leitura detectado(s); lacunas não são convertidas em zeros"
    ]) {
      const line = document.createElement("div"); line.className = "summary-item";
      line.textContent = text;
      summary.append(line);
    }
    document.querySelector("#false-alerts-status").textContent = data.falsos_positivos.length
      ? "São contados episódios sem correspondência com os quatro eventos."
      : "Nenhum episódio de alerta sem correspondência foi encontrado.";
    document.querySelector("#evaluation-notes").textContent = data.nota;
    status.textContent = "Avaliação concluída. Os eventos servem apenas para pontuar o replay; as regras não usam seus horários.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#evaluate-events").addEventListener("click", evaluateEvents);

async function calculateHealth() {
  const currentRequest = ++healthRequestNumber;
  const machine = machineSelect.value;
  const button = document.querySelector("#calculate-health");
  const status = document.querySelector("#health-status");
  if (!machine) {
    button.disabled = true;
    status.textContent = "Selecione uma bomba no cabeçalho para ver a avaliação.";
    document.querySelector("#health-score").innerHTML = "— <small>/ 100</small>";
    document.querySelector("#health-formula").textContent = "";
    document.querySelector("#health-methodology").textContent = "Selecione uma bomba para ver os sinais e os motivos.";
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
  updateHealthAlert(machine, null);
  window.pumpHealthAlerts = [];
  window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
  try {
    document.querySelector("#health-discounts").replaceChildren();
    document.querySelector("#health-score").textContent = "";
    document.querySelector("#active-zones").textContent = "Atualizando os avisos ativos…";
    const data = await getJson("/api/saude?" + new URLSearchParams({maquina: machine}));
    if (currentRequest !== healthRequestNumber) return;
    document.querySelector("#health-score").textContent = data.nota === null
      ? "Nota indisponível"
      : data.nota + " / 100";
    document.querySelector("#health-formula").textContent = data.formula;
    document.querySelector("#health-methodology").textContent = data.nota_metodologica || "";
    showTable(document.querySelector("#health-discounts"), data.descontos.map(item => ({
      Regra: item.regra, "Sinais envolvidos": item.sinais,
      "Desconto (pontos)": item.pontos_descontados, Motivo: item.motivo,
      "Aviso ativo desde": item.alerta_confirmado_em || "—"
    })));
    const activeZones = document.querySelector("#active-zones");
    activeZones.replaceChildren();
    if (data.descontos.length) {
      for (const item of data.descontos) {
        const chip = document.createElement("span");
        chip.className = "zone-chip";
        chip.textContent = item.regra + " · aviso ativo";
        activeZones.append(chip);
      }
    } else {
      activeZones.textContent = "Nenhum aviso persistente ativo nesta bomba no fim do histórico.";
    }
    window.pumpHealthAlerts = data.descontos;
    window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: data.descontos}));
    updateHealthAlert(machine, data);
    const asOf = data.snapshot_em ? " Referência até " + data.snapshot_em + "." : "";
    status.textContent = data.status + asOf + " " + data.lacunas_de_comunicacao +
      " intervalo(s) sem leitura foram mantidos como lacunas.";
  } catch (error) {
    if (currentRequest !== healthRequestNumber) return;
    document.querySelector("#active-zones").textContent = "Não foi possível atualizar os avisos ativos.";
    window.pumpHealthAlerts = [];
    window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
    updateHealthAlert(machine, null);
    status.textContent = error.message;
  } finally {
    if (currentRequest === healthRequestNumber) button.disabled = false;
  }
}

function updateHealthAlert(machine, data) {
  const banner = document.querySelector("#health-alert");
  const detail = document.querySelector("#health-alert-detail");
  const deductions = data?.descontos || [];
  const signature = machine + ":" + deductions.map(item => item.regra).sort().join("|");
  if (!deductions.length) {
    banner.hidden = true;
    banner.dataset.signature = "";
    banner.dataset.dismissed = "";
    return;
  }
  const points = deductions.reduce((total, item) => total + Number(item.pontos_descontados || 0), 0);
  const rules = deductions.map(item => item.regra).join(", ");
  detail.textContent = machine + " · " + rules + " · " + points + " ponto(s) descontado(s) na avaliação.";
  if (banner.dataset.signature !== signature) {
    banner.dataset.signature = signature;
    banner.dataset.dismissed = "";
    banner.classList.remove("alert-pulse");
    void banner.offsetWidth;
    banner.classList.add("alert-pulse");
  }
  banner.hidden = banner.dataset.dismissed === signature;
}

document.querySelector("#health-alert-go").addEventListener("click", () => {
  document.querySelector('#tab-saude').click();
  document.querySelector("#calculate-health").focus();
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
    status.textContent = error.message;
    renderHealthHistory({dias: [], alertas: [], nota_atual: null, media_diaria: null, minima_diaria: null});
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
  const alerts = data.alertas || [];
  document.querySelector("#period-current").textContent = data.nota_atual == null ? "—" : data.nota_atual + "/100";
  document.querySelector("#period-current-date").textContent = data.data_nota_atual
    ? new Date(data.data_nota_atual + "T12:00:00").toLocaleDateString("pt-BR") : "Sem leituras no período";
  document.querySelector("#period-average").textContent = data.media_diaria == null ? "—" : data.media_diaria + "/100";
  document.querySelector("#period-minimum").textContent = data.minima_diaria == null ? "—" : data.minima_diaria + "/100";
  chart.replaceChildren();
  const title = makeSvg("title");
  title.textContent = "Nota diária da bomba selecionada";
  chart.append(title);
  if (days.length) {
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
    const xFor = index => days.length === 1 ? left + width / 2 : left + index * width / (days.length - 1);
    const points = days.map((day, index) => xFor(index) + "," + yFor(day.nota)).join(" ");
    chart.append(makeSvg("polyline", {points, class:"chart-line"}));
    const labelStep = Math.max(1, Math.ceil((days.length - 1) / 5));
    days.forEach((day, index) => {
      const x = xFor(index), y = yFor(day.nota);
      const dot = makeSvg("circle", {cx:x, cy:y, r:days.length > 35 ? 2.8 : 4, class:"chart-point"});
      const tip = makeSvg("title");
      tip.textContent = new Date(day.data + "T12:00:00").toLocaleDateString("pt-BR") + " · Nota " + day.nota + "/100" +
        (day.regras_ativas.length ? " · " + day.regras_ativas.join(", ") : " · Sem regras ativas");
      dot.append(tip);
      chart.append(dot);
      if (index % labelStep === 0 || index === days.length - 1) {
        const dateLabel = makeSvg("text", {x, y:top+height+24, "text-anchor":"middle", class:"chart-axis-label"});
        dateLabel.textContent = new Date(day.data + "T12:00:00").toLocaleDateString("pt-BR", {day:"2-digit", month:"2-digit"});
        chart.append(dateLabel);
      }
    });
  } else {
    const empty = makeSvg("text", {x:380, y:135, "text-anchor":"middle", class:"chart-empty"});
    empty.textContent = "Sem leituras para este período";
    chart.append(empty);
  }
  status.textContent = days.length
    ? days.length + " dia(s) com leituras · " + alerts.length + " aviso(s) confirmado(s) no período · " +
      (data.lacunas_de_comunicacao || 0) + " intervalo(s) sem comunicação no histórico."
    : "Não há leituras dentro do período escolhido.";
  const list = document.querySelector("#health-period-alerts");
  list.replaceChildren();
  document.querySelector("#period-alert-count").textContent = alerts.length + (alerts.length === 1 ? " aviso" : " avisos");
  document.querySelector("#period-alerts-empty").hidden = alerts.length > 0;
  for (const alert of alerts) {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = alert.nome;
    const details = document.createElement("span");
    details.textContent = "Confirmado em " + new Date(alert.confirmado_em).toLocaleString("pt-BR") +
      " · Condição observada desde " + new Date(alert.inicio_condicao).toLocaleString("pt-BR");
    item.append(name, details);
    list.append(item);
  }
}

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
      const title = document.createElement("h3"); title.textContent = rule.nome;
      const signals = document.createElement("p"); signals.innerHTML = "<strong>Sinais:</strong> "; signals.append(document.createTextNode(rule.sinais));
      const duration = document.createElement("p"); duration.className = "rule-duration"; duration.textContent = "Tempo mínimo: " + rule.duracao;
      const windowText = document.createElement("p"); windowText.textContent = rule.janela;
      card.append(title, signals, duration, windowText); grid.append(card);
    }
  } catch (error) { grid.textContent = "Não foi possível carregar as regras. " + error.message; }
}
loadRuleCatalog();

async function loadBaseline() {
  const machine = machineSelect.value;
  if (!machine) {
    document.querySelector("#baseline-status").textContent = "Selecione uma bomba no cabeçalho antes de calcular a referência.";
    return;
  }
  const start = document.querySelector("#baseline-start").value || "2026-06-01";
  const end = document.querySelector("#baseline-end").value || "2026-06-08";
  try {
    const params = new URLSearchParams({maquina: machine, inicio: start, fim: end});
    const data = await getJson("/api/referencia?" + params);
    showTable(document.querySelector("#baseline-table"), Object.entries(data.sinais).map(([signal, stats]) => ({
      Sinal: signal, Peso: stats.peso, Leituras: stats.leituras,
      Média: stats.media.toFixed(2), Mínimo: stats.minimo.toFixed(2),
      Máximo: stats.maximo.toFixed(2), Amplitude: stats.amplitude.toFixed(2),
      Variância: stats.variancia.toFixed(2)
    })));
    document.querySelector("#baseline-status").textContent =
      data.maquina + " · " + data.inicio + " a " + data.fim + " · " +
      data.leituras_consideradas.toLocaleString("pt-BR") + " leituras consideradas com " + data.criterio +
      " (de " + data.leituras_periodo.toLocaleString("pt-BR") + " registros no período).";
  } catch (error) {
    document.querySelector("#baseline-status").textContent = error.message;
  }
}
document.querySelector("#calculate-baseline").addEventListener("click", loadBaseline);

