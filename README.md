# compacta-sola

Mod de Claude Code para reducir el consumo de tokens. La mayor parte del gasto suele venir de releer un contexto enorme en cada petición, así que el mod evita que crezca.

## Qué hace

- **Compacta entre turnos:** al terminar un turno con 180.000 tokens o más, compacta la conversación sin cortar el trabajo en curso. Pide conservar el plan, las rutas, las decisiones, los permisos y los errores sin resolver.
- **Recorta salidas largas:** en `Bash` y `PowerShell`, las salidas de más de 12.000 caracteres se quedan con 4.000 del principio y 4.000 del final. La salida completa se guarda en `~/.claude/compacta-sola/salidas`, en 300 archivos que se reutilizan. Si no puede guardarla, no recorta nada.

## Instalación

En un terminal de Claude Code:

```
/plugin install compacta-sola --marketplace Trikels/compacta-sola
```

Responde `y` para añadir el catálogo y elige el alcance.

Desde una consola:

```bash
claude plugin install compacta-sola --marketplace Trikels/compacta-sola
```

En la app de escritorio: pulsa + junto al cuadro de texto, luego Plugins, Add marketplace con `Trikels/compacta-sola` y Add plugin.

## Uso

Funciona solo. Estas órdenes son opcionales:

| Orden | Qué hace |
|---|---|
| `/compacta-sola` | Muestra el estado, el umbral y lo ahorrado |
| `/compacta-sola umbral 300` | Cambia el umbral, en miles de tokens (de 50 a 900) |
| `/compacta-sola off` | Apaga la compactación y el recorte |
| `/compacta-sola on` | Los vuelve a encender |

## A tener en cuenta

- Compactar pierde detalle: tras hacerlo, Claude trabaja con un resumen de lo anterior.
- El mod no cambia el `autoCompactWindow` de Claude Code. Si lo tienes muy alto, el mod compacta antes igualmente mientras esté encendido.

## Licencia

MIT
