# Sistema de Remisiones DISTRIMOS S.A.S

Remisiones digitales con firma, foto, fecha y hora; avance y balance por contrato;
respaldos y auditoría. Dos versiones, **cada una con su propio servidor**:

| Versión | Servidor | Base de datos | Entregable |
|---|---|---|---|
| PC portable (Windows) | Node.js (API REST + web), puerto 3580 | `datos/remisiones.db` junto al .exe | `dist/PC-Portable/Remisiones-DISTRIMOS/RemisionesDISTRIMOS.exe` |
| Android (APK) | Servidor Dart interno, `127.0.0.1:8765` | SQLite en el celular | `dist/Android/Remisiones-DISTRIMOS-v1.0.0.apk` |

El celular funciona sin internet y sincroniza con el PC por Wi-Fi (Sincronización → Vincular con la oficina).

## Uso rápido

1. PC: doble clic en `RemisionesDISTRIMOS.exe`. Ingreso inicial `admin` / `admin123` (pide cambiarla).
2. Ajustes → *Cargar datos de ejemplo* para practicar (usuarios `gerente`, `secretaria`, `repartidor1`, `repartidor2`, `cliente1`, clave `demo123`).
3. Celular: instalar la APK, tocar *Vincular con la oficina*, escribir la dirección "En la red local" que muestra el PC y el usuario del repartidor.

## Desarrollo

```bash
# Servidor PC en modo desarrollo (sirve ../web desde disco)
cd servidor-pc && node src/main.js

# Servidor del celular ejecutado en el PC (para pruebas)
cd app-movil && dart run bin/servidor_escritorio.dart <carpeta_datos> 8766

# Construir entregables
node scripts/construir-pc.js     # .exe portable (Node SEA)
node scripts/construir-apk.js    # APK firmada (Flutter)

# Pruebas automáticas (con ambos servidores corriendo en 3591 y 8766)
cd pruebas && npm install && npm run ui && npm run sync
```

La llave de firma de la APK está en `app-movil/android/distrimos-release.jks` y su clave en
`app-movil/android/key.properties`. **Guarde ambos archivos en un lugar seguro**: sin ellos no se pueden
publicar actualizaciones que reemplacen la app instalada.

## Versión en línea (Railway) y modo sin internet

La misma interfaz web, publicada en Railway, se puede **instalar como aplicación** desde el navegador del celular
(Chrome → menú → *Instalar aplicación* / *Agregar a pantalla de inicio*). Funciona así:

- **Con internet:** trabaja directamente contra el servidor; no hace falta la APK.
- **Sin internet:** abre igual (service worker `web/sw.js`), muestra las remisiones ya cargadas y permite **registrar entregas**
  (firmas, foto, receptor). Quedan guardadas en el equipo (`web/js/sin-conexion.js`, IndexedDB) y un aviso lo indica.
- **Al volver la conexión:** se envían solas al servidor (cada 20 s y al detectar la red) y se actualiza la lista.

Requisitos: abrir la app una vez con internet y con el usuario del repartidor (así se guardan sus remisiones pendientes);
solo se registran entregas sin conexión (crear o editar remisiones requiere internet). Funciona en direcciones `https://` y `localhost`.
