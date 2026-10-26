import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export interface HostedSourceMapsOptions {
	outputDir: string
	appId: string
	projectRoot: string
	artifactRoot?: string
}

interface PreparedMap {
	mapPath: string
	contents: string
}

interface ResolvedSource {
	source: string
	candidate: string
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function hasUrlScheme(value: string): boolean {
	return /^[a-z][a-z\d+.-]*:/i.test(value)
}

function isResolvedSource(value: unknown): value is ResolvedSource {
	return !!value
		&& typeof value === 'object'
		&& typeof (value as Partial<ResolvedSource>).source === 'string'
		&& typeof (value as Partial<ResolvedSource>).candidate === 'string'
}

async function collectRegularMaps(directory: string): Promise<string[]> {
	const { readdir } = await import('node:fs/promises')
	const entries = await readdir(directory, { withFileTypes: true })
	const maps: string[] = []
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) {
			maps.push(...await collectRegularMaps(entryPath))
		}
		else if (entry.isFile() && entry.name.endsWith('.map')) {
			maps.push(entryPath)
		}
	}
	return maps
}

function normalizeMapSources(
	map: unknown,
	mapPath: string,
): unknown {
	if (map && typeof map === 'object' && Array.isArray((map as { sections?: unknown }).sections)) return map
	if (!map || typeof map !== 'object' || !Array.isArray((map as { sources?: unknown }).sources)) {
		throw new Error(`[devkit] hosted source map is malformed: ${mapPath}`)
	}
	const sourceMap = map as { sources: unknown[]; sourceRoot?: unknown }
	const sourceRoot = typeof sourceMap.sourceRoot === 'string' ? sourceMap.sourceRoot : ''
	if (hasUrlScheme(sourceRoot)) return map
	const mapDir = path.dirname(mapPath)
	const sources = sourceMap.sources.map((source) => {
		if (typeof source !== 'string' || !source || hasUrlScheme(source)) return source
		const candidate = path.resolve(mapDir, sourceRoot, source)
		return { source, candidate }
	})
	return { sourceMap, sources }
}

async function canonicalizeMap(
	map: unknown,
	mapPath: string,
	projectRoot: string,
	openedProjectRoot: string,
): Promise<unknown> {
	const normalized = normalizeMapSources(map, mapPath)
	if (!normalized || typeof normalized !== 'object' || !('sourceMap' in normalized)) return map
	const { sourceMap, sources } = normalized as {
		sourceMap: { sources: unknown[]; sourceRoot?: string }
		sources: Array<unknown | { source: string; candidate: string }>
	}
	let changed = false
	const canonicalSources = await Promise.all(sources.map(async (source) => {
		if (!isResolvedSource(source)) return source
		try {
			const physicalPath = await realpath(source.candidate)
			if (!isContained(projectRoot, physicalPath)) return source.source
			changed = true
			const sourcePath = isContained(openedProjectRoot, source.candidate)
				? source.candidate
				: path.resolve(openedProjectRoot, path.relative(projectRoot, physicalPath))
			return pathToFileURL(sourcePath).href
		}
		catch {
			return source.source
		}
	}))
	if (!changed) return sourceMap
	// A sourceRoot also prefixes file URIs in the consumer. Flatten the root
	// for retained relative entries before publishing canonical identities.
	const flattenedSources = canonicalSources.map((source, index) =>
		typeof source === 'string' && source === sourceMap.sources[index]
			&& sourceMap.sourceRoot && !hasUrlScheme(source)
			? path.posix.join(sourceMap.sourceRoot, source)
			: source,
	)
	return { ...sourceMap, sourceRoot: '', sources: flattenedSources }
}

/**
 * Give source maps served by a devkit-hosted session stable disk identities.
 * Pool builds retain their relative `sources`; this runs only after an opted-in
 * worker build prepares its artifacts for one local project.
 */
export async function normalizeHostedSourceMaps(opts: HostedSourceMapsOptions): Promise<void> {
	const outputDir = path.resolve(opts.outputDir)
	const publishedRoot = path.resolve(outputDir, opts.appId)
	if (!isContained(outputDir, publishedRoot)) {
		throw new Error('[devkit] hosted source map appId escapes outputDir')
	}
	const artifactRoot = opts.artifactRoot ? path.resolve(opts.artifactRoot) : publishedRoot
	const [publishedInfo, projectRoot] = await Promise.all([lstat(artifactRoot), realpath(opts.projectRoot)])
	if (!publishedInfo.isDirectory() || publishedInfo.isSymbolicLink()) {
		throw new Error(`[devkit] hosted source map output is not a directory: ${publishedRoot}`)
	}

	const maps = await collectRegularMaps(artifactRoot)
	const prepared: PreparedMap[] = []
	for (const mapPath of maps) {
		let parsed: unknown
		try {
			parsed = JSON.parse(await readFile(mapPath, 'utf8'))
		}
		catch (error) {
			throw new Error(`[devkit] hosted source map cannot be read: ${mapPath}`, { cause: error })
		}
		let normalized: unknown
		try {
			normalized = await canonicalizeMap(parsed, path.join(publishedRoot, path.relative(artifactRoot, mapPath)), projectRoot, path.resolve(opts.projectRoot))
		}
		catch (error) {
			throw new Error(`[devkit] hosted source map cannot be normalized: ${mapPath}`, { cause: error })
		}
		const contents = `${JSON.stringify(normalized)}\n`
		if (contents !== `${JSON.stringify(parsed)}\n`) prepared.push({ mapPath, contents })
	}

	const temporaryPaths: string[] = []
	try {
		for (const [index, map] of prepared.entries()) {
			const temporaryPath = path.join(path.dirname(map.mapPath), `.${path.basename(map.mapPath)}.hosted-${process.pid}-${index}`)
			await writeFile(temporaryPath, map.contents, 'utf8')
			temporaryPaths.push(temporaryPath)
		}
		for (let index = 0; index < prepared.length; index++) {
			await rename(temporaryPaths[index]!, prepared[index]!.mapPath)
		}
	}
	catch (error) {
		throw new Error('[devkit] hosted source map publication failed', { cause: error })
	}
	finally {
		await Promise.all(temporaryPaths.map(temporaryPath => rm(temporaryPath, { force: true }).catch(() => {})))
	}
}
