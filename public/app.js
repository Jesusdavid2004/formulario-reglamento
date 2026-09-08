const form = document.querySelector('#signature-form');
const cedulaInput = document.querySelector('#cedula');
const details = document.querySelector('#employee-details');
const message = document.querySelector('#message');
const submitButton = document.querySelector('#submit-button');
const canvas = document.querySelector('#signature-canvas');
const consentInput = document.querySelector('#data-consent');
const signaturePad = new SignaturePad(canvas, { minWidth: 0.8, maxWidth: 2.4, penColor: '#092f54' });
let currentEmployee = null;
let lookupTimer;

async function protectedFetch(url, options) {
  return fetch(url, { ...options, credentials: 'same-origin' });
}

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`;
}

function resizeCanvas() {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const width = canvas.offsetWidth;
  const height = 220;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.getContext('2d').scale(ratio, ratio);
  signaturePad.clear();
}

function resetEmployee() {
  currentEmployee = null;
  details.hidden = true;
  submitButton.disabled = true;
  ['nombre', 'cargo', 'dependencia', 'fecha'].forEach((id) => {
    document.querySelector(`#${id}`).textContent = '-';
  });
}

function showEmployee(employee) {
  currentEmployee = employee;
  details.hidden = false;
  document.querySelector('#nombre').textContent = employee.nombre;
  document.querySelector('#cargo').textContent = employee.cargo || '-';
  document.querySelector('#dependencia').textContent = employee.dependencia || '-';
  document.querySelector('#fecha').textContent = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long' }).format(new Date());
  submitButton.disabled = employee.estado === 'FIRMADO' || !consentInput.checked;
  if (employee.estado === 'FIRMADO') setMessage('Este empleado ya tiene una firma registrada.', 'warning');
  else setMessage('Datos encontrados. Ahora puedes firmar.', 'success');
}

consentInput.addEventListener('change', () => {
  submitButton.disabled = !currentEmployee || currentEmployee.estado === 'FIRMADO' || !consentInput.checked;
});

async function lookupEmployee() {
  const cedula = cedulaInput.value.trim();
  resetEmployee();
  if (!cedula) return;
  try {
    const response = await protectedFetch(`/empleado/${encodeURIComponent(cedula)}`);
    if (!response.ok) throw new Error('Empleado no encontrado');
    showEmployee(await response.json());
  } catch (error) {
    setMessage('Empleado no encontrado. Revisa la cédula e inténtalo de nuevo.', 'error');
  }
}

cedulaInput.addEventListener('input', () => {
  window.clearTimeout(lookupTimer);
  lookupTimer = window.setTimeout(lookupEmployee, 350);
});

document.querySelector('#clear-signature').addEventListener('click', () => signaturePad.clear());
window.addEventListener('resize', resizeCanvas);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentEmployee) return setMessage('Primero consulta una cédula válida.', 'error');
  if (signaturePad.isEmpty()) return setMessage('Debes registrar tu firma antes de continuar.', 'error');
  if (!consentInput.checked) return setMessage('Debes leer y aceptar la autorización de datos personales.', 'error');

  submitButton.disabled = true;
  submitButton.textContent = 'Guardando...';
  try {
    const response = await protectedFetch('/firmar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cedula: cedulaInput.value.trim(), firma: signaturePad.toDataURL('image/png'), autorizacion: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No fue posible guardar la firma');
    setMessage('Firma registrada correctamente. Descarga tu recibo en PDF.', 'success');
    const link = document.createElement('a');
    link.href = result.pdf;
    link.textContent = 'Descargar constancia PDF';
    link.className = 'download-link';
    message.appendChild(document.createElement('br'));
    message.appendChild(link);
    signaturePad.clear();
  } catch (error) {
    setMessage(error.message, 'error');
    submitButton.disabled = false;
  } finally {
    submitButton.textContent = 'Guardar firma';
  }
});

requestAnimationFrame(resizeCanvas);
