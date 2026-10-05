#!/usr/bin/env node
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const apps = [
  { name: 'server',   cmd: 'npm',       args: ['run', 'dev', '-w', '@photobooth/server'] },
  { name: 'booth',    cmd: 'npm',       args: ['run', 'dev', '-w', '@photobooth/booth']  },
  { name: 'admin',    cmd: 'npm',       args: ['run', 'dev', '-w', '@photobooth/admin']  },
]

const processes = apps.map(({ name, cmd, args }) => {
  console.log(`[${name}] starting...`)
  const p = spawn(cmd, args, { cwd: root, stdio: 'pipe', shell: true })
  p.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`))
  p.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`))
  p.on('exit', code => {
    console.error(`[${name}] exited with code ${code}`)
    processes.forEach(x => x.kill())
    process.exit(code)
  })
  return p
})

process.on('SIGINT', () => { processes.forEach(p => p.kill()); process.exit() })
