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

