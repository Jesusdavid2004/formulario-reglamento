# formulario-reglamento

Aplicación web para registrar la entrega y firma digital del reglamento interno de trabajo.

## Ejecutar localmente

```bash
npm install
npm start
```

El servidor usa el puerto definido por `PORT` o, por defecto, el puerto `3000`.

## Desplegar en Render

Crear un servicio **Web Service** conectado a este repositorio con esta configuración:

- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Environment Variable:** `QR_ACCESS_TOKEN` con un valor largo y secreto
- **Environment Variable opcional:** `PUBLIC_URL` con la URL HTTPS del servicio

Render proporciona automáticamente la variable `PORT`. El código también detecta el dominio del servicio para generar el QR si no se define `PUBLIC_URL`.

El panel administrativo está disponible en `/admin`. El formulario de firma solo se puede abrir mediante el enlace incluido en el QR generado desde ese panel.

## Persistencia

La aplicación usa SQLite y guarda los PDFs localmente. El disco de un Web Service estándar de Render es efímero, por lo que para conservar firmas y documentos después de reinicios o nuevos despliegues se debe configurar un **Persistent Disk** o migrar esos datos a una base de datos y almacenamiento persistente.