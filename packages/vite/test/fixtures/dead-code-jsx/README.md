<!-- human -->
# dead-code-jsx

`false && <Dead />` — Babel sees `<Dead />` lexically, so the visitor DOES tag it, even though it's runtime-unreachable. This is accepted behavior: the plugin is purely lexical; dead-code analysis would require a type-checker or bundler pass.
