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
const JSZip = require('jszip');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ROOT = __dirname;
const PERSIST_DIR = process.env.PERSIST_DIR || ROOT;
const DATA_DIR = path.join(PERSIST_DIR, 'data');
const PDF_DIR = path.join(PERSIST_DIR, 'pdfs');
const DB_FILE = path.join(DATA_DIR, 'reglamentos.sqlite');
const SOURCE_DATA_FILE = path.join(ROOT, 'data.js');
const ACCESS_TOKEN_FILE = path.join(DATA_DIR, '.qr-access-token');
const OFFICIAL_TEMPLATE_FILE = path.join(ROOT, 'entrega de reglamento firmado 2.docx');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'jesusdavid.villotaa@gmail.com';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH
  || 'bff6d7976d27b1d029325d81278a661786a0f28857a844a562862d54f0db6738';
const ADMIN_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const SUPABASE_URL = clean(process.env.SUPABASE_URL);
const SUPABASE_SERVICE_ROLE_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

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
db.pragma('synchronous = FULL');
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
    autorizacion_datos INTEGER NOT NULL DEFAULT 0,
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
      autorizacion_datos INTEGER NOT NULL DEFAULT 0,
      pdf_path TEXT
    );
    INSERT INTO empleados (cedula, nombre, cargo, dependencia, estado, fecha_firma, firma, pdf_path)
      SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma, firma, pdf_path FROM empleados_legacy;
    DROP TABLE empleados_legacy;
  `);
}
try {
  db.exec('ALTER TABLE empleados ADD COLUMN autorizacion_datos INTEGER NOT NULL DEFAULT 0');
} catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
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

function assertSupabase(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function getEmployee(cedula) {
  if (!supabase) return db.prepare('SELECT * FROM empleados WHERE cedula = ?').get(cedula);
  return assertSupabase(await supabase.from('empleados').select('*').eq('cedula', cedula).maybeSingle());
}

async function getEmployees(status = '') {
  if (!supabase) {
    return status
      ? db.prepare('SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma, pdf_path FROM empleados WHERE estado = ? ORDER BY nombre').all(status)
      : db.prepare('SELECT cedula, nombre, cargo, dependencia, estado, fecha_firma, pdf_path FROM empleados ORDER BY nombre').all();
  }
  let query = supabase.from('empleados').select('cedula,nombre,cargo,dependencia,estado,fecha_firma,pdf_path').order('nombre');
  if (status) query = query.eq('estado', status);
  return assertSupabase(await query);
}

async function saveEmployee(employee) {
  if (!supabase) return db.prepare('INSERT INTO empleados (cedula, nombre, cargo, dependencia, estado) VALUES (@cedula, @nombre, @cargo, @dependencia, @estado)').run(employee);
  return assertSupabase(await supabase.from('empleados').upsert(employee, { onConflict: 'cedula', ignoreDuplicates: false }).select().single());
}

async function seedEmployees(employees) {
  const filtered = employees.filter(isPastoCentral).map(normalizeEmployee).filter((employee) => employee.cedula && employee.nombre);
  if (!supabase) return importEmployees(employees);
  for (const employee of filtered) {
    const existing = await getEmployee(employee.cedula);
    if (existing) {
      assertSupabase(await supabase.from('empleados').update({ cargo: employee.cargo, dependencia: employee.dependencia }).eq('id', existing.id));
    } else {
      await saveEmployee(employee);
    }
  }
}

async function updateSignedEmployee(cedula, fecha, firma, pdfPath) {
  if (!supabase) return db.prepare(`UPDATE empleados SET estado = 'FIRMADO', fecha_firma = ?, firma = ?, autorizacion_datos = 1, pdf_path = ? WHERE cedula = ?`).run(fecha, firma, pdfPath, cedula);
  return assertSupabase(await supabase.from('empleados').update({ estado: 'FIRMADO', fecha_firma: fecha, firma, autorizacion_datos: true, pdf_path: pdfPath }).eq('cedula', cedula));
}

async function uploadPdf(pdfPath, bytes) {
  if (!supabase) {
    fs.writeFileSync(path.join(PDF_DIR, path.basename(pdfPath)), bytes);
    return;
  }
  assertSupabase(await supabase.storage.from('reglamentos-pdfs').upload(pdfPath, bytes, { contentType: 'application/pdf', upsert: true }));
}

async function downloadPdf(pdfPath) {
  if (!supabase) return fs.readFileSync(path.join(PDF_DIR, path.basename(pdfPath)));
  const result = await supabase.storage.from('reglamentos-pdfs').download(pdfPath);
  if (result.error) throw result.error;
  return Buffer.from(await result.data.arrayBuffer());
}

async function removePdf(pdfPath) {
  if (!pdfPath) return;
  if (!supabase) {
    const localPath = path.join(PDF_DIR, path.basename(pdfPath));
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    return;
  }
  assertSupabase(await supabase.storage.from('reglamentos-pdfs').remove([pdfPath]));
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
  return seedEmployees(sourceEmployees());
}

async function createPdf(employee, signatureDataUrl, adminSignature) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.16, 0.16, 0.16);
  const today = new Date();
  const day = String(today.getDate()).padStart(2, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const year = String(today.getFullYear());
  const drawCentered = (text, y, size, selectedFont = font) => {
    const width = selectedFont.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (612 - width) / 2, y, size, font: selectedFont, color: ink });
  };
  const drawLine = (text, x, y, size = 11, selectedFont = font) => {
    page.drawText(text, { x, y, size, font: selectedFont, color: ink });
  };
  const drawParagraph = (lines, y) => {
    lines.forEach((text, index) => drawLine(text, 85, y - index * 17));
  };
  const drawInlineField = (label, value, y, valueStart, valueEnd) => {
    drawLine(label, 85, y);
    drawLine('_'.repeat(Math.max(1, Math.round((valueEnd - valueStart) / 5.2))), valueStart, y - 5);
    drawLine(value || '', valueStart + 4, y, 10.5);
  };

  drawCentered('CENTRALES ELECTRICAS DE', 735, 11, bold);
  drawCentered('NARIÑO S.A.  E.S.P', 718, 11, bold);
  drawCentered('ACUSE DE RECIBIDO DEL REGLAMENTO INTERNO DE TRABAJO', 678, 11, bold);
  drawInlineField('Yo,', employee.nombre, 635, 125, 535);
  drawInlineField('Identificado(a) con cédula de ciudadanía No.', employee.cedula, 585, 390, 490);
  drawInlineField('Cargo:', employee.cargo, 553, 125, 380);
  drawInlineField('Dependencia', employee.dependencia, 521, 155, 440);
  drawParagraph([`declaro que en la fecha día ${day}   mes ${month}   año ${year}  , he recibido un ejemplar`, 'físico del Reglamento Interno de Trabajo vigente, el cual contiene las normas,', 'obligaciones, derechos y procedimientos aplicables dentro de la organización.'], 480);
  drawParagraph(['Manifiesto que me comprometo a leerlo y cumplirlo en el desarrollo de mis funciones', 'laborales.'], 423);

  const base64 = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
  const signature = await pdf.embedPng(Buffer.from(base64, 'base64'));
  drawLine('Firma del trabajador:         __________________', 85, 367);
  page.drawImage(signature, { x: 230, y: 369, width: 140, height: 62 });
  drawLine(' Nombre completo:            ___________________', 85, 327);
  drawLine(employee.nombre || '', 265, 330, 10.5);
  drawParagraph([
    'Acuse de recibo para validar y organizar la información del Reglamento Interno.',
    'Asimismo, conozco que, como titular, me asisten los derechos a conocer, actualizar,',
    'rectificar y suprimir mis datos personales, así como revocar la presente autorización.',
  ], 285);
  drawLine('Quien entrega:', 85, 225);
  const adminSignatureImage = await pdf.embedPng(adminSignature);
  page.drawImage(adminSignatureImage, { x: 85, y: 155, width: 140, height: 58 });
  drawLine('ALVARO JURADO NARVAEZ', 85, 144, 10.5, bold);
  drawLine('Jefe División Administrativa ( E )', 85, 128, 10.5);
  drawLine('Elaboró:     Laura Bastidas E.', 85, 84, 8.5);

  return pdf.save();
}

async function createSignedDocx() {
  const templatePath = OFFICIAL_TEMPLATE_FILE;
  const template = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const documentEntry = template.file('word/document.xml');
  const relationshipsEntry = template.file('word/_rels/document.xml.rels');
  const contentTypesEntry = template.file('[Content_Types].xml');
  if (!documentEntry || !relationshipsEntry || !contentTypesEntry) throw new Error('Formato Word incompleto');

  const documentXml = await documentEntry.async('string');
  const relationshipsXml = await relationshipsEntry.async('string');
  const contentTypesXml = await contentTypesEntry.async('string');
  const imageRelationshipId = 'rIdFirmaAlvaro';
  const signatureParagraph = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="0" w:lineRule="exact"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2194560" cy="731520"/><wp:docPr id="99" name="Firma de Alvaro Jurado Narvaez"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="firma-alvaro.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${imageRelationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2194560" cy="731520"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const beforeSignerName = /(<w:p\b[^>]*>[\s\S]*?Quien entrega:[\s\S]*?<\/w:p>)([\s\S]*?)(<w:p\b[^>]*>[\s\S]*?ALVARO JURADO NARVAEZ[\s\S]*?<\/w:p>)/;
  const documentWithNamespaces = documentXml.replace(
    '<w:document ',
    '<w:document xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ',
  );
  const updatedDocumentXml = documentWithNamespaces.replace(beforeSignerName, `$1$2${signatureParagraph}$3`);
  if (!beforeSignerName.test(documentXml)) throw new Error('No se encontró el espacio de firma en el Word');

  const updatedRelationshipsXml = relationshipsXml.replace('</Relationships>', `<Relationship Id="${imageRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/firma-alvaro.png"/></Relationships>`);
  const updatedContentTypesXml = contentTypesXml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
  template.file('word/document.xml', updatedDocumentXml);
  template.file('word/_rels/document.xml.rels', updatedRelationshipsXml);
  template.file('[Content_Types].xml', updatedContentTypesXml);
  template.file('word/media/firma-alvaro.png', await template.file('word/media/image1.png').async('nodebuffer'));
  return template.generateAsync({ type: 'nodebuffer' });
}

function safeFileName(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function hasQrAccess(req) {
  const cookieToken = clean(req.headers.cookie?.match(/(?:^|;\s*)qr_access=([^;]+)/)?.[1]);
  return req.query.acceso === ACCESS_TOKEN || cookieToken === ACCESS_TOKEN;
}

function hasAdminAccess(req) {
  const cookieToken = clean(req.headers.cookie?.match(/(?:^|;\s*)admin_access=([^;]+)/)?.[1]);
  return cookieToken === ADMIN_SESSION_TOKEN;
}

function requireAdminAccess(req, res, next) {
  if (hasAdminAccess(req)) return next();
  if (req.method === 'GET' && req.path === '/admin') return res.redirect('/admin-login.html');
  return res.status(401).json({ error: 'Debes iniciar sesión como administrador.' });
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

seedFromDataJs().catch((error) => console.error('No fue posible cargar empleados:', error));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') return requireQrAccess(req, res, next);
  return next();
});
app.use(express.static(path.join(ROOT, 'public')));

app.get('/empleado/:cedula', requireQrAccess, async (req, res) => {
  const employee = await getEmployee(clean(req.params.cedula));
  if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });
  return res.json(employee);
});

app.get('/empleados', requireAdminAccess, async (req, res) => {
  const status = clean(req.query.estado).toUpperCase();
  const employees = status && ['PENDIENTE', 'FIRMADO'].includes(status) ? await getEmployees(status) : await getEmployees();
  return res.json(employees);
});

app.post('/firmar', requireQrAccess, async (req, res) => {
  try {
    const cedula = clean(req.body.cedula);
    const firma = clean(req.body.firma);
    const autorizacion = req.body.autorizacion === true;
    if (!cedula) return res.status(400).json({ error: 'La cedula es obligatoria' });
    if (!firma.startsWith('data:image/png;base64,')) return res.status(400).json({ error: 'La firma es obligatoria' });
    if (!autorizacion) return res.status(400).json({ error: 'Debes leer y aceptar la autorización de datos personales.' });

    const employee = await getEmployee(cedula);
    if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });
    if (employee.estado === 'FIRMADO') return res.status(409).json({ error: 'Este empleado ya firmó el documento' });

    const fecha = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
    const signedEmployee = { ...employee, fecha_firma: fecha };
    const officialTemplate = await JSZip.loadAsync(fs.readFileSync(OFFICIAL_TEMPLATE_FILE));
    const adminSignature = await officialTemplate.file('word/media/image1.png').async('nodebuffer');
    const pdfBytes = await createPdf(signedEmployee, firma, adminSignature);
    const fileName = `${safeFileName(employee.cedula)}_${safeFileName(employee.nombre)}.pdf`;
    const relativePdf = path.join('pdfs', fileName);
    await uploadPdf(relativePdf, pdfBytes);
    await updateSignedEmployee(cedula, fecha, firma, relativePdf);
    return res.json({ message: 'Firma guardada correctamente', pdf: `/${relativePdf.replaceAll('\\', '/')}` });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'No fue posible guardar la firma' });
  }
});

app.post('/admin/login', (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const passwordHash = crypto.createHash('sha256').update(String(req.body.password ?? '')).digest('hex');
  if (email !== ADMIN_EMAIL.toLowerCase() || passwordHash !== ADMIN_PASSWORD_HASH) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  res.setHeader('Set-Cookie', `admin_access=${ADMIN_SESSION_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  return res.json({ message: 'Sesión iniciada' });
});

app.get('/admin/formato', requireAdminAccess, async (req, res) => {
  try {
    const fileName = 'entrega de reglamento firmado 2.docx';
    const file = fs.readFileSync(OFFICIAL_TEMPLATE_FILE);
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(file);
  } catch (error) {
    console.error(error);
    return res.status(500).send('No fue posible preparar el Word firmado.');
  }
});

app.post('/admin/importar-csv', requireAdminAccess, upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo CSV' });
    const records = parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''), {
      columns: true, skip_empty_lines: true, bom: true, trim: true,
    });
    await seedEmployees(records);
    const total = supabase ? (await supabase.from('empleados').select('*', { count: 'exact', head: true })).count : db.prepare('SELECT COUNT(*) AS count FROM empleados').get().count;
    return res.json({ message: 'CSV importado correctamente', total });
  } catch (error) {
    return res.status(400).json({ error: `CSV inválido: ${error.message}` });
  }
});

function csvValue(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

app.get('/admin/descargar-firmados', requireAdminAccess, async (req, res) => {
  try {
    const signedEmployees = await getEmployees('FIRMADO');
    const archive = new JSZip();
    const report = [['cedula', 'nombre', 'cargo', 'dependencia', 'fecha_firma', 'pdf', 'archivo_encontrado']];

    for (const employee of signedEmployees) {
      const pdfName = employee.pdf_path ? path.basename(employee.pdf_path) : '';
      const pdfPath = employee.pdf_path ? path.resolve(PERSIST_DIR, employee.pdf_path) : '';
      let pdfBytes;
      let exists = false;
      try {
        if (employee.pdf_path) pdfBytes = await downloadPdf(employee.pdf_path);
        exists = Boolean(pdfBytes);
      } catch (error) {
        console.error(`No se pudo leer el PDF de ${employee.cedula}:`, error.message);
      }
      if (exists) archive.file(`pdfs/${pdfName}`, pdfBytes);
      report.push([
        employee.cedula,
        employee.nombre,
        employee.cargo,
        employee.dependencia,
        employee.fecha_firma,
        pdfName,
        exists ? 'SI' : 'NO',
      ]);
    }

    archive.file('firmados.csv', `\uFEFF${report.map((row) => row.map(csvValue).join(',')).join('\r\n')}`);
    const archiveBytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.type('application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="reglamentos-firmados.zip"');
    return res.send(archiveBytes);
  } catch (error) {
    console.error(error);
    return res.status(500).send('No fue posible preparar el respaldo de documentos firmados.');
  }
});

app.delete('/admin/empleados/:cedula', requireAdminAccess, async (req, res) => {
  const cedula = clean(req.params.cedula);
  const employee = await getEmployee(cedula);
  if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });

  if (supabase) assertSupabase(await supabase.from('empleados').delete().eq('cedula', cedula));
  else db.prepare('DELETE FROM empleados WHERE cedula = ?').run(cedula);
  await removePdf(employee.pdf_path);
  return res.json({ message: 'Registro eliminado correctamente' });
});

app.patch('/admin/empleados/:cedula', requireAdminAccess, async (req, res) => {
  const cedula = clean(req.params.cedula);
  const nombre = clean(req.body.nombre);
  const cargo = clean(req.body.cargo);
  const dependencia = clean(req.body.dependencia);
  if (!nombre || !dependencia) return res.status(400).json({ error: 'Nombre y dependencia son obligatorios' });

  const result = supabase
    ? assertSupabase(await supabase.from('empleados').update({ nombre, cargo, dependencia }).eq('cedula', cedula).select('id'))
    : db.prepare('UPDATE empleados SET nombre = ?, cargo = ?, dependencia = ? WHERE cedula = ?').run(nombre, cargo, dependencia, cedula);
  if (supabase ? !result.length : !result.changes) return res.status(404).json({ error: 'Empleado no encontrado' });
  return res.json({ message: 'Empleado actualizado correctamente' });
});

app.get('/admin/qr', requireAdminAccess, async (req, res) => {
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const accessUrl = `${baseUrl}/?acceso=${encodeURIComponent(ACCESS_TOKEN)}`;
  res.type('png').send(await QRCode.toBuffer(accessUrl, { width: 720, margin: 2, color: { dark: '#092f54', light: '#ffffff' } }));
});

app.get('/admin', requireAdminAccess, (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/admin/pdf', requireAdminAccess, async (req, res) => {
  const pdfPath = clean(req.query.path);
  if (!pdfPath.startsWith('pdfs/')) return res.status(400).send('Ruta inválida.');
  try {
    const bytes = await downloadPdf(pdfPath);
    res.type('application/pdf').send(bytes);
  } catch (error) {
    return res.status(404).send('PDF no encontrado.');
  }
});
app.use('/pdfs', express.static(PDF_DIR));

app.listen(PORT, () => {
  console.log(`Sistema disponible en ${PUBLIC_URL}`);
  console.log(`Panel administrativo: ${PUBLIC_URL}/admin`);
});

module.exports = app;