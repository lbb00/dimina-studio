import fs from 'node:fs'
import path from 'node:path'
import { Parser } from 'htmlparser2'
import { compileTemplate } from '@vue/compiler-sfc'
import { parseSync } from 'oxc-parser'
import { getAbsolutePath } from '../../../dimina/fe/packages/compiler/src/common/utils.js'
import { miniProgramBuiltinTags, tagWhiteList } from '../../../dimina/fe/packages/compiler/src/common/utils.js'
import { toMiniProgramModuleId } from '../../../dimina/fe/packages/compiler/src/common/path-utils.js'
import { loadReference } from '../../../dimina/fe/packages/compiler/src/common/compatibility.js'
import { getComponent, getViewScriptTags } from '../../../dimina/fe/packages/compiler/src/env.js'
import { isHTMLTag } from '@vue/shared'
import { CompilerDiagnosticsError, parseSyncOrThrow } from './compiler-diagnostics.js'

const blank = (text) => text.replace(/[^\r\n]/g, ' ')

function inspectTemplate(source, scriptTags) {
  const scripts = new Set(scriptTags)
  const imports = []
  const ranges = []
  let script = null
  const parser = new Parser({
    onopentag(name, attributes) {
      if (script) return
      if (scripts.has(name)) script = { name, start: parser.endIndex + 1 }
      else if ((name === 'import' || name === 'include') && attributes.src) imports.push(attributes.src)
    },
    onclosetag(name, implied) {
      if (!script || name !== script.name) return
      if (!implied) ranges.push([script.start, parser.startIndex])
      script = null
    },
  }, { xmlMode: true, decodeEntities: true })
  parser.end(source)
  let masked = source
  for (const [start, end] of ranges) masked = masked.slice(0, start) + blank(source.slice(start, end)) + masked.slice(end)
  return { masked, imports }
}

function validateAttributeBindings(ast, filename) {
  const nodes = [ast]
  while (nodes.length) {
    const node = nodes.pop()
    nodes.push(...(node.children ?? []))
    for (const prop of node.props ?? []) {
      if (!prop.value) continue
      const value = prop.value.content
      let start = value.indexOf('{{')
      while (start !== -1) {
        let end = value.indexOf('}}', start + 2)
        let accepted = false
        let failure
        while (end !== -1) {
          const expression = value.slice(start + 2, end)
          for (const code of [`(${expression})`, `({${expression}})`]) {
            try {
              parseSyncOrThrow(parseSync, filename, code, { sourceType: 'module', lang: 'js' })
              accepted = true
              break
            } catch (error) { failure ??= error }
          }
          if (accepted) break
          end = value.indexOf('}}', end + 2)
        }
        if (!accepted) {
          const loc = prop.value.loc
          throw new CompilerDiagnosticsError([{
            source: filename, line: loc.start.line, column: loc.start.column,
            endLine: loc.end.line, endColumn: loc.end.column, severity: 'error',
            message: `属性 ${prop.name} 的表达式无效: ${failure?.diagnostics?.[0]?.message ?? '缺少结束标记'}`,
          }])
        }
        start = value.indexOf('{{', end + 2)
      }
    }
  }
}

/** Validate reachable raw templates before the tolerant transform normalizes them. */
function warningForTag(node, filename, components, scripts) {
  const tag = node.tag
  if (!tag || components?.[tag] || scripts.has(tag)) return null
  const { supportedBuiltinComponents } = loadReference()
  if (supportedBuiltinComponents.has(tag) || tagWhiteList.includes(tag)) return null
  if (!miniProgramBuiltinTags.has(tag) && isHTMLTag(tag)) return null
  return {
    source: filename, line: node.loc.start.line, column: node.loc.start.column,
    endLine: node.loc.end.line, endColumn: node.loc.end.column, severity: 'warning',
    message: `Unsupported or undeclared component: <${tag}>`,
  }
}

function ownerComponents(owner, pages) {
  const allPages = [...(pages?.mainPages ?? []), ...Object.values(pages?.subPages ?? {}).flatMap((pkg) => pkg.info ?? [])]
  const page = allPages.find((item) => item.path === owner || `/${item.path}` === owner)
  return getComponent(owner)?.usingComponents ?? page?.usingComponents ?? {}
}

export function validateProjectTemplates({ graph, workPath, templateExts, scriptTags, pages }) {
  const pending = graph.fileEdges.filter((edge) => edge.kinds.includes('view')
    && templateExts.includes(path.extname(edge.file).toLowerCase())).map((edge) => ({ filename: edge.file, owner: edge.owner }))
  const visited = new Set()
  const diagnostics = []
  const diagnosticKeys = new Set()
  while (pending.length) {
    const { filename, owner } = pending.pop()
    const visitKey = `${owner}\0${filename}`
    if (visited.has(visitKey)) continue
    visited.add(visitKey)
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) continue
    const source = fs.readFileSync(filename, 'utf8')
    const { masked, imports } = inspectTemplate(source, scriptTags)
    const result = compileTemplate({ source: masked, filename, id: filename,
      compilerOptions: { isCustomElement: () => true, isVoidTag: () => false } })
    if (result.errors.length) {
      throw new CompilerDiagnosticsError(result.errors.map((error) => ({
        source: filename,
        line: error.loc?.start.line ?? 1,
        column: error.loc?.start.column ?? 1,
        endLine: error.loc?.end.line ?? error.loc?.start.line ?? 1,
        endColumn: error.loc?.end.column ?? error.loc?.start.column ?? 1,
        severity: 'error',
        message: typeof error === 'string' ? error : error.message,
      })))
    }
    validateAttributeBindings(result.ast, filename)
    const nodes = [...(result.ast.children ?? [])]
    const scripts = new Set([...scriptTags, ...getViewScriptTags()])
    const components = ownerComponents(owner, pages)
    while (nodes.length) {
      const node = nodes.pop()
      nodes.push(...(node.children ?? []))
      const warning = warningForTag(node, filename, components, scripts)
      if (warning) {
        const key = `${warning.source}:${warning.line}:${warning.column}:${warning.endLine}:${warning.endColumn}:${warning.message}`
        if (!diagnosticKeys.has(key)) {
          diagnosticKeys.add(key)
          diagnostics.push(warning)
        }
      }
    }
    for (const src of imports) {
      const moduleId = toMiniProgramModuleId(filename, workPath)
      let target = getAbsolutePath(workPath, moduleId, src)
      if (!fs.existsSync(target) && !path.extname(target)) {
        target = templateExts.map((ext) => target + ext).find((candidate) => fs.existsSync(candidate)) ?? target
      }
      pending.push({ filename: target, owner })
    }
  }
  return diagnostics
}
