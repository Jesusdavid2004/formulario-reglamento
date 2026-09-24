const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'data', 'reglamentos.sqlite');
const PDF_DIR = path.join(__dirname, 'pdfs');
const DATA_FILE = path.join(__dirname, 'data.js');

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
  'Pedro Manuel Ruiz.pdf': '16628398',
  'Sandra Liliana López.pdf': '1085262261',
  'Leder Andrés Quiñones.pdf': '94439253'
};

function normalizeTextMatch(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

if (!fs.existsSync(DB_FILE)) {
  console.error('No se encontró la base de datos.');
  process.exit(1);
}

const db = new Database(DB_FILE);

const allEmployees = db.prepare('SELECT id, cedula, nombre FROM empleados').all();
const findEmployee = db.prepare('SELECT id, estado, fecha_firma, pdf_path FROM empleados WHERE cedula = ?');
const updateSigned = db.prepare(`UPDATE empleados SET estado = 'FIRMADO', fecha_firma = COALESCE(fecha_firma, ?), pdf_path = ?, autorizacion_datos = 1 WHERE cedula = ?`);
const insertEmployee = db.prepare(`INSERT INTO empleados (cedula, nombre, cargo, dependencia, estado, fecha_firma, autorizacion_datos, pdf_path) VALUES (?, ?, 'EMPLEADO', 'CEDENAR', 'FIRMADO', 'FIRMADO PREVIO', 1, ?)`);

const pdfFiles = fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
let nuevosVinculados = 0;
let yaVinculados = 0;
let sinCoincidencia = 0;

const transaction = db.transaction(() => {
  for (const file of pdfFiles) {
    const relativePath = path.join('pdfs', file).replace(/\\/g, '/');
    let cedula = '';

    const m = file.match(/^(\d+)_/);
    if (m) {
      cedula = m[1];
    } else if (MANUAL_PDF_MAPPINGS[file]) {
      cedula = MANUAL_PDF_MAPPINGS[file];
    } else {
      const pdfName = normalizeTextMatch(path.parse(file).name);
      const words = pdfName.split(' ').filter((w) => w.length > 2);
      let best = null;
      let bestScore = 0;
      for (const emp of allEmployees) {
        if (!emp.cedula) continue;
        const eNorm = normalizeTextMatch(emp.nombre);
        if (eNorm.includes(pdfName)) {
          best = emp;
          bestScore = 1.0;
          break;
        }
        const matches = words.filter((w) => eNorm.includes(w));
        const score = matches.length / Math.max(words.length, 1);
        if (score > bestScore && (matches.length >= 2 || (words.length === 1 && matches.length === 1))) {
          bestScore = score;
          best = emp;
        }
      }
      if (best && bestScore >= 0.5) {
        cedula = String(best.cedula).trim();
      }
    }

    if (!cedula) {
      sinCoincidencia++;
      continue;
    }

    const existing = findEmployee.get(cedula);
    if (existing) {
      if (existing.estado !== 'FIRMADO' || !existing.pdf_path) {
        const fecha = existing.fecha_firma || 'FIRMADO PREVIO';
        updateSigned.run(fecha, relativePath, cedula);
        nuevosVinculados++;
      } else {
        yaVinculados++;
      }
    } else {
      const nombre = path.parse(file).name.replace(/^(\d+)_/, '').replace(/_/g, ' ').trim() || 'EMPLEADO CEDENAR';
      insertEmployee.run(cedula, nombre, relativePath);
      nuevosVinculados++;
    }
  }
});

transaction();

const totalFirmados = db.prepare("SELECT COUNT(*) AS count FROM empleados WHERE estado = 'FIRMADO'").get().count;
db.close();

console.log(`\n  SINCRONIZACION COMPLETADA`);
console.log(`  PDFs encontrados: ${pdfFiles.length}`);
console.log(`  Nuevos vinculados: ${nuevosVinculados}`);
console.log(`  Ya estaban vinculados: ${yaVinculados}`);
console.log(`  Sin coincidencia: ${sinCoincidencia}`);
console.log(`  Total firmados ahora: ${totalFirmados}\n`);
