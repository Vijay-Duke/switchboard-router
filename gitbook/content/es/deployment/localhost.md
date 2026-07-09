# 🏠 Despliegue en localhost

Ejecuta Switchboard en tu máquina local para desarrollo y uso personal.

---

## 📦 Instalación

Instala Switchboard globalmente vía npm:

```bash
npm install -g switchboard-router
```

**Requisitos:**
- Node.js 20 o superior
- npm 9 o superior

---

## 🚀 Iniciar el servidor

Inicia Switchboard con un solo comando:

```bash
switchboard
```

El dashboard se abrirá automáticamente en tu navegador en `http://localhost:3000`

**Configuración por defecto:**
- **Dashboard**: `http://localhost:3000`
- **API Endpoint**: `http://localhost:20128/v1`
- **Directorio de datos**: `~/.switchboard`

---

## 🔧 Configuración

### Directorio de datos personalizado

Establece un directorio de datos personalizado usando una variable de entorno:

```bash
DATA_DIR=/path/to/data switchboard
```

### Puerto personalizado

El puerto de API (20128) y el puerto del dashboard (3000) están configurados en la aplicación. Para cambiarlos, necesitarás modificar el código fuente o usar variables de entorno si se soportan.

---

## 🛑 Detener el servidor

Presiona `Ctrl+C` en la terminal donde Switchboard se está ejecutando.

```bash
# En la terminal ejecutando switchboard
^C  # Presiona Ctrl+C
```

El servidor se apagará correctamente y guardará todos los datos.

---

## 🔄 Reiniciar el servidor

Simplemente ejecuta el comando de inicio nuevamente:

```bash
switchboard
```

Todas tus configuraciones, API keys y combos se preservan en el directorio de datos.

---

## 📊 Actualizar Switchboard

Actualiza a la última versión:

```bash
npm update -g switchboard
```

Verifica tu versión actual:

```bash
npm list -g switchboard
```

---

## 🔍 Solución de problemas

### Puerto ya en uso

Si el puerto 20128 o 3000 ya está en uso:

```bash
# Encontrar proceso usando el puerto (macOS/Linux)
lsof -i :20128
lsof -i :3000

# Matar el proceso
kill -9 <PID>
```

### Errores de permisos

Si encuentras errores de permisos durante la instalación:

```bash
# Usar sudo (no recomendado)
sudo npm install -g switchboard-router

# O corregir los permisos de npm (recomendado)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Problemas con el directorio de datos

Si el directorio de datos no es accesible:

```bash
# Verificar permisos
ls -la ~/.switchboard

# Corregir permisos
chmod 755 ~/.switchboard
```

---

## 📁 Estructura del directorio de datos

```
~/.switchboard/
├── db.json           # Main database (providers, combos, settings)
├── logs/             # Application logs
└── cache/            # Temporary cache files
```

**Respaldar tus datos:**

```bash
# Respaldo
cp -r ~/.switchboard ~/.switchboard.backup

# Restaurar
cp -r ~/.switchboard.backup ~/.switchboard
```

---

## 🔗 Próximos pasos

- [Conectar proveedores](/providers/subscription.md)
- [Crear combos](/features/combos.md)
- [Integrar con herramientas CLI](/integration/cursor.md)
