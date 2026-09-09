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

En Render, las firmas y los PDFs se guardan bajo `PERSIST_DIR`. El blueprint configura `/var/data` como **Persistent Disk**, con la base en `/var/data/data/reglamentos.sqlite` y los PDFs en `/var/data/pdfs/`. Este disco requiere un plan de Render que lo soporte; en el plan Free el servicio sigue usando almacenamiento efímero y los datos pueden perderse.

Antes de desplegar, crea o conserva una copia de la base local y de la carpeta `pdfs/`. El disco persistente protege los datos desde su primer montaje, pero no recupera firmas perdidas en despliegues anteriores.

### Supabase

Si se configuran `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en el entorno del servidor, la aplicación usa la tabla `public.empleados` y el bucket privado `reglamentos-pdfs` de Supabase para guardar firmas y PDFs. Sin esas variables, usa SQLite y almacenamiento local como fallback.