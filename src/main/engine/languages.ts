// Per-language extraction rules for tree-sitter. Each pattern is compiled on its own, so one
// pattern that doesn't match a grammar version only loses that pattern, not the whole language.
//
// Captures:
//   @src   import/require/use target (string or dotted name)
//   @name  name of a definition, @def the definition node
//   @kind.<k> optional capture naming the symbol kind (function, class, …)

export type LangId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'c_sharp'
  | 'php'
  | 'ruby'
  | 'kotlin'
  | 'swift'
  | 'vue'
  | 'html'

export interface LangSpec {
  id: LangId
  label: string
  /** tree-sitter-wasms grammar name, or null for regex-only languages. */
  grammar: string | null
  imports: string[]
  defs: { query: string; kind: NonNullable<import('@shared/model').CodeSymbol['kind']> }[]
  /** Decide whether a definition is part of the public surface. */
  exported: (defText: string, name: string, parentType: string | null) => boolean
}

const JS_IMPORTS = [
  `(import_statement source: (string) @src)`,
  `(export_statement source: (string) @src)`,
  `(call_expression function: (identifier) @_f arguments: (arguments (string) @src) (#eq? @_f "require"))`,
  `(call_expression function: (import) arguments: (arguments (string) @src))`
]

const JS_DEFS: LangSpec['defs'] = [
  { query: `(function_declaration name: (identifier) @name) @def`, kind: 'function' },
  { query: `(generator_function_declaration name: (identifier) @name) @def`, kind: 'function' },
  { query: `(class_declaration name: (_) @name) @def`, kind: 'class' },
  { query: `(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (function)])) @def`, kind: 'function' },
  { query: `(method_definition name: (property_identifier) @name) @def`, kind: 'method' }
]

const TS_DEFS: LangSpec['defs'] = [
  ...JS_DEFS,
  { query: `(interface_declaration name: (type_identifier) @name) @def`, kind: 'interface' },
  { query: `(type_alias_declaration name: (type_identifier) @name) @def`, kind: 'type' },
  { query: `(abstract_class_declaration name: (type_identifier) @name) @def`, kind: 'class' }
]

const jsExported = (_t: string, _n: string, parentType: string | null): boolean => parentType === 'export_statement'

export const LANGS: Record<LangId, LangSpec> = {
  typescript: { id: 'typescript', label: 'TypeScript', grammar: 'typescript', imports: JS_IMPORTS, defs: TS_DEFS, exported: jsExported },
  tsx: { id: 'tsx', label: 'TypeScript', grammar: 'tsx', imports: JS_IMPORTS, defs: TS_DEFS, exported: jsExported },
  javascript: { id: 'javascript', label: 'JavaScript', grammar: 'javascript', imports: JS_IMPORTS, defs: JS_DEFS, exported: jsExported },
  vue: { id: 'vue', label: 'Vue', grammar: null, imports: [], defs: [], exported: () => true },
  html: { id: 'html', label: 'HTML', grammar: null, imports: [], defs: [], exported: () => false },
  python: {
    id: 'python',
    label: 'Python',
    grammar: 'python',
    imports: [
      `(import_statement name: (dotted_name) @src)`,
      `(import_statement name: (aliased_import name: (dotted_name) @src))`,
      `(import_from_statement module_name: (dotted_name) @src)`,
      `(import_from_statement module_name: (relative_import) @src)`
    ],
    defs: [
      { query: `(function_definition name: (identifier) @name) @def`, kind: 'function' },
      { query: `(class_definition name: (identifier) @name) @def`, kind: 'class' }
    ],
    exported: (_t, n, p) => !n.startsWith('_') && (p === 'module' || p === 'decorated_definition' || p === 'block')
  },
  go: {
    id: 'go',
    label: 'Go',
    grammar: 'go',
    imports: [`(import_spec path: (interpreted_string_literal) @src)`],
    defs: [
      { query: `(function_declaration name: (identifier) @name) @def`, kind: 'function' },
      { query: `(method_declaration name: (field_identifier) @name) @def`, kind: 'method' },
      { query: `(type_declaration (type_spec name: (type_identifier) @name)) @def`, kind: 'type' }
    ],
    exported: (_t, n) => /^[A-Z]/.test(n)
  },
  java: {
    id: 'java',
    label: 'Java',
    grammar: 'java',
    imports: [`(import_declaration (scoped_identifier) @src)`],
    defs: [
      { query: `(class_declaration name: (identifier) @name) @def`, kind: 'class' },
      { query: `(interface_declaration name: (identifier) @name) @def`, kind: 'interface' },
      { query: `(record_declaration name: (identifier) @name) @def`, kind: 'class' },
      { query: `(method_declaration name: (identifier) @name) @def`, kind: 'method' }
    ],
    exported: (t) => /^\s*(@\w+(\([^)]*\))?\s*)*public\b/.test(t)
  },
  kotlin: { id: 'kotlin', label: 'Kotlin', grammar: null, imports: [], defs: [], exported: (t) => !/^\s*(private|internal)\b/.test(t) },
  swift: { id: 'swift', label: 'Swift', grammar: null, imports: [], defs: [], exported: (t) => !/^\s*(private|fileprivate)\b/.test(t) },
  rust: {
    id: 'rust',
    label: 'Rust',
    grammar: 'rust',
    imports: [`(use_declaration argument: (_) @src)`, `(mod_item name: (identifier) @src)`],
    defs: [
      { query: `(function_item name: (identifier) @name) @def`, kind: 'function' },
      { query: `(struct_item name: (type_identifier) @name) @def`, kind: 'type' },
      { query: `(enum_item name: (type_identifier) @name) @def`, kind: 'type' },
      { query: `(trait_item name: (type_identifier) @name) @def`, kind: 'interface' }
    ],
    exported: (t) => /^\s*pub\b/.test(t)
  },
  c_sharp: {
    id: 'c_sharp',
    label: 'C#',
    grammar: 'c_sharp',
    imports: [`(using_directive (qualified_name) @src)`, `(using_directive (identifier) @src)`],
    defs: [
      { query: `(class_declaration name: (identifier) @name) @def`, kind: 'class' },
      { query: `(interface_declaration name: (identifier) @name) @def`, kind: 'interface' },
      { query: `(record_declaration name: (identifier) @name) @def`, kind: 'class' },
      { query: `(method_declaration name: (identifier) @name) @def`, kind: 'method' }
    ],
    exported: (t) => /^\s*(\[[^\]]*\]\s*)*public\b/.test(t)
  },
  php: {
    id: 'php',
    label: 'PHP',
    grammar: 'php',
    imports: [`(namespace_use_clause (qualified_name) @src)`, `(require_once_expression (string) @src)`, `(include_expression (string) @src)`],
    defs: [
      { query: `(function_definition name: (name) @name) @def`, kind: 'function' },
      { query: `(class_declaration name: (name) @name) @def`, kind: 'class' },
      { query: `(method_declaration name: (name) @name) @def`, kind: 'method' }
    ],
    exported: (t) => !/^\s*(private|protected)\b/.test(t)
  },
  ruby: {
    id: 'ruby',
    label: 'Ruby',
    grammar: 'ruby',
    imports: [`(call method: (identifier) @_m arguments: (argument_list (string (string_content) @src)) (#match? @_m "^require"))`],
    defs: [
      { query: `(method name: (identifier) @name) @def`, kind: 'method' },
      { query: `(class name: (constant) @name) @def`, kind: 'class' },
      { query: `(module name: (constant) @name) @def`, kind: 'class' }
    ],
    exported: (_t, n) => !n.startsWith('_')
  }
}

const EXT: Record<string, LangId> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'vue',
  '.svelte': 'vue',
  '.html': 'html',
  '.htm': 'html',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.rs': 'rust',
  '.cs': 'c_sharp',
  '.php': 'php',
  '.rb': 'ruby'
}

export function langOf(path: string): LangId | null {
  if (path.endsWith('.d.ts')) return null
  const i = path.lastIndexOf('.')
  return i < 0 ? null : (EXT[path.slice(i).toLowerCase()] ?? null)
}

/** Regex fallbacks for languages without a usable grammar (and for embedded <script> in .vue/.svelte). */
export const REGEX_DEFS: Partial<Record<LangId, { def: RegExp; imp: RegExp; kindOf: (kw: string) => import('@shared/model').CodeSymbol['kind'] }>> = {
  kotlin: {
    def: /^[ \t]*((?:public|internal|private|open|abstract|data|sealed|suspend|override|inline|enum)\s+)*(fun|class|interface|object)\s+(?:<[^>]*>\s*)?([A-Za-z_][\w.]*)/gm,
    imp: /^\s*import\s+([\w.]+)/gm,
    kindOf: (kw) => (kw === 'fun' ? 'function' : kw === 'interface' ? 'interface' : 'class')
  },
  swift: {
    def: /^[ \t]*((?:public|internal|private|fileprivate|open|final|static|override|@\w+)\s+)*(func|class|struct|protocol|enum|actor)\s+([A-Za-z_]\w*)/gm,
    imp: /^\s*import\s+(\w+)/gm,
    kindOf: (kw) => (kw === 'func' ? 'function' : kw === 'protocol' ? 'interface' : 'class')
  },
  html: {
    def: /^[ \t]*()(function|class)\s+([A-Za-z_$][\w$]*)/gm,
    imp: /<script[^>]*\ssrc=['"]([^'"]+)['"]/g,
    kindOf: (kw) => (kw === 'class' ? 'class' : 'function')
  },
  vue: {
    def: /^[ \t]*(export\s+)?(function|const|class)\s+([A-Za-z_$][\w$]*)/gm,
    imp: /(?:import\s[^'"]*?from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g,
    kindOf: (kw) => (kw === 'class' ? 'class' : 'function')
  }
}
