import type { LayoutNode, SizeConstraint } from 'electron-deck/layout'

/** Read the current constraint at a split site without assuming it is the root. */
export function constraintAt(
  root: LayoutNode,
  site: { splitId: string; childIndex: number },
): SizeConstraint | null {
  function find(node: LayoutNode): SizeConstraint | null {
    if (node.kind === 'tabs') return null
    if (node.id === site.splitId) return node.constraints?.[site.childIndex] ?? null
    for (const child of node.children) {
      const hit = find(child)
      if (hit !== null) return hit
    }
    return null
  }
  return find(root)
}

/** Update only the device floor; a user-selected panel preference belongs to the
 * same child and must survive project/device reconfiguration. */
export function withSimulatorFloor(
  current: SizeConstraint | null,
  minPx: number,
): SizeConstraint {
  return {
    minPx,
    ...(current?.minPx != null && current.preferredPx != null ? { preferredPx: current.preferredPx } : {}),
  }
}

/** The min-px floor of the constraint at a located split/child site, or null. */
export function constraintMinPxAt(
  root: LayoutNode,
  site: { splitId: string; childIndex: number },
): number | null {
  return constraintAt(root, site)?.minPx ?? null
}

/**
 * Locate the fixed-px constraint that pins the simulator's width. A child may
 * be a nested split after a dock operation, so matching its subtree keeps the
 * live re-pin attached to the simulator instead of a positional assumption.
 */
export function findSimulatorConstraintSite(
  node: LayoutNode,
): { splitId: string; childIndex: number } | null {
  if (node.kind === 'tabs') return null
  for (let index = 0; index < node.children.length; index++) {
    const child = node.children[index]!
    if ((node.constraints?.[index] ?? null) !== null && subtreeHasSimulator(child)) {
      return { splitId: node.id, childIndex: index }
    }
    const hit = findSimulatorConstraintSite(child)
    if (hit) return hit
  }
  return null
}

function subtreeHasSimulator(node: LayoutNode): boolean {
  if (node.kind === 'tabs') return node.panels.includes('simulator')
  return node.children.some(subtreeHasSimulator)
}
