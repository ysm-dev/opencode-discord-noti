import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const temp = await mkdtemp(path.join(tmpdir(), "opencode-discord-noti-package-"))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

try {
  const spec = process.argv[2]
  const output = run("npm", ["pack", ...(spec ? [spec] : []), "--silent", "--json", "--pack-destination", temp], root)
  const start = output.lastIndexOf("\n[")
  const [packed] = JSON.parse(output.slice(start === -1 ? 0 : start + 1))
  assert.equal(packed.name, "opencode-discord-noti")
  assert.deepEqual(packed.files.map((file) => file.path).sort(), [
    "LICENSE",
    "README.md",
    "dist/index.js",
    "index.d.ts",
    "package.json",
  ])
  const consumer = path.join(temp, "consumer")
  await mkdir(consumer)
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n')
  run(
    "npm",
    ["install", "--silent", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temp, packed.filename)],
    consumer,
  )
  await writeFile(
    path.join(consumer, "smoke.mjs"),
    `
    import assert from "node:assert/strict"
    import { createServer } from "node:http"
    import { once } from "node:events"
    import { Host } from "@opencode/plugin/host"
    const entrypoints = Host.resolve({ directory: process.cwd(), name: "opencode-discord-noti" })
    assert.ok(entrypoints.server)
    const plugin = await Host.load(entrypoints.server)
    assert.equal(plugin.default.id, "opencode-discord-noti")
    assert.equal(typeof plugin.default.setup, "function")
    assert.equal(plugin.default, plugin.DiscordNotificationPlugin)
    assert.equal(Object.keys(plugin).length, 2)
    assert.equal(await plugin.default.setup({ options: {} }), undefined)
    const calls = []
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      calls.push(JSON.parse(Buffer.concat(chunks).toString()))
      response.writeHead(204).end()
    }).listen(0, "127.0.0.1")
    await once(server, "listening")
    const location = { directory: "/package-test" }
    const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } }
    const done = Promise.withResolvers()
    let signal
    let cleanup
    try {
      cleanup = await plugin.default.setup({
        options: {
          enabled: true,
          webhookUrl: "http://127.0.0.1:" + server.address().port,
          username: "Package test",
          avatarUrl: "https://example.com/avatar.png",
        },
        location,
        session: {
          async get({ sessionID }) {
            return { id: sessionID, title: "Package session", location, tokens, parentID: sessionID === "child" ? "root" : undefined }
          },
          async context() {
            return [{ id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, model: { id: "test", providerID: "test" }, content: [{ type: "text", text: "Packaged completion" }], tokens }]
          },
        },
        model: { async list() { return { data: [{ id: "test", providerID: "test", limit: { context: 1000 } }] } } },
        event: { async *subscribe(options) {
          signal = options.signal
          try {
            yield { type: "permission.asked", data: { sessionID: "root", action: "shell", resources: ["git status"] } }
            yield { type: "form.created", data: { form: { sessionID: "root", title: "Questions", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", description: "Does the packaged plugin accept options?" }] } } }
            yield { type: "session.execution.succeeded", data: { sessionID: "root" } }
            yield { type: "session.execution.succeeded", data: { sessionID: "child" } }
            yield { type: "session.idle", data: { sessionID: "child" } }
          } finally { done.resolve() }
        } },
      })
      await done.promise
      assert.equal(calls.length, 3)
      assert.equal(calls[0].username, "Package test")
      assert.equal(calls[0].avatar_url, "https://example.com/avatar.png")
      assert.match(calls[1].embeds[0].description, /Does the packaged plugin accept options/)
      assert.equal(calls[2].embeds[0].description, "Packaged completion")
      assert.deepEqual(calls[2].embeds[0].fields.find(field => field.name === "📊 Context Usage"), { name: "📊 Context Usage", value: "16.50%", inline: true })
    } finally {
      await cleanup?.()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    assert.equal(signal.aborted, true)
  `,
  )
  run("node", ["smoke.mjs"], consumer)
  await writeFile(
    path.join(consumer, "types.ts"),
    `import plugin, { type DiscordNotificationOptions } from "opencode-discord-noti"
import type { Plugin } from "@opencode/plugin"
const definition: Plugin.Plugin = plugin
const options: DiscordNotificationOptions = { enabled: true, webhookUrl: "http://localhost" }
void definition
void options
`,
  )
  run(
    path.join(root, "node_modules/.bin/tsgo"),
    ["--noEmit", "--skipLibCheck", "--module", "nodenext", "--target", "es2022", "types.ts"],
    consumer,
  )
  console.log(`Package smoke test passed: ${packed.name}@${packed.version}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
