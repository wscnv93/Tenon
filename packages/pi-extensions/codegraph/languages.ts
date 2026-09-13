/**
 * Language table for the code index: file extension → grammar wasm + queries.
 *
 * Query shapes were verified against tree-sitter-wasms 0.1.13 grammars with
 * web-tree-sitter 0.24.7 (the 0.25+ ABI is incompatible with these grammars).
 */

export interface LanguageDef {
  id: string;
  wasm: string;
  /** Symbol kinds: kind id → query capturing @name. */
  symbols: Array<[string, string]>;
  /** Call shapes capturing @callee (plain name) and @member (method name). */
  calls: string[];
}

export const LANGUAGES: Record<string, LanguageDef> = {
  typescript: {
    id: "typescript",
    wasm: "tree-sitter-typescript.wasm",
    symbols: [
      ["function", "(function_declaration name: (identifier) @name) @defn"],
      ["method", "(method_definition name: (property_identifier) @name) @defn"],
      ["class", "(class_declaration name: (type_identifier) @name) @defn"],
      ["interface", "(interface_declaration name: (type_identifier) @name) @defn"],
      ["type", "(type_alias_declaration name: (type_identifier) @name) @defn"],
      ["enum", "(enum_declaration name: (identifier) @name) @defn"],
      ["const", "(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @defn"],
    ],
    calls: [
      "(call_expression function: (identifier) @callee)",
      "(call_expression function: (member_expression property: (property_identifier) @member))",
      "(new_expression constructor: (identifier) @callee)",
    ],
  },
  tsx: {
    id: "tsx",
    wasm: "tree-sitter-tsx.wasm",
    symbols: [
      ["function", "(function_declaration name: (identifier) @name) @defn"],
      ["method", "(method_definition name: (property_identifier) @name) @defn"],
      ["class", "(class_declaration name: (type_identifier) @name) @defn"],
      ["interface", "(interface_declaration name: (type_identifier) @name) @defn"],
      ["type", "(type_alias_declaration name: (type_identifier) @name) @defn"],
      ["const", "(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @defn"],
    ],
    calls: [
      "(call_expression function: (identifier) @callee)",
      "(call_expression function: (member_expression property: (property_identifier) @member))",
      "(new_expression constructor: (identifier) @callee)",
    ],
  },
  javascript: {
    id: "javascript",
    wasm: "tree-sitter-javascript.wasm",
    symbols: [
      ["function", "(function_declaration name: (identifier) @name) @defn"],
      ["method", "(method_definition name: (property_identifier) @name) @defn"],
      ["class", "(class_declaration name: (identifier) @name) @defn"],
      ["const", "(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @defn"],
    ],
    calls: [
      "(call_expression function: (identifier) @callee)",
      "(call_expression function: (member_expression property: (property_identifier) @member))",
      "(new_expression constructor: (identifier) @callee)",
    ],
  },
  python: {
    id: "python",
    wasm: "tree-sitter-python.wasm",
    symbols: [
      ["function", "(function_definition name: (identifier) @name) @defn"],
      ["class", "(class_definition name: (identifier) @name) @defn"],
    ],
    calls: [
      "(call function: (identifier) @callee)",
      "(call function: (attribute attribute: (identifier) @member))",
    ],
  },
  go: {
    id: "go",
    wasm: "tree-sitter-go.wasm",
    symbols: [
      ["function", "(function_declaration name: (identifier) @name) @defn"],
      ["method", "(method_declaration name: (field_identifier) @name) @defn"],
      ["type", "(type_declaration (type_spec name: (type_identifier) @name)) @defn"],
    ],
    calls: [
      "(call_expression function: (identifier) @callee)",
      "(call_expression function: (selector_expression field: (field_identifier) @member))",
    ],
  },
  rust: {
    id: "rust",
    wasm: "tree-sitter-rust.wasm",
    symbols: [
      ["function", "(function_item name: (identifier) @name) @defn"],
      ["method", "(function_item name: (identifier) @name) @defn"],
      ["struct", "(struct_item name: (type_identifier) @name) @defn"],
      ["enum", "(enum_item name: (type_identifier) @name) @defn"],
      ["trait", "(trait_item name: (type_identifier) @name) @defn"],
      ["impl", "(impl_item type: (type_identifier) @name) @defn"],
    ],
    calls: [
      "(call_expression function: (identifier) @callee)",
      "(call_expression function: (field_expression field: (field_identifier) @member))",
      "(call_expression function: (scoped_expression name: (identifier) @member))",
    ],
  },
};

export const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};
