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
  run(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict"
    const plugin = await import("opencode-discord-noti")
    assert.equal(typeof plugin.default, "function")
    assert.equal(plugin.default, plugin.DiscordNotificationPlugin)
    assert.equal(Object.keys(plugin).length, 2)
    const hooks = await plugin.default({ client: {}, project: {} })
    assert.deepEqual(Object.keys(hooks).sort(), ["event", "permission.ask", "tool.execute.before"])
    await hooks["permission.ask"]({}, { status: "allow" })
    await hooks["tool.execute.before"]({ tool: "bash" }, { args: {} })
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(null, { status: 204 })
    }
    await hooks["tool.execute.before"]({ tool: "question" }, { args: { question: "Disabled?" } })
    assert.equal(calls.length, 0)
    const configured = await plugin.default({ client: {}, project: {} }, {
      enabled: true,
      webhookUrl: "https://discord.invalid/test",
      username: "Package test",
      avatarUrl: "https://example.com/avatar.png",
    })
    await configured["tool.execute.before"](
      { tool: "question", sessionID: "session-1", callID: "call-1" },
      { args: { question: "Does the packaged plugin accept options?" } },
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://discord.invalid/test")
    assert.equal(calls[0].body.username, "Package test")
    assert.equal(calls[0].body.avatar_url, "https://example.com/avatar.png")
    assert.equal(calls[0].body.embeds[0].description, "Does the packaged plugin accept options?")
  `,
    ],
    consumer,
  )
  console.log(`Package smoke test passed: ${packed.name}@${packed.version}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
