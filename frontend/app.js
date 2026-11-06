const form = document.querySelector("form");
const fileInput = document.querySelector("#file");
const statusText = document.querySelector("#status");
const section = document.querySelector("section");
const button = form.querySelector("button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  section.hidden = true;
  const format = file.name.split(".").pop().toLowerCase();
  if (!["csv", "xlsx"].includes(format) || !file.size || file.size > 25 * 1024 ** 2) {
    statusText.textContent = "Escolha um CSV ou XLSX com conteúdo e até 25 MB.";
    return;
  }
  button.disabled = fileInput.disabled = true;
  statusText.textContent = "Enviando e conferindo as leituras…";
  try {
    const response = await fetch("/api/importar", {
      method: "POST", headers: {"X-Formato": format}, body: file
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const table = section.querySelector("table");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    for (const title of data.headers) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = title;
      head.append(cell);
    }
    const body = table.createTBody();
    for (const record of data.rows) {
      const row = body.insertRow();
      for (const value of record) row.insertCell().textContent = value ?? "—";
    }
    document.querySelector("#summary").textContent =
      data.machines.join(", ") + " · Primeiras " + data.rows.length + " de " +
      data.count.toLocaleString("pt-BR") + " leituras · " + data.headers.length + " colunas";
    section.hidden = false;
    statusText.textContent = file.name + " processado.";
  } catch (error) {
    statusText.textContent = error instanceof TypeError ? "Falha ao conectar ao servidor." : error.message;
  } finally {
    button.disabled = fileInput.disabled = false;
  }
});
