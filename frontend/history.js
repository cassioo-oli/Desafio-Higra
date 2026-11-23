const historyStatus = document.querySelector("#history-status");
const filterForm = document.querySelector("#filters");
const machineSelect = document.querySelector("#machine");
let page = 1;
let requestNumber = 0;

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
  historyStatus.textContent = "Consultando histórico…";
  document.querySelector("#previous").disabled = true;
  document.querySelector("#next").disabled = true;
  const params = new URLSearchParams(new FormData(filterForm));
  if (machineSelect.value) params.set("maquina", machineSelect.value);
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
    machineSelect.replaceChildren(new Option("Todas as bombas", ""));
    for (const name of data.bombas) machineSelect.add(new Option(name, name));
    if (data.bombas.includes(selected)) machineSelect.value = selected;
    showTable(document.querySelector("#imports"), data.importacoes.map(item => ({
      Arquivo: item.nome, Enviado: item.criado_em.replace("T", " "),
      Leituras: item.total, Novas: item.novas, Repetidas: item.repetidas,
      "Campos vazios": item.ausentes
    })));
    page = 1;
    await loadReadings();
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
  loadReadings();
  if (!document.querySelector("#painel-saude").hidden) calculateHealth();
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
  const machine = machineSelect.value || machineSelect.options[1]?.value;
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
  const machine = machineSelect.value || machineSelect.options[1]?.value;
  const button = document.querySelector("#calculate-health");
  const status = document.querySelector("#health-status");
  if (!machine) {
    status.textContent = "Importe as leituras e selecione uma bomba antes de calcular.";
    return;
  }
  button.disabled = true;
  status.textContent = "Calculando a nota pelas regras persistentes…";
  try {
    document.querySelector("#health-discounts").replaceChildren();
    document.querySelector("#health-score").textContent = "";
    document.querySelector("#active-zones").textContent = "Atualizando os avisos ativos…";
    const data = await getJson("/api/saude?" + new URLSearchParams({maquina: machine}));
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
    const asOf = data.snapshot_em ? " Referência até " + data.snapshot_em + "." : "";
    status.textContent = data.status + asOf + " " + data.lacunas_de_comunicacao +
      " intervalo(s) sem leitura foram mantidos como lacunas.";
  } catch (error) {
    document.querySelector("#active-zones").textContent = "Não foi possível atualizar os avisos ativos.";
    window.pumpHealthAlerts = [];
    window.dispatchEvent(new CustomEvent("pump-health-updated", {detail: []}));
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

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
  const machine = machineSelect.value || machineSelect.options[1]?.value;
  if (!machine) {
    historyStatus.textContent = "Importe as leituras antes de calcular o funcionamento normal.";
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

