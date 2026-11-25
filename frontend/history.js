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
    await loadHealthHistory();
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



const healthPeriodForm = document.querySelector("#health-period-filters");
healthPeriodForm.addEventListener("submit", event => {
  event.preventDefault();
  loadHealthHistory();
});
machineSelect.addEventListener("change", loadHealthHistory);

async function loadHealthHistory() {
  const request = ++healthHistoryRequestNumber;
  const machine = machineSelect.value;
  const status = document.querySelector("#health-history-status");
  if (!machine) {
    status.textContent = "Selecione uma bomba para consultar a evolução.";
    document.querySelector("#health-daily-average").textContent = "—";
    document.querySelector("#health-daily-minimum").textContent = "—";
    document.querySelector("#health-daily-minimum-date").textContent = "";
    document.querySelector("#health-period-alerts").replaceChildren();
    document.querySelector("#health-history-method").textContent = "";
    drawHealthChart([]);
    return;
  }
  status.textContent = "Calculando a evolução diária…";
  const params = new URLSearchParams({maquina: machine});
  const start = document.querySelector("#health-start").value;
  const end = document.querySelector("#health-end").value;
  if (start) params.set("inicio", start);
  if (end) params.set("fim", end);
  try {
    const data = await getJson("/api/saude/historico?" + params);
    if (request !== healthHistoryRequestNumber) return;
    const period = data.periodo;
    document.querySelector("#health-daily-average").textContent =
      data.media_diaria === null ? "—" : data.media_diaria.toLocaleString("pt-BR") + " / 100";
    const minimum = data.minima_diaria;
    document.querySelector("#health-daily-minimum").textContent =
      minimum ? minimum.nota + " / 100" : "—";
    document.querySelector("#health-daily-minimum-date").textContent =
      minimum ? "Em " + formatHealthDate(minimum.data) : "";
    drawHealthChart(data.serie);
    renderPeriodAlerts(data.alertas_periodo);
    document.querySelector("#health-history-method").textContent = data.mensagem || "";
    if (!data.dias_com_dados) {
      status.textContent = data.mensagem || "Não há dias com dados nesse período.";
      return;
    }
    status.textContent = machine + " · " + formatHealthDate(period.inicio) + " a " +
      formatHealthDate(period.fim) + " · " + data.dias_com_dados +
      (data.dias_com_dados === 1 ? " dia com dados operacionais." : " dias com dados operacionais.");
  } catch (error) {
    if (request !== healthHistoryRequestNumber) return;
    status.textContent = error.message;
    document.querySelector("#health-daily-average").textContent = "—";
    document.querySelector("#health-daily-minimum").textContent = "—";
    document.querySelector("#health-daily-minimum-date").textContent = "";
    document.querySelector("#health-period-alerts").replaceChildren();
    drawHealthChart([]);
  }
}

function formatHealthDate(value) {
  if (!value) return "—";
  return new Date(value + "T00:00:00").toLocaleDateString("pt-BR");
}

function renderPeriodAlerts(alerts) {
  const list = document.querySelector("#health-period-alerts");
  list.replaceChildren();
  if (!alerts.length) {
    const item = document.createElement("li");
    item.className = "period-alert-empty";
    item.textContent = "Nenhum alerta foi confirmado no período selecionado.";
    list.append(item);
    return;
  }
  for (const alert of alerts) {
    const item = document.createElement("li");
    item.className = "period-alert";
    const title = document.createElement("strong");
    title.textContent = alert.falha;
    const date = document.createElement("time");
    date.dateTime = alert.confirmado_em;
    date.textContent = "Confirmado em " + new Date(alert.confirmado_em).toLocaleString("pt-BR");
    const description = document.createElement("span");
    description.textContent = alert.previsto;
    item.append(title, date, description);
    list.append(item);
  }
}

function drawHealthChart(series) {
  const svg = document.querySelector("#health-chart");
  svg.replaceChildren();
  const svgNS = "http://www.w3.org/2000/svg";
  const make = (tag, attributes = {}, text = "") => {
    const element = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text) element.textContent = text;
    return element;
  };
  svg.append(
    make("title", {id:"health-chart-title"}, "Evolução diária da nota de saúde"),
    make("desc", {id:"health-chart-description"}, "Nota diária de zero a cem no período selecionado.")
  );
  if (!series.length) {
    svg.append(make("text", {x:380,y:142,"text-anchor":"middle",class:"chart-empty"},
      "Sem dias com leitura operacional neste período."));
    return;
  }
  const left = 54, right = 18, top = 20, bottom = 46, width = 760, height = 280;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  for (const value of [0,25,50,75,100]) {
    const y = top + (100 - value) / 100 * plotHeight;
    svg.append(
      make("line", {x1:left,y1:y,x2:width-right,y2:y,class:"chart-grid"}),
      make("text", {x:left-10,y:y+4,"text-anchor":"end",class:"chart-axis-label"}, String(value))
    );
  }
  const points = series.map((item, index) => ({
    item,
    x: series.length === 1 ? left + plotWidth / 2 : left + index * plotWidth / (series.length - 1),
    y: top + (100 - item.nota) / 100 * plotHeight,
  }));
  svg.append(make("polyline", {
    points: points.map(point => point.x + "," + point.y).join(" "),
    class:"chart-line"
  }));
  for (const point of points) {
    const dot = make("circle", {cx:point.x,cy:point.y,r:4,class:"chart-point"});
    dot.append(make("title", {}, formatHealthDate(point.item.data) + ": " + point.item.nota + " / 100"));
    svg.append(dot);
  }
  const labelIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  for (const index of labelIndexes) {
    const point = points[index];
    svg.append(make("text", {
      x:point.x,y:height-14,"text-anchor":index===0?"start":index===series.length-1?"end":"middle",
      class:"chart-axis-label"
    }, formatHealthDate(point.item.data)));
  }
}
