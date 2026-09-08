const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PDF_DIR = path.join(ROOT, 'pdfs');
const DB_FILE = path.join(DATA_DIR, 'reglamentos.sqlite');
const SOURCE_DATA_FILE = path.join(ROOT, 'data.js');
const ACCESS_TOKEN_FILE = path.join(DATA_DIR, '.qr-access-token');
const ADMIN_SIGNATURE_FILE = path.join(DATA_DIR, 'firma-alvaro.png');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PDF_DIR, { recursive: true });

const ACCESS_TOKEN = process.env.QR_ACCESS_TOKEN || (() => {
  if (fs.existsSync(ACCESS_TOKEN_FILE)) return fs.readFileSync(ACCESS_TOKEN_FILE, 'utf8').trim();
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(ACCESS_TOKEN_FILE, token, { encoding: 'utf8', flag: 'wx' });
  return token;
})();

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS empleados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cedula TEXT NOT NULL,
    nombre TEXT NOT NULL,
    cargo TEXT NOT NULL DEFAULT '',
    dependencia TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'PENDIENTE',
    fecha_firma TEXT,
    firma TEXT,
    pdf_path TEXT
  );
`);

const primaryKey = db.prepare('PRAGMA table_info(empleados)').all().find((column) => column.name === 'cedula');
if (primaryKey?.pk === 1) {
  db.exec(`
    ALTER TABLE empleados RENAME TO empleados_legacy;
    CREATE TABLE empleados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cedula TEXT NOT NULL,
      nombre TEXT NOT NULL,
      cargo TEXT NOT NULL DEFAULT '',
      dependencia TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT 'PENDIENTE',
      fecha_firma TEXT,
      firma TEXT,
      pdf_path TEXT
    );
    INSERT INTO empleados (cedula, nombre, cargo, dependencia, estado, fecha_firma, firma, pdf_path)
      SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma, firma, pdf_path FROM empleados_legacy;
    DROP TABLE empleados_legacy;
  `);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_empleados_cedula ON empleados (cedula)');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeEmployee(employee) {
  return {
    cedula: clean(employee.cedula) || (employee.esVacante ? `VACANTE-${employee.id}` : ''),
    nombre: clean(employee.nombre) || (employee.esVacante ? 'VACANTE' : ''),
    cargo: clean(employee.cargo),
    dependencia: clean(employee.dependencia ?? employee.area),
    estado: clean(employee.estado) || 'PENDIENTE',
  };
}

function sourceEmployees() {
  if (!fs.existsSync(SOURCE_DATA_FILE)) return [];
  const source = fs.readFileSync(SOURCE_DATA_FILE, 'utf8');
  const context = {};
  vm.runInNewContext(`${source}\n;globalThis.__employeesData = EMPLOYEES_DATA;`, context, {
    filename: SOURCE_DATA_FILE,
  });
  return Array.isArray(context.__employeesData) ? context.__employeesData : [];
}

function isPastoCentral(employee) {
  const dependency = clean(employee.dependencia).toUpperCase();
  const zone = clean(employee.zonaNombre).toUpperCase();
  return dependency.includes('PASTO ZONA CENTRAL')
    || zone === 'PASTO (ZONA 001)'
    || zone === 'PASTO ZONA CENTRAL';
}

function importEmployees(employees) {
  const find = db.prepare('SELECT id FROM empleados WHERE cedula = ? AND nombre = ?');
  const update = db.prepare('UPDATE empleados SET cargo = ?, dependencia = ? WHERE id = ?');
  const insert = db.prepare('INSERT INTO empleados (cedula, nombre, cargo, dependencia, estado) VALUES (@cedula, @nombre, @cargo, @dependencia, @estado)');
  const transaction = db.transaction((items) => {
    for (const employee of items) {
      const normalized = normalizeEmployee(employee);
      if (normalized.cedula && normalized.nombre) insert.run(normalized);
    }
  });
  transaction(employees.filter(isPastoCentral).filter((employee) => {
    const normalized = normalizeEmployee(employee);
    const existing = find.get(normalized.cedula, normalized.nombre);
    if (existing) {
      update.run(normalized.cargo, normalized.dependencia, existing.id);
      return false;
    }
    return true;
  }));
}

function seedFromDataJs() {
  importEmployees(sourceEmployees());
}

async function createPdf(employee, signatureDataUrl, adminSignature) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.16, 0.16, 0.16);
  const line = rgb(0.28, 0.28, 0.28);
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const year = String(today.getFullYear());
  const drawField = (label, value, x, y, width) => {
    page.drawText(label, { x, y, size: 11, font, color: ink });
    const labelWidth = font.widthOfTextAtSize(label, 11);
    page.drawLine({
      start: { x: x + labelWidth + 7, y: y - 2 },
      end: { x: x + width, y: y - 2 },
      thickness: 0.7,
      color: line,
    });
    page.drawText(value || '', { x: x + labelWidth + 12, y, size: 10.5, font, color: ink });
  };

  page.drawText('CENTRALES ELECTRICAS DE NARIÑO S.A. E.S.P', {
    x: 150, y: 770, size: 10.5, font: bold, color: ink,
  });
  page.drawText('ACUSE DE RECIBIDO DEL REGLAMENTO INTERNO DE TRABAJO', {
    x: 74, y: 720, size: 11, font: bold, color: ink,
  });

  drawField('Yo,', employee.nombre, 78, 680, 470);
  drawField('Identificado(a) con cédula de ciudadanía No.', employee.cedula, 78, 642, 470);
  drawField('Cargo:', employee.cargo, 78, 604, 310);
  drawField('Dependencia:', employee.dependencia, 78, 566, 360);

  page.drawText('declaro que en la fecha día', { x: 78, y: 510, size: 11, font, color: ink });
  page.drawLine({ start: { x: 232, y: 508 }, end: { x: 258, y: 508 }, thickness: 0.7, color: line });
  page.drawText(day, { x: 238, y: 511, size: 10.5, font, color: ink });
  page.drawText('mes', { x: 275, y: 510, size: 11, font, color: ink });
  page.drawLine({ start: { x: 303, y: 508 }, end: { x: 333, y: 508 }, thickness: 0.7, color: line });
  page.drawText(month, { x: 310, y: 511, size: 10.5, font, color: ink });
  page.drawText('año', { x: 350, y: 510, size: 11, font, color: ink });
  page.drawLine({ start: { x: 382, y: 508 }, end: { x: 425, y: 508 }, thickness: 0.7, color: line });
  page.drawText(year, { x: 387, y: 511, size: 10.5, font, color: ink });
  page.drawText(', he recibido un ejemplar físico del Reglamento Interno de Trabajo vigente, el cual contiene las normas,', {
    x: 78, y: 484, size: 11, font, color: ink,
  });
  page.drawText('obligaciones, derechos y procedimientos aplicables dentro de la organización.', {
    x: 78, y: 462, size: 11, font, color: ink,
  });
  page.drawText('Manifiesto que me comprometo a leerlo y cumplirlo en el desarrollo de mis funciones', {
    x: 78, y: 420, size: 11, font, color: ink,
  });
  page.drawText('laborales.', { x: 78, y: 398, size: 11, font, color: ink });

  const base64 = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
  const signature = await pdf.embedPng(Buffer.from(base64, 'base64'));
  page.drawText('Firma del trabajador:', { x: 78, y: 348, size: 11, font, color: ink });
  page.drawLine({ start: { x: 220, y: 346 }, end: { x: 365, y: 346 }, thickness: 0.7, color: line });
  page.drawImage(signature, { x: 220, y: 350, width: 140, height: 70 });
  drawField('Nombre completo:', employee.nombre, 78, 302, 360);
  page.drawText('Quien entrega:', { x: 78, y: 264, size: 11, font, color: ink });
  const adminSignatureImage = await pdf.embedPng(adminSignature);
  page.drawImage(adminSignatureImage, { x: 78, y: 196, width: 140, height: 58 });
  page.drawText('ALVARO JURADO NARVAEZ', { x: 78, y: 190, size: 10.5, font: bold, color: ink });
  page.drawText('Jefe División Administrativa ( E )', { x: 78, y: 174, size: 10.5, font, color: ink });
  page.drawText('Elaboró: Laura Bastidas E.', { x: 78, y: 125, size: 8.5, font, color: ink });

  return pdf.save();
}

function safeFileName(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function hasQrAccess(req) {
  const cookieToken = clean(req.headers.cookie?.match(/(?:^|;\s*)qr_access=([^;]+)/)?.[1]);
  return req.query.acceso === ACCESS_TOKEN || cookieToken === ACCESS_TOKEN;
}

function requireQrAccess(req, res, next) {
  if (!hasQrAccess(req)) {
    return res.status(403).send('Acceso denegado. Abre el formulario escaneando el código QR autorizado.');
  }
  if (req.query.acceso === ACCESS_TOKEN) {
    res.setHeader('Set-Cookie', `qr_access=${ACCESS_TOKEN}; HttpOnly; SameSite=Lax; Path=/`);
  }
  return next();
}

seedFromDataJs();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') return requireQrAccess(req, res, next);
  return next();
});
app.use(express.static(path.join(ROOT, 'public')));

app.get('/empleado/:cedula', requireQrAccess, (req, res) => {
  const employee = db.prepare(`
    SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma
    FROM empleados WHERE cedula = ?
  `).get(clean(req.params.cedula));
  if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });
  return res.json(employee);
});

app.get('/empleados', (req, res) => {
  const status = clean(req.query.estado).toUpperCase();
  const employees = status && ['PENDIENTE', 'FIRMADO'].includes(status)
    ? db.prepare('SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma, pdf_path FROM empleados WHERE estado = ? ORDER BY nombre').all(status)
    : db.prepare('SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma, pdf_path FROM empleados ORDER BY nombre').all();
  return res.json(employees);
});

app.post('/firmar', requireQrAccess, async (req, res) => {
  try {
    const cedula = clean(req.body.cedula);
    const firma = clean(req.body.firma);
    if (!cedula) return res.status(400).json({ error: 'La cedula es obligatoria' });
    if (!firma.startsWith('data:image/png;base64,')) return res.status(400).json({ error: 'La firma es obligatoria' });

    const employee = db.prepare('SELECT * FROM empleados WHERE cedula = ?').get(cedula);
    if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (employee.estado === 'FIRMADO') return res.status(409).json({ error: 'Este empleado ya firmó el documento' });
    if (!fs.existsSync(ADMIN_SIGNATURE_FILE)) {
      return res.status(409).json({ error: 'El formato aún no está listo: Álvaro debe registrar primero su firma.' });
    }

    const fecha = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
    const signedEmployee = { ...employee, fecha_firma: fecha };
    const pdfBytes = await createPdf(signedEmployee, firma, fs.readFileSync(ADMIN_SIGNATURE_FILE));
    const fileName = `${safeFileName(employee.cedula)}_${safeFileName(employee.nombre)}.pdf`;
    const relativePdf = path.join('pdfs', fileName);
    fs.writeFileSync(path.join(ROOT, relativePdf), pdfBytes);
    db.prepare(`UPDATE empleados SET estado = 'FIRMADO', fecha_firma = ?, firma = ?, pdf_path = ? WHERE cedula = ?`)
      .run(fecha, firma, relativePdf, cedula);
    return res.json({ message: 'Firma guardada correctamente', pdf: `/${relativePdf.replaceAll('\\', '/')}` });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No fue posible guardar la firma' });
  }
});

app.get('/admin/firma', (req, res) => {
  return res.json({ registrada: fs.existsSync(ADMIN_SIGNATURE_FILE) });
});

app.post('/admin/firma', (req, res) => {
  const firma = clean(req.body.firma);
  if (!firma.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'La firma de Álvaro es obligatoria' });
  }

  const base64 = firma.replace(/^data:image\/png;base64,/, '');
  try {
    fs.writeFileSync(ADMIN_SIGNATURE_FILE, Buffer.from(base64, 'base64'));
    return res.json({ message: 'Firma oficial guardada correctamente' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No fue posible guardar la firma oficial' });
  }
});

app.post('/admin/importar-csv', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo CSV' });
    const records = parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''), {
      columns: true, skip_empty_lines: true, bom: true, trim: true,
    });
    importEmployees(records);
    return res.json({ message: 'CSV importado correctamente', total: db.prepare('SELECT COUNT(*) AS count FROM empleados').get().count });
  } catch (error) {
    return res.status(400).json({ error: `CSV inválido: ${error.message}` });
  }
});

app.delete('/admin/empleados/:cedula', (req, res) => {
  const cedula = clean(req.params.cedula);
  const employee = db.prepare('SELECT pdf_path FROM empleados WHERE cedula = ?').get(cedula);
  if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });

  db.prepare('DELETE FROM empleados WHERE cedula = ?').run(cedula);
  if (employee.pdf_path) {
    const pdfPath = path.resolve(ROOT, employee.pdf_path);
    if (pdfPath.startsWith(`${PDF_DIR}${path.sep}`) && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  }
  return res.json({ message: 'Registro eliminado correctamente' });
});

app.patch('/admin/empleados/:cedula', (req, res) => {
  const cedula = clean(req.params.cedula);
  const nombre = clean(req.body.nombre);
  const cargo = clean(req.body.cargo);
  const dependencia = clean(req.body.dependencia);
  if (!nombre || !dependencia) return res.status(400).json({ error: 'Nombre y dependencia son obligatorios' });

  const result = db.prepare(`
    UPDATE empleados SET nombre = ?, cargo = ?, dependencia = ? WHERE cedula = ?
  `).run(nombre, cargo, dependencia, cedula);
  if (!result.changes) return res.status(404).json({ error: 'Empleado no encontrado' });
  return res.json({ message: 'Empleado actualizado correctamente' });
});

app.get('/admin/qr', async (req, res) => {
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const accessUrl = `${baseUrl}/?acceso=${encodeURIComponent(ACCESS_TOKEN)}`;
  res.type('png').send(await QRCode.toBuffer(accessUrl, { width: 720, margin: 2, color: { dark: '#092f54', light: '#ffffff' } }));
});

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.use('/pdfs', express.static(PDF_DIR));

app.listen(PORT, () => {
  console.log(`Sistema disponible en ${PUBLIC_URL}`);
  console.log(`Panel administrativo: ${PUBLIC_URL}/admin`);
});

module.exports = app;