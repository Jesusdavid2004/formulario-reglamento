const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const DB_FILE = path.join(__dirname, 'data', 'reglamentos.sqlite');
const OUTPUT_DIR = path.join(__dirname, 'reportes_pendientes');

if (!fs.existsSync(DB_FILE)) {
  console.error('No se encontró la base de datos.');
  process.exit(1);
}

const db = new Database(DB_FILE, { readonly: true });

const empleados = db.prepare(
  `SELECT cedula, nombre, cargo, dependencia, estado
   FROM empleados
   ORDER BY dependencia, nombre`
).all();

db.close();

const dependencias = {
  'SINDICATOS': 'SINDICATOS',
  'DIVISION ADMINISTRATIVA': 'DIVISION ADMINISTRATIVA',
  'SUBGERENCIA DISTRIBUCION Y GENERACION': 'SUBGERENCIA DISTRIBUCION Y GENERACION',
  'OFICINA JURIDICA': 'OFICINA JURIDICA',
  'SUBGERENCIA GESTION ENERGETICA': 'SUBGERENCIA GESTION ENERGETICA',
  'SUBGERENCIA ADMINISTRATIVA Y FINANCIERA': 'SUBGERENCIA ADMINISTRATIVA Y FINANCIERA',
  'GERENCIA GENERAL': 'GERENCIA GENERAL',
  'OFICINA DE CONTROL INTERNO': 'OFICINA DE CONTROL INTERNO',
  'OFICINA DE PLANEACION Y SISTEMAS': 'OFICINA DE PLANEACION Y SISTEMAS',
  'SUBGERENCIA COMERCIAL': 'SUBGERENCIA COMERCIAL',
  'CEDENAR': 'CEDENAR',
  'ZONA NORTE': 'ZONA NORTE',
  'ZONA PACIFICO': 'ZONA PACIFICO',
  'ZONA SUR': 'ZONA SUR',
};

function matchDependencia(empDep) {
  if (!empDep) return null;
  const upper = empDep.toUpperCase();
  for (const [key] of Object.entries(dependencias)) {
    if (upper.startsWith(key)) return key;
  }
  return null;
}

const pendientesPorDep = {};
const firmadosPorDep = {};

for (const key of Object.keys(dependencias)) {
  pendientesPorDep[key] = [];
  firmadosPorDep[key] = [];
}

empleados.forEach((emp) => {
  const dep = matchDependencia(emp.dependencia);
  if (!dep) return;
  if (emp.estado === 'FIRMADO') {
    firmadosPorDep[dep].push(emp);
  } else {
    pendientesPorDep[dep].push(emp);
  }
});

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const headerStyle = {
  font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
  fill: { fgColor: { rgb: '092F54' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: {
    top: { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left: { style: 'thin', color: { rgb: '000000' } },
    right: { style: 'thin', color: { rgb: '000000' } },
  },
};

const dataStyle = {
  font: { sz: 10 },
  alignment: { vertical: 'center', wrapText: true },
  border: {
    top: { style: 'thin', color: { rgb: 'CCCCCC' } },
    bottom: { style: 'thin', color: { rgb: 'CCCCCC' } },
    left: { style: 'thin', color: { rgb: 'CCCCCC' } },
    right: { style: 'thin', color: { rgb: 'CCCCCC' } },
  },
};

let archivosGenerados = 0;

for (const [key, label] of Object.entries(dependencias)) {
  const pendientes = pendientesPorDep[key];
  const firmados = firmadosPorDep[key];
  const total = pendientes.length + firmados.length;

  if (total === 0) continue;

  const rows = pendientes.map((emp) => ({
    Cedula: emp.cedula,
    Nombre: emp.nombre,
    Cargo: emp.cargo || '',
    Dependencia: emp.dependencia || '',
  }));

  if (rows.length === 0) continue;

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: ['Cedula', 'Nombre', 'Cargo', 'Dependencia'],
  });

  worksheet['!cols'] = [
    { wch: 16 },
    { wch: 42 },
    { wch: 30 },
    { wch: 48 },
  ];

  const range = XLSX.utils.decode_range(worksheet['!ref']);
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cellRef = XLSX.utils.encode_cell({ r: range.s.r, c: col });
    if (worksheet[cellRef]) worksheet[cellRef].s = headerStyle;
  }
  for (let row = range.s.r + 1; row <= range.e.r; row++) {
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
      if (worksheet[cellRef]) worksheet[cellRef].s = dataStyle;
    }
  }
  worksheet['!rows'] = [{ hpt: 30 }];

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Pendientes');

  const safeName = label.replace(/[^A-Z0-9 ]/gi, '').replace(/\s+/g, '_');
  const outputFile = path.join(OUTPUT_DIR, `pendientes_${safeName}.xlsx`);
  XLSX.writeFile(workbook, outputFile);

  console.log(`  ${label}: ${pendientes.length} pendientes de ${total} total`);
  archivosGenerados++;
}

console.log(`\n  REPORTES GENERADOS: ${archivosGenerados} archivos Excel`);
console.log(`  Carpeta: ${OUTPUT_DIR}\n`);
