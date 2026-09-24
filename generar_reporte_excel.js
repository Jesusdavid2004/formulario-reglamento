const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const DB_FILE = path.join(__dirname, 'data', 'reglamentos.sqlite');
const OUTPUT_FILE = path.join(__dirname, `reporte-firmados-${new Date().toISOString().slice(0, 10)}.xlsx`);

if (!fs.existsSync(DB_FILE)) {
  console.error(`No se encontró la base de datos en: ${DB_FILE}`);
  process.exit(1);
}

const db = new Database(DB_FILE, { readonly: true });

const firmados = db.prepare(
  `SELECT cedula, nombre, cargo, dependencia, fecha_firma
   FROM empleados
   WHERE estado = 'FIRMADO'
   ORDER BY dependencia, nombre`
).all();

db.close();

if (firmados.length === 0) {
  console.log('No hay empleados con estado FIRMADO en la base de datos.');
  process.exit(0);
}

function getZoneName(dependencia) {
  if (!dependencia) return 'SIN ZONA';
  const parts = dependencia.split(' - ');
  return parts[0].trim();
}

const rows = firmados.map((emp) => ({
  Cedula: emp.cedula,
  'Nombre Completo': emp.nombre,
  Cargo: emp.cargo || '',
  'Dependencia / Area': emp.dependencia || '',
  Zona: getZoneName(emp.dependencia),
  'Fecha de Firma': emp.fecha_firma || '',
}));

const workbook = XLSX.utils.book_new();

const headerStyle = {
  font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 },
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

const worksheet = XLSX.utils.json_to_sheet(rows);
worksheet['!cols'] = [
  { wch: 16 },
  { wch: 42 },
  { wch: 30 },
  { wch: 48 },
  { wch: 32 },
  { wch: 30 },
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

XLSX.utils.book_append_sheet(workbook, worksheet, 'Firmados');

const zoneSummary = {};
const zoneEmpleados = {};
rows.forEach((row) => {
  if (!zoneSummary[row.Zona]) {
    zoneSummary[row.Zona] = { firmados: 0 };
    zoneEmpleados[row.Zona] = [];
  }
  zoneSummary[row.Zona].firmados++;
  zoneEmpleados[row.Zona].push(row);
});

const summaryRows = Object.entries(zoneSummary)
  .map(([zona, data]) => ({ Zona: zona, 'Total Firmados': data.firmados }))
  .sort((a, b) => a.Zona.localeCompare(b.Zona, 'es'));

summaryRows.push({ Zona: 'TOTAL GENERAL', 'Total Firmados': firmados.length });

const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
summarySheet['!cols'] = [{ wch: 45 }, { wch: 16 }];
const summaryRange = XLSX.utils.decode_range(summarySheet['!ref']);
for (let col = summaryRange.s.c; col <= summaryRange.e.c; col++) {
  const cellRef = XLSX.utils.encode_cell({ r: summaryRange.s.r, c: col });
  if (summarySheet[cellRef]) summarySheet[cellRef].s = headerStyle;
}
for (let row = summaryRange.s.r + 1; row <= summaryRange.e.r; row++) {
  for (let col = summaryRange.s.c; col <= summaryRange.e.c; col++) {
    const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
    if (summarySheet[cellRef]) {
      const style = row === summaryRange.e.r
        ? { ...dataStyle, font: { bold: true, sz: 11 } }
        : dataStyle;
      summarySheet[cellRef].s = style;
    }
  }
}
summarySheet['!rows'] = [{ hpt: 30 }];

XLSX.utils.book_append_sheet(workbook, summarySheet, 'Resumen por Zona');

XLSX.writeFile(workbook, OUTPUT_FILE);

console.log(`\n  REPORTE GENERADO CON EXITO`);
console.log(`  Archivo: ${OUTPUT_FILE}`);
console.log(`  Total firmados: ${firmados.length}`);
console.log(`  Zonas encontradas: ${Object.keys(zoneSummary).length}`);
console.log(`\n  Resumen por zona:`);
Object.entries(zoneSummary)
  .sort((a, b) => a[0].localeCompare(b[0], 'es'))
  .forEach(([zona, data]) => {
    console.log(`    ${zona}: ${data.firmados} firmados`);
  });
console.log();
