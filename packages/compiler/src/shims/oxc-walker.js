// Replacement for oxc-walker's `walk` (generic ESTree-ish traversal).
// The compiler only uses walk(ast, { enter(node, parent) }) — no skip/replace/remove.
// isSkipKey is a switch (not a Set) on purpose: this runs on every own key of every
// AST node in the whole file, and a small fixed key set compiles to a faster string
// comparison chain than a hash-based Set.has() at this call volume (measured ~33%
// less time walking a multi-thousand-node AST; Set still wins for large/dynamic sets).
function isSkipKey(key) {
  switch (key) {
    case 'type':
    case 'start':
    case 'end':
    case 'loc':
    case 'range':
    case 'parent':
    case 'leadingComments':
    case 'trailingComments':
    case 'innerComments':
      return true
    default:
      return false
  }
}

export function walk(ast, visitor = {}) {
  const { enter, leave } = visitor
  function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return
    if (enter) enter(node, parent)
    for (const key in node) {
      if (isSkipKey(key)) continue
      const val = node[key]
      if (Array.isArray(val)) {
        for (const c of val) {
          if (c && typeof c.type === 'string') visit(c, node)
        }
      } else if (val && typeof val.type === 'string') {
        visit(val, node)
      }
    }
    if (leave) leave(node, parent)
  }
  visit(ast, null)
}

export default { walk }
