// compacta-sola: el gasto real viene de releer un contexto enorme en cada petición.
//  1. Al acabar un turno, si el contexto supera el umbral, compacta (caché aún viva, sin cortar trabajo).
//  2. Recorta salidas largas de Bash y PowerShell; la salida completa queda en un archivo.
// Órdenes: /compacta-sola [on | off | umbral <miles>]
import type { Register, EngineInterface } from 'claude-code'

const UMBRAL_INICIAL = 180_000
// Tras compactar, exige este crecimiento antes de repetir: evita compactar turno tras turno.
const CRECIMIENTO_MINIMO = 60_000
const MAX_CARACTERES = 12_000
const CONSERVAR = 4_000
// Las salidas ocupan ranuras que se reutilizan: el disco no crece sin límite.
const RANURAS = 300
const HERRAMIENTAS = new Set(['Bash', 'PowerShell'])

const INSTRUCCIONES =
  'Conserva literalmente: el objetivo y el plan en curso con los pasos que faltan, ' +
  'las rutas de archivos tocados, las decisiones del usuario y sus motivos, los permisos concedidos o negados, ' +
  'las restricciones vigentes, los errores sin resolver y los datos medidos que sigan importando. ' +
  'Omite salidas de comandos ya interpretadas y caminos descartados.'

type Datos = { activo: boolean; umbral: number; compactaciones: number; evitados: number; recortados: number }
const INICIAL: Datos = { activo: true, umbral: UMBRAL_INICIAL, compactaciones: 0, evitados: 0, recortados: 0 }

let suelo = 0
let enCurso = false
let pendiente = false
let ultimoContexto = 0

async function datos($: EngineInterface): Promise<Datos> {
  const guardado = (await $.store.get('datos')) as Partial<Datos> | undefined
  return { ...INICIAL, ...guardado }
}

async function cambiar($: EngineInterface, fn: (d: Datos) => Partial<Datos>) {
  const d = await datos($)
  const nuevo = { ...d, ...fn(d) }
  await $.store.set('datos', nuevo)
  return nuevo
}

const k = (n: number) => `${Math.round(n / 1000)}k`

async function carpetaSalidas($: EngineInterface) {
  // No depende de $.plugin.root: un mod puede cargarse desde fuera de .claude.
  const casa = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return casa ? `${casa.replaceAll('\\', '/')}/.claude/compacta-sola/salidas` : undefined
}

function recortar(texto: string, ruta: string) {
  const fuera = texto.length - 2 * CONSERVAR
  return (
    `${texto.slice(0, CONSERVAR)}\n\n[compacta-sola: ${fuera} caracteres recortados. ` +
    `Salida completa en ${ruta}: usa Grep o Read con offset y limit, no la leas entera.]\n\n${texto.slice(-CONSERVAR)}`
  )
}

// El diagnóstico nunca debe romper la compactación.
async function diagnostico($: EngineInterface, texto: string) {
  try {
    await $.store.set('diagnostico', texto)
  } catch {}
}

async function compactar($: EngineInterface) {
  if (enCurso || !pendiente) return
  enCurso = true
  try {
    const r = await $.session.compact()
    pendiente = false
    await diagnostico($, r.skip === undefined ? 'última compactación: hecha' : `última compactación: saltada (${r.skip})`)
  } catch (error) {
    // En la app de escritorio la llamada directa no existe: compactar es la orden /compact.
    try {
      await $.command.run({ command: 'compact', args: '' })
      pendiente = false
      suelo = ultimoContexto
      await diagnostico($, 'última compactación: pedida con /compact')
    } catch (error2) {
      // Sigue pendiente: se reintenta al enviar el siguiente mensaje o al acabar el turno.
      await diagnostico($, `última compactación: rechazada (${String(error).slice(0, 120)} / ${String(error2).slice(0, 120)})`)
    }
  } finally {
    enCurso = false
    try {
      $.ui.status(undefined)
    } catch {}
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'compacta-sola', description: 'Estado y ajustes del ahorro de tokens' })
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return r
    const { activo, umbral } = await datos($)
    const { tokens } = (await $.session.usage()).context
    await diagnostico($, `último turno: contexto ${tokens === undefined ? 'sin dato' : k(tokens)}`)
    if (activo && tokens !== undefined && tokens >= Math.max(umbral, suelo + CRECIMIENTO_MINIMO)) {
      $.ui.status(`compacta-sola: compactando ${k(tokens)}`)
      pendiente = true
      ultimoContexto = tokens
      // El turno aún se está cerrando: compactar dentro de este evento sería rechazado.
      $.clock.after(1500, () => void compactar($))
    }
    return r
  })

  // Respaldo: si el temporizador no pudo compactar, se hace antes de atender el mensaje.
  on('prompt.submit', async ($, e, next) => {
    await compactar($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const instructions = [e.instructions, INSTRUCCIONES].filter(Boolean).join('\n\n')
    const r = await next({ ...e, instructions })
    if (e.agentId === undefined && r.skip === undefined && r.tokensAfter !== undefined) {
      const { tokensBefore, tokensAfter } = r
      suelo = tokensAfter
      await cambiar($, d => ({
        compactaciones: d.compactaciones + 1,
        evitados: d.evitados + Math.max(0, (tokensBefore ?? tokensAfter) - tokensAfter),
      }))
      if (tokensBefore !== undefined) $.ui.toast(`Contexto: ${k(tokensBefore)} → ${k(tokensAfter)}`)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (e.origin.kind !== 'tool' || !HERRAMIENTAS.has(e.origin.tool)) return next(e)
    let message = e.message
    try {
      const { activo } = await datos($)
      const carpeta = await carpetaSalidas($)
      if (activo && carpeta) {
        let ahorro = 0
        const content = []
        for (const b of e.message.content) {
          if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > MAX_CARACTERES) {
            const hechos = ((await $.store.get('ranura')) as number | undefined) ?? 0
            await $.store.set('ranura', hechos + 1)
            const ruta = `${carpeta}/salida-${hechos % RANURAS}.txt`
            await $.fs.write(ruta, b.content)
            const nuevo = recortar(b.content, ruta)
            ahorro += b.content.length - nuevo.length
            content.push({ ...b, content: nuevo })
          } else content.push(b)
        }
        if (ahorro > 0) {
          await cambiar($, d => ({ recortados: d.recortados + ahorro }))
          message = { ...e.message, content }
        }
      }
    } catch {
      // Si no se pudo guardar la salida completa, no se recorta nada.
      message = e.message
    }
    return next({ ...e, message })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'compacta-sola' }, async ($, e) => {
    const [orden, valor] = e.args.trim().toLowerCase().split(/\s+/)
    const miles = Number(valor)
    if (orden === 'umbral' && !(miles >= 50 && miles <= 900)) {
      return { text: 'Usa: /compacta-sola umbral <50 a 900> (miles de tokens).' }
    }
    const d =
      orden === 'on' || orden === 'off'
        ? await cambiar($, () => ({ activo: orden === 'on' }))
        : orden === 'umbral'
          ? await cambiar($, () => ({ umbral: miles * 1000 }))
          : await datos($)
    return {
      text:
        `compacta-sola ${d.activo ? 'activo' : 'apagado'} · umbral ${k(d.umbral)} · ` +
        `${d.compactaciones} compactaciones · ${k(d.evitados)} tokens de contexto retirados · ` +
        `${k(d.recortados)} caracteres recortados · ${(await $.store.get('diagnostico')) ?? 'sin diagnóstico'}`,
    }
  })
}
