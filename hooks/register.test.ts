import { expect, test } from 'claude-code/testing'

type Prueba = Parameters<Parameters<typeof test>[1]>
type Ctx = Prueba[0]
type On = Prueba[1]

function base(on: On, tokens: number) {
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'compacta-sola' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { tokens, window: 1_000_000 } },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: 'C:/Users/prueba' }))
}

const arrancar = ($: Ctx) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

const turno = {
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer',
} as const

test('programa la compactación por encima del umbral', async ($, on) => {
  let programadas = 0
  base(on, 200_000)
  on('clock.after', () => {
    programadas += 1
    return { value: undefined }
  })
  await arrancar($)
  await $.turn.complete(turno)
  expect(programadas).toBe(1)
})

test('no compacta por debajo del umbral', async ($, on) => {
  let programadas = 0
  base(on, 100_000)
  on('clock.after', () => {
    programadas += 1
    return { value: undefined }
  })
  await arrancar($)
  await $.turn.complete(turno)
  expect(programadas).toBe(0)
})

test('no compacta tras una interrupción', async ($, on) => {
  let programadas = 0
  base(on, 500_000)
  on('clock.after', () => {
    programadas += 1
    return { value: undefined }
  })
  await arrancar($)
  await $.turn.complete({ ...turno, reason: 'aborted', isAborted: true })
  expect(programadas).toBe(0)
})

test('añade las instrucciones sin perder las del usuario', async ($, on) => {
  let recibidas = ''
  base(on, 1)
  on('session.compact', (_, e) => {
    recibidas = e.instructions ?? ''
    return { messages: [{ role: 'user', text: 'resumen', toolUses: [] }], tokensBefore: 200_000, tokensAfter: 40_000 } as never
  })
  await arrancar($)
  await $.session.compact({ instructions: 'mi nota', messages: [{ role: 'user', text: 'hola', toolUses: [] }] } as never)
  expect(recibidas).toContain('mi nota')
  expect(recibidas).toContain('plan en curso')
})

const fila = (salida: string) =>
  ({
    door: 'tool-result',
    uuid: 'u',
    origin: { kind: 'tool', tool: 'Bash' },
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: salida }] },
  }) as const

test('recorta una salida larga y guarda la completa', async ($, on) => {
  const escritos: string[] = []
  const rutas: string[] = []
  let guardada = ''
  base(on, 1)
  on('fs.write', (_, e) => {
    escritos.push(e.text)
    rutas.push(e.path.replaceAll(String.fromCharCode(92), '/'))
    return { value: undefined }
  })
  on('session.append', (_, e, next) => {
    const b = e.message.content[0]
    guardada = b?.type === 'tool_result' && typeof b.content === 'string' ? b.content : ''
    return next(e)
  })
  await arrancar($)
  const larga = 'INICIO' + 'x'.repeat(50_000) + 'FINAL'
  await $.session.append(fila(larga))
  expect(escritos[0]).toBe(larga)
  expect(rutas[0]).toBe('C:/Users/prueba/.claude/compacta-sola/salidas/salida-0.txt')
  expect(guardada.length).toBeLessThan(9_000)
  expect(guardada).toContain('INICIO')
  expect(guardada).toContain('FINAL')
  expect(guardada).toContain('compacta-sola')
})

test('deja intacta una salida corta', async ($, on) => {
  let guardada = ''
  base(on, 1)
  on('session.append', (_, e, next) => {
    const b = e.message.content[0]
    guardada = b?.type === 'tool_result' && typeof b.content === 'string' ? b.content : ''
    return next(e)
  })
  await arrancar($)
  await $.session.append(fila('hola'))
  expect(guardada).toBe('hola')
})

test('si no se puede guardar el archivo, no recorta', async ($, on) => {
  let guardada = ''
  base(on, 1)
  on('fs.write', () => {
    throw new Error('disco')
  })
  on('session.append', (_, e, next) => {
    const b = e.message.content[0]
    guardada = b?.type === 'tool_result' && typeof b.content === 'string' ? b.content : ''
    return next(e)
  })
  await arrancar($)
  const larga = 'y'.repeat(20_000)
  await $.session.append(fila(larga))
  expect(guardada).toBe(larga)
})

test('si la llamada directa no existe, usa la orden /compact', async ($, on) => {
  const ordenes: string[] = []
  base(on, 200_000)
  on('clock.after', () => ({ value: undefined }))
  on('session.compact', () => {
    throw new Error('not available in a headless session')
  })
  on('command.run', (_, e) => {
    ordenes.push(e.command)
    return { text: '' }
  })
  await arrancar($)
  await $.turn.complete(turno)
  for (let i = 0; i < 100 && ordenes.length === 0; i += 1) await $.turn.complete({ ...turno, reason: 'aborted', isAborted: true })
  expect(ordenes).toEqual(['compact'])
})
