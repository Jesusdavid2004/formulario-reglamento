const body = document.querySelector('#employees-body');
const tabs = document.querySelectorAll('.tab');
const searchInput = document.querySelector('#employee-search');
const dependencyFilter = document.querySelector('#dependency-filter');
const clearFiltersButton = document.querySelector('#clear-filters');
let employees = [];
let activeFilter = 'TODOS';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[character]));
}

function render() {
  const search = searchInput.value.trim().toLocaleLowerCase('es');
  const dependency = dependencyFilter.value;
  const visible = employees.filter((employee) => {
    const matchesStatus = activeFilter === 'TODOS' || employee.estado === activeFilter;
    const matchesDependency = dependency === 'TODAS' || employee.dependencia === dependency;
    const searchable = `${employee.nombre} ${employee.cedula} ${employee.cargo}`.toLocaleLowerCase('es');
    return matchesStatus && matchesDependency && (!search || searchable.includes(search));
  });
  body.innerHTML = visible.map((employee) => `
    <tr>
      <td>${escapeHtml(employee.cedula)}</td>
      <td><strong>${escapeHtml(employee.nombre)}</strong><small>${escapeHtml(employee.dependencia)}</small></td>
      <td>${escapeHtml(employee.cargo)}</td>
      <td><span class="status ${employee.estado === 'FIRMADO' ? 'status-signed' : 'status-pending'}">${escapeHtml(employee.estado)}</span></td>
      <td>${employee.estado === 'FIRMADO' ? `<a class="pdf-link" href="/admin/pdf?path=${encodeURIComponent(employee.pdf_path || '')}" target="_blank">Ver PDF</a>` : '<span class="muted">-</span>'}</td>
      <td class="actions-cell">
        <button class="edit-button" type="button" data-cedula="${escapeHtml(employee.cedula)}">Editar</button>
        <button class="delete-button" type="button" data-cedula="${escapeHtml(employee.cedula)}" data-nombre="${escapeHtml(employee.nombre)}">Borrar</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty-state">No hay registros para este filtro.</td></tr>';
}

function updateDependencyFilter() {
  const current = dependencyFilter.value;
  const dependencies = [...new Set(employees.map((employee) => employee.dependencia).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second, 'es'));
  dependencyFilter.innerHTML = '<option value="TODAS">Todas las dependencias</option>'
    + dependencies.map((dependency) => `<option value="${escapeHtml(dependency)}">${escapeHtml(dependency)}</option>`).join('');
  dependencyFilter.value = dependencies.includes(current) ? current : 'TODAS';
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
  updateDependencyFilter();
  updateSummary();
  render();
}

tabs.forEach((tab) => tab.addEventListener('click', () => {
  activeFilter = tab.dataset.filter;
  tabs.forEach((item) => item.classList.toggle('active', item === tab));
  render();
}));

searchInput.addEventListener('input', render);
dependencyFilter.addEventListener('change', render);
clearFiltersButton.addEventListener('click', () => {
  searchInput.value = '';
  dependencyFilter.value = 'TODAS';
  activeFilter = 'TODOS';
  tabs.forEach((item) => item.classList.toggle('active', item.dataset.filter === 'TODOS'));
  render();
});

body.addEventListener('click', async (event) => {
  const editButton = event.target.closest('.edit-button');
  if (editButton) {
    const employee = employees.find((item) => item.cedula === editButton.dataset.cedula);
    if (!employee) return;
    const row = editButton.closest('tr');
    row.classList.add('editing-row');
    row.querySelector('td:nth-child(2)').innerHTML = `
      <input class="inline-input" data-edit="nombre" value="${escapeHtml(employee.nombre)}" aria-label="Nombre">
      <small>${escapeHtml(employee.dependencia)}</small>`;
    row.querySelector('td:nth-child(3)').innerHTML = '<input class="inline-input" data-edit="cargo" value="' + escapeHtml(employee.cargo) + '" aria-label="Cargo">';
    row.querySelector('td:nth-child(2) small').outerHTML = '<input class="inline-input" data-edit="dependencia" value="' + escapeHtml(employee.dependencia) + '" aria-label="Dependencia">';
    editButton.outerHTML = '<button class="save-button" type="button" data-cedula="' + escapeHtml(employee.cedula) + '">Guardar</button>';
    return;
  }

  const saveButton = event.target.closest('.save-button');
  if (saveButton) {
    const row = saveButton.closest('tr');
    const payload = Object.fromEntries([...row.querySelectorAll('[data-edit]')].map((input) => [input.dataset.edit, input.value.trim()]));
    saveButton.disabled = true;
    const response = await fetch(`/admin/empleados/${encodeURIComponent(saveButton.dataset.cedula)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      window.alert(result.error || 'No fue posible guardar los cambios.');
      saveButton.disabled = false;
      return;
    }
    await loadEmployees();
    return;
  }

  const button = event.target.closest('.delete-button');
  if (!button) return;
  const cedula = button.dataset.cedula;
  const nombre = button.dataset.nombre;
  if (!window.confirm(`¿Borrar definitivamente el registro de ${nombre} (${cedula})? También se eliminará su PDF.`)) return;
  button.disabled = true;
  const response = await fetch(`/admin/empleados/${encodeURIComponent(cedula)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) {
    window.alert(result.error || 'No fue posible borrar el registro.');
    button.disabled = false;
    return;
  }
  await loadEmployees();
});

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
  body.innerHTML = '<tr><td colspan="6" class="empty-state">No fue posible cargar los empleados.</td></tr>';
});
