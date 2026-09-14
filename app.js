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
const XLSX = require('xlsx');
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

function normalizeImportRecord(record) {
  const fields = Object.fromEntries(Object.entries(record).map(([key, value]) => [
    clean(key).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    value,
  ]));
  return {
    cedula: fields.CEDULA,
    nombre: fields.NOMBRE,
    cargo: fields.CARGO,
    dependencia: fields.DEPENDENCIA ?? fields.AREA,
    estado: fields.ESTADO,
  };
}

function parseImportBuffer(buffer, fileName) {
  const extension = path.extname(fileName || '').toLowerCase();
  if (extension === '.xlsx' || extension === '.xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(firstSheet, { defval: '' }).map(normalizeImportRecord);
  }

  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.includes(';') ? ';' : ',';
  return parse(text, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }).map(normalizeImportRecord);
}

function parseImportFile(file) {
  return parseImportBuffer(file.buffer, file.originalname);
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

const MANUAL_PDF_MAPPINGS = {
  'Diana sinister.pdf': '1087128951',
  'Fabio Enrique.pdf': '10546314',
  'Franklin Quiñónes.pdf': '98428203',
  'Jaime Rosero.pdf': '12919399',
  'Jaon Ivoin.pdf': '12919399',
  'Santiago Molinenos.pdf': '12916615',
  'Segundo Obiedo.pdf': '98427879',
  'Segundo herney .pdf': '98427879',
  'Marcela Pérez .pdf': '36952144',
  'Paola Sandoval.pdf': '36755487',
  'Elsa Paola Zambrano .pdf': '59677129',
  'Benítez Angulo.pdf': '12911689',
  'Alicia Gonzales.pdf': '59671131',
  'Ginna Estefanía chamorro.pdf': '1128279375',
  'Francisco Leonardo Valencia.pdf': '87943538',
  'Brayan guisamano Dajome.pdf': '98429682',
  'Daiwer servillo Araujo.pdf': '87942121',
  'Darío segura.pdf': '12917785',
  'Eliana Jimena Portilla.pdf': '1086107154',
  'Elmer giovanni dajone.pdf': '98429682',
  'Flavio Jhonny castillo.pdf': '12918861',
  'Hamerley Medina.pdf': '1107072467',
  'Harold Antonio Salcedo.pdf': '12914997',
  'Heider castillo.pdf': '87942491',
  'Javier Molina.pdf': '12911930',
  'Jimena Gaviria Mesa.pdf': '38643369',
  'Jorge Andrés Cifuentes Marquez.pdf': '1087778081',
  'Julio César Díaz Benavides .pdf': '98429180',
  'Lobeth carolina cumbal .pdf': '1004539268',
  'Manuel alexander coaji Muñoz .pdf': '87070249',
  'Mario walter siluz.pdf': '12919192',
  'Oscar Armando Benitez.pdf': '12911689',
  'Pacho angulo.pdf': '87943538',
  'Pedro Manuel Ruiz.pdf': '16628398',
  'Sandra Liliana López.pdf': '1085262261',
  'Leder Andrés Quiñones.pdf': '94439253'
};

function normalizeTextMatch(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getLocalPdfMappings(allEmployees) {
  const map = new Map();
  if (!fs.existsSync(PDF_DIR)) return map;
  const pdfFiles = fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

  pdfFiles.forEach((pdf) => {
    if (MANUAL_PDF_MAPPINGS[pdf]) {
      map.set(MANUAL_PDF_MAPPINGS[pdf], path.join('pdfs', pdf).replace(/\\/g, '/'));
      return;
    }
    const m = pdf.match(/^(\d+)_/);
    if (m) {
      map.set(m[1], path.join('pdfs', pdf).replace(/\\/g, '/'));
      return;
    }
    const pdfName = normalizeTextMatch(path.parse(pdf).name);
    const words = pdfName.split(' ').filter((w) => w.length > 2);
    let best = null;
    let bestScore = 0;
    allEmployees.forEach((e) => {
      if (!e.cedula) return;
      const eNorm = normalizeTextMatch(e.nombre);
      if (eNorm.includes(pdfName)) {
        best = e;
        bestScore = 1.0;
        return;
      }
      const matches = words.filter((w) => eNorm.includes(w));
      const score = matches.length / Math.max(words.length, 1);
      if (score > bestScore && (matches.length >= 2 || (words.length === 1 && matches.length === 1))) {
        bestScore = score;
        best = e;
      }
    });
    if (best && bestScore >= 0.5) {
      map.set(String(best.cedula).trim(), path.join('pdfs', pdf).replace(/\\/g, '/'));
    }
  });
  return map;
}

async function seedEmployees(employees) {
  const filtered = employees.map(normalizeEmployee).filter((employee) => employee.cedula && employee.nombre && !employee.cedula.startsWith('VACANTE-'));
  const pdfMap = getLocalPdfMappings(filtered);

  if (!supabase) return importEmployees(employees, pdfMap);
  for (const employee of filtered) {
    const existing = await getEmployee(employee.cedula);
    const mappedPdf = pdfMap.get(employee.cedula);
    if (existing) {
      const updates = { cargo: employee.cargo, dependencia: employee.dependencia };
      if (existing.estado !== 'FIRMADO' && mappedPdf) {
        updates.estado = 'FIRMADO';
        updates.pdf_path = mappedPdf;
        updates.fecha_firma = existing.fecha_firma || 'FIRMADO PREVIO';
      }
      assertSupabase(await supabase.from('empleados').update(updates).eq('id', existing.id));
    } else {
      const newEmp = { ...employee };
      if (mappedPdf) {
        newEmp.estado = 'FIRMADO';
        newEmp.pdf_path = mappedPdf;
        newEmp.fecha_firma = 'FIRMADO PREVIO';
      }
      await saveEmployee(newEmp);
    }
  }
}

function importEmployees(employees, pdfMap = new Map()) {
  const find = db.prepare('SELECT id, estado, fecha_firma, pdf_path FROM empleados WHERE cedula = ?');
  const updateInfo = db.prepare('UPDATE empleados SET cargo = ?, dependencia = ? WHERE id = ?');
  const updateSigned = db.prepare('UPDATE empleados SET cargo = ?, dependencia = ?, estado = ?, pdf_path = ?, fecha_firma = COALESCE(fecha_firma, ?) WHERE id = ?');
  const insert = db.prepare('INSERT INTO empleados (cedula, nombre, cargo, dependencia, estado, pdf_path, fecha_firma) VALUES (@cedula, @nombre, @cargo, @dependencia, @estado, @pdf_path, @fecha_firma)');
  const transaction = db.transaction((items) => {
    for (const employee of items) {
      const normalized = normalizeEmployee(employee);
      if (!normalized.cedula || !normalized.nombre || normalized.cedula.startsWith('VACANTE-')) continue;
      const existing = find.get(normalized.cedula);
      const mappedPdf = pdfMap.get(normalized.cedula);

      if (existing) {
        if (existing.estado !== 'FIRMADO' && mappedPdf) {
          updateSigned.run(normalized.cargo, normalized.dependencia, 'FIRMADO', mappedPdf, 'FIRMADO PREVIO', existing.id);
        } else {
          updateInfo.run(normalized.cargo, normalized.dependencia, existing.id);
        }
      } else {
        const toInsert = {
          ...normalized,
          pdf_path: mappedPdf || null,
          estado: mappedPdf ? 'FIRMADO' : (normalized.estado || 'PENDIENTE'),
          fecha_firma: mappedPdf ? 'FIRMADO PREVIO' : null,
        };
        insert.run(toInsert);
      }
    }
  });
  transaction(employees);
}

async function seedFromDataJs() {
  await seedEmployees(sourceEmployees());
  const sourceCsvFile = path.join(ROOT, 'planta_personal_termino_indefinido_y_fijo.csv');
  if (fs.existsSync(sourceCsvFile)) {
    const csvEmployees = parseImportBuffer(fs.readFileSync(sourceCsvFile), sourceCsvFile);
    await seedEmployees(csvEmployees);
  }
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

let dataLoadError = null;
const dataReady = seedFromDataJs().catch((error) => {
  dataLoadError = error;
  console.error('No fue posible cargar empleados:', error);
  return false;
});
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') return requireQrAccess(req, res, next);
  return next();
});
app.use(express.static(path.join(ROOT, 'public')));

app.get('/empleado/:cedula', requireQrAccess, async (req, res) => {
  await dataReady;
  const employee = await getEmployee(clean(req.params.cedula));
  if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });
  return res.json(employee);
});

app.get('/empleados', requireAdminAccess, async (req, res) => {
  try {
    await dataReady;
    if (dataLoadError) return res.status(503).json({ error: 'Supabase no permite leer la tabla de empleados. Revisa los permisos de la tabla.' });
    const status = clean(req.query.estado).toUpperCase();
    const employees = status && ['PENDIENTE', 'FIRMADO'].includes(status) ? await getEmployees(status) : await getEmployees();
    return res.json(employees);
  } catch (error) {
    console.error('No fue posible consultar empleados:', error);
    return res.status(503).json({ error: 'No fue posible conectar con el almacenamiento de empleados.' });
  }
});

app.post('/firmar', requireQrAccess, async (req, res) => {
  try {
    await dataReady;
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
    await dataReady;
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo CSV' });
    const records = parseImportFile(req.file);
    if (!records.some((record) => clean(record.cedula) && clean(record.nombre))) {
      return res.status(400).json({ error: 'No se encontraron trabajadores válidos en el archivo.' });
    }
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

app.post('/admin/marcar-firmado/:cedula', requireAdminAccess, upload.single('pdf'), async (req, res) => {
  try {
    const cedula = clean(req.params.cedula);
    const employee = await getEmployee(cedula);
    if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });

    let relativePdf = employee.pdf_path || '';
    if (req.file && req.file.buffer) {
      const isPdf = req.file.mimetype === 'application/pdf'
        || path.extname(req.file.originalname || '').toLowerCase() === '.pdf';
      if (!isPdf) return res.status(400).json({ error: 'El archivo debe ser un PDF.' });
      const fileName = `${safeFileName(employee.cedula)}_${safeFileName(employee.nombre)}.pdf`;
      relativePdf = path.join('pdfs', fileName).replace(/\\/g, '/');
      await uploadPdf(relativePdf, req.file.buffer);
    }

    const fecha = new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' });
    if (!supabase) {
      db.prepare(`UPDATE empleados SET estado = 'FIRMADO', fecha_firma = COALESCE(fecha_firma, ?), pdf_path = COALESCE(?, pdf_path) WHERE cedula = ?`).run(fecha, relativePdf || null, cedula);
    } else {
      assertSupabase(await supabase.from('empleados').update({
        estado: 'FIRMADO',
        fecha_firma: employee.fecha_firma || fecha,
        pdf_path: relativePdf || employee.pdf_path || null,
      }).eq('cedula', cedula));
    }
    return res.json({ message: 'Empleado marcado como firmado correctamente', pdf_path: relativePdf });
  } catch (error) {
    console.error('Error al marcar como firmado:', error);
    return res.status(500).json({ error: 'No fue posible marcar como firmado el empleado.' });
  }
});

app.post('/admin/crear-empleado', requireAdminAccess, async (req, res) => {
  try {
    const cedula = clean(req.body.cedula);
    const nombre = clean(req.body.nombre);
    const cargo = clean(req.body.cargo);
    const dependencia = clean(req.body.dependencia);
    if (!cedula || !nombre || !dependencia) {
      return res.status(400).json({ error: 'Cédula, nombre y dependencia son obligatorios.' });
    }
    const existing = await getEmployee(cedula);
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un empleado con esa cédula.' });
    }
    const newEmp = {
      cedula,
      nombre,
      cargo,
      dependencia,
      estado: 'PENDIENTE',
    };
    await saveEmployee(newEmp);
    return res.json({ message: 'Empleado agregado correctamente' });
  } catch (error) {
    console.error('Error al crear empleado:', error);
    return res.status(500).json({ error: 'No fue posible crear el empleado.' });
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