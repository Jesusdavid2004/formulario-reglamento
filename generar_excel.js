const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('xlsx');

const DATA_FILE = path.join(__dirname, 'data.js');
const OUTPUT_FILE = path.join(__dirname, 'empleados_pasto.xlsx');
const ZONA_OBJETIVO = 'Pasto (Zona 001)';

function cargarEmpleados() {
  const dataSource = fs.readFileSync(DATA_FILE, 'utf8');
  const context = {};

  vm.runInNewContext(
    `${dataSource}\n;globalThis.__employeesData = EMPLOYEES_DATA;`,
    context,
    { filename: DATA_FILE },
  );

  if (!Array.isArray(context.__employeesData)) {
    throw new Error('EMPLOYEES_DATA no contiene un arreglo válido.');
  }

  return context.__employeesData;
}

function generarExcel() {
  const empleados = cargarEmpleados()
    .filter((empleado) => empleado.zonaNombre === ZONA_OBJETIVO)
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es', {
      sensitivity: 'base',
    }))
    .map((empleado) => ({
      Cedula: empleado.cedula,
      Nombre: empleado.nombre,
      Cargo: empleado.cargo,
      Dependencia: empleado.area,
      Estado: 'PENDIENTE',
    }));

  const worksheet = XLSX.utils.json_to_sheet(empleados, {
    header: ['Cedula', 'Nombre', 'Cargo', 'Dependencia', 'Estado'],
  });
  worksheet['!cols'] = [
    { wch: 14 },
    { wch: 42 },
    { wch: 34 },
    { wch: 32 },
    { wch: 14 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Empleados Pasto');
  XLSX.writeFile(workbook, OUTPUT_FILE);

  console.log(`Archivo generado: ${OUTPUT_FILE}`);
  console.log(`Empleados incluidos: ${empleados.length}`);
}

try {
  generarExcel();
} catch (error) {
  console.error(`No se pudo generar el archivo: ${error.message}`);
  process.exitCode = 1;
}