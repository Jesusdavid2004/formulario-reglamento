const body = document.querySelector('#employees-body');
const tabs = document.querySelectorAll('.tab');
let employees = [];
let activeFilter = 'TODOS';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
}

function render() {
  const visible = activeFilter === 'TODOS' ? employees : employees.filter((employee) => employee.estado === activeFilter);
  body.innerHTML = visible.map((employee) => `
    <tr>
      <td>${escapeHtml(employee.cedula)}</td>
      <td><strong>${escapeHtml(employee.nombre)}</strong><small>${escapeHtml(employee.dependencia)}</small></td>
      <td>${escapeHtml(employee.cargo)}</td>
      <td><span class="status ${employee.estado === 'FIRMADO' ? 'status-signed' : 'status-pending'}">${escapeHtml(employee.estado)}</span></td>
      <td>${employee.estado === 'FIRMADO' ? `<a class="pdf-link" href="/${employee.pdf_path || ''}" target="_blank">Ver PDF</a>` : '<span class="muted">-</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-state">No hay registros para este filtro.</td></tr>';
}

function updateSummary() {
  const signed = employees.filter((employee) => employee.estado === 'FIRMADO').length;
  document.querySelector('#total-count').textContent = employees.length;
  document.querySelector('#pending-count').textContent = employees.length - signed;
  document.querySelector('#signed-count').textContent = signed;
  document.querySelector('#progress-count').textContent = employees.length ? `${Math.round((signed / employees.length) * 100)}%` : '0%';
}

async function loadEmployees() {
  const response = await fetch('/empleados');
  employees = await response.json();
  updateSummary();
  render();
}

tabs.forEach((tab) => tab.addEventListener('click', () => {
  activeFilter = tab.dataset.filter;
  tabs.forEach((item) => item.classList.toggle('active', item === tab));
  render();
}));

document.querySelector('#public-url').textContent = window.location.origin;
document.querySelector('#csv-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData();
  formData.append('archivo', document.querySelector('#csv-file').files[0]);
  const response = await fetch('/admin/importar-csv', { method: 'POST', body: formData });
  const result = await response.json();
  const output = document.querySelector('#import-message');
  output.textContent = result.message || result.error;
  output.className = `message ${response.ok ? 'success' : 'error'}`;
  if (response.ok) await loadEmployees();
});

loadEmployees().catch(() => {
  body.innerHTML = '<tr><td colspan="5" class="empty-state">No fue posible cargar los empleados.</td></tr>';
});
